/**
 * Import IBX Explanation of Benefits PDFs that were downloaded by hand, instead of fetching them from the portal.
 * Used by the Setup tab ("Import EOB PDFs") and by scripts/import-eobs.ts.
 *
 * The PDFs are read with the bundled pdf.js (unpdf), so nothing has to be installed. One IBX statement PDF can
 * list several claims, and the same statement is often saved once per claim, so claims are de-duplicated by the
 * claim number printed inside the PDF.
 * Pharmacy claims have no EOB and are not covered here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDocumentProxy } from 'unpdf';
import { evaluate, type EngineOutput } from '../eligibility/engine.js';
import { planOptionFromName, titleCase } from '../portals/ibx/config.js';
import { toIsoDate } from '../util/dates.js';
import { sha256 } from '../util/hash.js';
import { formatCents, parseMoney } from '../util/money.js';
import { paths, safeName } from '../util/paths.js';
import type { CoverageTier, NetworkStatus, NormalizedClaim, PlanOption } from '../types.js';

export interface ParsedClaim {
  claim: NormalizedClaim;
  not_covered_cents: number;
  statement_date: string | null;
  plan_name: string | null;
  file: string;
  warnings: string[];
}

const MONEY = /\(?-?\$[\d,]+\.\d{2}\)?/g;
const DATE = /\d{1,2}\/\d{1,2}\/\d{4}/g;
/** Columns of the "Claim Totals" row, left to right. */
const COLS = ['billed', 'discount', 'allowed', 'otherAdj', 'otherPlan', 'notCovered', 'copay', 'deductible', 'coinsurance', 'benefit'] as const;

/**
 * The text of a PDF laid out as the page shows it: one line per row of the page, columns left to right, with
 * wide gaps kept as several spaces (the parser splits "Network: ...   Provider: ..." on those).
 * pdf.js gives each run of text with its position; rows are rebuilt by grouping runs on the same baseline.
 */
export async function pdfText(file: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  const out: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const runs = (content.items as { str?: string; transform?: number[]; width?: number }[])
      .filter((i) => i.str?.trim() && i.transform)
      .map((i) => ({ text: i.str!, x: i.transform![4], y: i.transform![5], width: i.width ?? 0 }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: (typeof runs)[] = [];
    for (const run of runs) {
      const row = rows.at(-1);
      if (row && Math.abs(row[0].y - run.y) < 2.5) row.push(run);
      else rows.push([run]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let line = '';
      let end = -Infinity;
      for (const run of row) {
        const gap = run.x - end;
        if (line) line += gap > 6 ? '   ' : gap > 0.8 ? ' ' : '';
        line += run.text;
        end = run.x + run.width;
      }
      out.push(line);
    }
  }
  return out.join('\n');
}

/** "JANE Q PUBLIC" -> "Jane Public", the first-and-last form the IBX portal uses. */
function personName(raw: string): string {
  const parts = raw.trim().split(/\s+/);
  const kept = parts.filter((p, i) => i === 0 || i === parts.length - 1 || p.replace(/\./g, '').length > 1);
  return titleCase(kept.join(' '));
}

/** A guess from the member id suffix (00 subscriber, 01 spouse, others children); only used for labels. */
function relationshipGuess(memberId: string): string {
  const suffix = memberId.slice(-2);
  return suffix === '00' ? 'self' : suffix === '01' ? 'spouse' : 'child';
}

function networkOf(text: string): NetworkStatus {
  if (/^in\b/i.test(text)) return 'in';
  if (/^out\b/i.test(text)) return 'out';
  return 'unknown';
}

export function parseStatement(file: string, text: string): ParsedClaim[] {
  const lines = text.split(/\r?\n/);
  const statementDate = toIsoDate(text.match(/^\s*Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/m)?.[1]);
  const planName = text.match(/Group Name:\s*(.+?)\s*$/m)?.[1] ?? null;
  const starts = lines.flatMap((l, i) => (/Claim #:\s*\d+/.test(l) ? [i] : []));
  const out: ParsedClaim[] = [];

  starts.forEach((start, k) => {
    const block = lines.slice(start, starts[k + 1] ?? lines.length);
    const warnings: string[] = [];
    const head = block[0];
    const claimNumber = head.match(/Claim #:\s*(\d+)/)![1];
    const network = head.match(/Network:\s*(.+?)(?:\s{2,}|$)/)?.[1] ?? '';
    const provider = head.match(/Provider:\s*(.+?)\s*$/)?.[1] ?? '';
    const patientLine = block.find((l) => /Patient:/.test(l)) ?? '';
    const patient = patientLine.match(/Patient:\s*(.+?)(?:\s{2,}|$)/)?.[1] ?? '';
    const memberId = patientLine.match(/Member ID:\s*(\S+)/)?.[1] ?? '';

    const totalsAt = block.findIndex((l) => /Claim Totals/.test(l));
    if (totalsAt < 0) {
      warnings.push('no "Claim Totals" row found; amounts are zero');
    }
    const totalsMoney = totalsAt >= 0 ? (block[totalsAt].match(MONEY) ?? []) : [];
    if (totalsAt >= 0 && totalsMoney.length !== COLS.length) {
      warnings.push(`"Claim Totals" row has ${totalsMoney.length} amounts, expected ${COLS.length}`);
    }
    const t = Object.fromEntries(COLS.map((c, i) => [c, parseMoney(totalsMoney[i])])) as Record<(typeof COLS)[number], number>;

    // Service lines sit between the header and the totals row and start with the service date.
    const serviceLines = block.slice(1, totalsAt < 0 ? block.length : totalsAt).filter((l) => /^\s*\d{1,2}\/\d{1,2}\/\d{4}\b/.test(l));
    const dates = serviceLines.flatMap((l) => l.match(DATE) ?? []).map((d) => toIsoDate(d)!).sort();
    if (!dates.length) warnings.push('no service dates found');

    // Cross-check the totals row against the lines above it.
    const lineSums = COLS.map(() => 0);
    let linesOk = serviceLines.length > 0;
    for (const l of serviceLines) {
      const m = l.match(MONEY) ?? [];
      if (m.length !== COLS.length) {
        linesOk = false;
        break;
      }
      m.forEach((v, i) => (lineSums[i] += parseMoney(v)));
    }
    if (linesOk) {
      COLS.forEach((c, i) => {
        if (lineSums[i] !== t[c]) warnings.push(`${c}: lines add up to ${formatCents(lineSums[i])} but the totals row says ${formatCents(t[c])}`);
      });
    } else if (serviceLines.length) {
      warnings.push('could not cross-check service lines against the totals row');
    }

    const respText = block.find((l) => /Patient Responsibility:/.test(l))?.match(/Patient Responsibility:\s*(\(?-?\$[\d,]+\.\d{2}\)?)/)?.[1];
    const patientResp = respText === undefined ? t.copay + t.deductible + t.coinsurance + t.notCovered : parseMoney(respText);
    if (respText === undefined) warnings.push('no "Patient Responsibility" line found');
    else if (patientResp !== t.copay + t.deductible + t.coinsurance + t.notCovered) {
      warnings.push(`patient responsibility ${formatCents(patientResp)} is not copay + deductible + coinsurance + not covered`);
    }
    if (!memberId || !patient) warnings.push('patient name or member id missing');
    const net = networkOf(network);
    if (net === 'unknown') warnings.push(`network "${network}" not recognised`);

    out.push({
      claim: {
        claim_number: claimNumber,
        member_ibx_id: memberId,
        member_name: personName(patient),
        relationship: relationshipGuess(memberId),
        service_start: dates[0] ?? statementDate ?? '',
        service_end: dates.at(-1) ?? statementDate ?? '',
        provider_name: titleCase(provider) || null,
        provider_phone: null,
        claim_type: 'medical',
        network_status: net,
        claim_status: 'processed',
        processed_date: statementDate,
        billed_cents: t.billed,
        allowed_cents: t.allowed,
        deductible_cents: t.deductible,
        copay_cents: t.copay,
        coinsurance_cents: t.coinsurance,
        plan_paid_cents: t.benefit,
        patient_resp_cents: patientResp,
        raw: { source: 'eob-pdf', file: path.basename(file), statement_date: statementDate, totals: t, lines: serviceLines.map((l) => l.trim().replace(/\s+/g, ' ')) },
        eob_ref: null,
      },
      not_covered_cents: t.notCovered,
      statement_date: statementDate,
      plan_name: planName,
      file,
      warnings,
    });
  });
  return out;
}

/** Keep one copy of each claim: the newest statement wins, then the file named after the claim. */
export function dedupe(all: ParsedClaim[], notes: string[]): ParsedClaim[] {
  const byNumber = new Map<string, ParsedClaim[]>();
  for (const p of all) byNumber.set(p.claim.claim_number, [...(byNumber.get(p.claim.claim_number) ?? []), p]);
  const amounts = (p: ParsedClaim) => JSON.stringify((p.claim.raw as { totals: unknown }).totals);
  const out: ParsedClaim[] = [];
  for (const [n, copies] of byNumber) {
    const named = (p: ParsedClaim) => (path.basename(p.file).includes(n) ? 1 : 0);
    copies.sort((a, b) => (b.statement_date ?? '').localeCompare(a.statement_date ?? '') || named(b) - named(a) || a.file.localeCompare(b.file));
    const best = copies[0];
    if (new Set(copies.map(amounts)).size > 1) {
      notes.push(`Claim ${n} appears with different amounts in ${copies.length} statements; using the newest (${best.statement_date}, ${path.basename(best.file)})`);
    }
    out.push(best);
  }
  return out.sort((a, b) => a.claim.service_start.localeCompare(b.claim.service_start) || a.claim.claim_number.localeCompare(b.claim.claim_number));
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

export interface EobImport {
  folder: string;
  files: number;
  entries: number;
  claims: ParsedClaim[];
  notes: string[];
  plan_name: string | null;
  plan: PlanOption | null;
  tier: CoverageTier;
  year: number;
  people: NormalizedClaim[];
  engine: EngineOutput;
}

/** Parse every PDF in the folder. Reads only; nothing is stored. */
export async function readEobFolder(folder: string, year: number): Promise<EobImport> {
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f)).sort().map((f) => path.resolve(folder, f));
  if (!files.length) throw new Error(`No PDF files in ${folder}`);
  const notes: string[] = [];
  const all: ParsedClaim[] = [];
  for (const f of files) {
    try {
      const parsed = parseStatement(f, await pdfText(f));
      if (!parsed.length) notes.push(`${path.basename(f)}: no claims found in this PDF`);
      all.push(...parsed);
    } catch (err) {
      notes.push(`${path.basename(f)}: could not be read (${(err as Error).message.split('\n')[0]})`);
    }
  }
  const claims = dedupe(all, notes);
  const planNames = [...new Set(all.map((p) => p.plan_name).filter(Boolean))] as string[];
  if (planNames.length > 1) notes.push(`More than one plan name seen: ${planNames.join(' | ')}`);
  const plan = planOptionFromName(planNames[0] ?? null);
  const people = new Map(claims.map((p) => [p.claim.member_ibx_id, p.claim]));
  const tier: CoverageTier = people.size > 1 ? 'family' : 'single';

  // Same eligibility maths the dashboard will show, without touching the database.
  const memberIndex = new Map([...people.keys()].map((id, i) => [id, i + 1]));
  const engine = evaluate(
    claims.map((p) => ({ ...p.claim, member_id: memberIndex.get(p.claim.member_ibx_id) ?? null, user_override_qualifies: null })),
    { plan_option: plan, coverage_tier: tier, plan_year: year },
  );
  return { folder, files: files.length, entries: all.length, claims, notes, plan_name: planNames[0] ?? null, plan, tier, year, people: [...people.values()], engine };
}

/** Print what was parsed, one line (or a few) at a time. */
export function describeEobImport(r: EobImport, log: (line: string) => void): void {
  log(`${r.files} PDFs, ${r.entries} claim entries, ${r.claims.length} distinct claims`);
  log(`Plan: ${r.plan_name ?? 'unknown'} -> ${r.plan ?? 'UNKNOWN'}, ${r.tier} coverage, plan year ${r.year}`);
  log(`People: ${r.people.map((c) => `${c.member_name} (${c.relationship}, ${c.member_ibx_id})`).join(', ')}`);
  log(['Service   ', pad('Patient', 17), pad('Provider', 30), 'Net', '    Billed', '   Copay', ' Deductible', '  Coins', ' NotCov', ' You owe', ' HRA est', ' Status'].join(' '));
  for (const p of r.claims) {
    const c = p.claim;
    const el = r.engine.results.get(c.claim_number)!;
    const m = (v: number, w: number) => formatCents(v).padStart(w);
    log([c.service_start, pad(c.member_name, 17), pad(c.provider_name ?? '', 30), pad(c.network_status, 3), m(c.billed_cents, 10), m(c.copay_cents, 8), m(c.deductible_cents, 11), m(c.coinsurance_cents, 7), m(p.not_covered_cents, 7), m(c.patient_resp_cents, 8), m(el.expected_cents, 8), ` ${el.status}`].join(' '));
    log(`           #${c.claim_number}  ${path.basename(p.file)}${c.service_end !== c.service_start ? `  (through ${c.service_end})` : ''}`);
    for (const w of p.warnings) log(`           ! ${w}`);
    if (el.status === 'not_eligible' || el.status === 'needs_review') log(`           - ${el.reasons.join('; ')}`);
  }
  const sum = (f: (p: ParsedClaim) => number) => r.claims.reduce((a, p) => a + f(p), 0);
  const tt = r.engine.totals;
  log(`Totals: copay ${formatCents(sum((p) => p.claim.copay_cents))}, deductible ${formatCents(sum((p) => p.claim.deductible_cents))}, coinsurance ${formatCents(sum((p) => p.claim.coinsurance_cents))}, you owe ${formatCents(sum((p) => p.claim.patient_resp_cents))}`);
  log(`HRA estimate: copay benefit ${formatCents(tt.copay_reimb_cents)} of ${formatCents(tt.copay_cap_cents)}; deductible counted ${formatCents(tt.deductible_applied_cents)} against a ${formatCents(tt.threshold_cents)} threshold, HRA pays ${formatCents(tt.hra_deductible_paid_cents)} of ${formatCents(tt.cap_cents)}`);
  for (const n of r.notes) log(`Note: ${n}`);
}

/** Store the parsed claims and copy their PDFs into the data folder. Safe to repeat. */
export async function writeEobImport(r: EobImport): Promise<{ new: number; changed: number; unchanged: number; copied: number }> {
  const { currentEobFile, getSettings, recordEobFile, setSettings, upsertClaim, upsertMember } = await import('../db/repo.js');
  const counts = { new: 0, changed: 0, unchanged: 0, copied: 0 };
  for (const p of r.claims) {
    const c = p.claim;
    const member = upsertMember({ ibx_member_id: c.member_ibx_id, display_name: c.member_name, relationship: c.relationship });
    const { outcome, hash } = upsertClaim(c, member.id);
    counts[outcome] += 1;
    const buf = fs.readFileSync(p.file);
    const digest = sha256(buf);
    const existing = currentEobFile(c.claim_number);
    if (existing && existing.sha256 === digest && fs.existsSync(existing.file_path)) continue;
    const dir = path.join(paths.eobs, safeName(`${c.member_name} (${c.relationship})`));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${safeName(c.claim_number)}_${(c.processed_date ?? c.service_start).replace(/-/g, '')}.pdf`);
    fs.writeFileSync(dest, buf);
    recordEobFile({ claim_number: c.claim_number, file_path: dest, sha256: digest, source_hash_at_download: hash });
    counts.copied += 1;
  }
  const patch: Parameters<typeof setSettings>[0] = { last_ibx_fetch_at: new Date().toISOString(), last_ibx_fetch_claims: r.claims.length, last_ibx_fetch_pdfs: r.claims.length };
  if (getSettings().plan_source !== 'manual') {
    patch.coverage_tier = r.tier;
    if (r.plan) Object.assign(patch, { plan_option: r.plan, plan_source: 'ibx' });
  }
  setSettings(patch);
  return counts;
}
