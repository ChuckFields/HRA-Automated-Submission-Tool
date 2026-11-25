/**
 * Import IBX Explanation of Benefits PDFs that were downloaded by hand, instead of fetching them from the portal.
 *   npx tsx scripts/import-eobs.ts <folder>           dry run: parse and print, touch nothing
 *   npx tsx scripts/import-eobs.ts <folder> --write   store claims, copy the PDFs into the data folder
 *
 * Needs `pdftotext` (poppler) on the PATH. One IBX statement PDF can list several claims, and the same statement
 * is often saved once per claim, so claims are de-duplicated by the claim number printed inside the PDF.
 * Pharmacy claims have no EOB and are not covered here.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../src/eligibility/engine.js';
import { planOptionFromName, titleCase } from '../src/portals/ibx/config.js';
import { toIsoDate } from '../src/util/dates.js';
import { sha256 } from '../src/util/hash.js';
import { formatCents, parseMoney } from '../src/util/money.js';
import { paths, safeName } from '../src/util/paths.js';
import type { CoverageTier, NetworkStatus, NormalizedClaim, PlanOption } from '../src/types.js';

interface ParsedClaim {
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

function pdfText(file: string): string {
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
function dedupe(all: ParsedClaim[], notes: string[]): ParsedClaim[] {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const folder = args.find((a) => !a.startsWith('--'));
  if (!folder || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('Usage: npx tsx scripts/import-eobs.ts <folder of EOB PDFs> [--write]');
    process.exit(2);
  }
  const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f)).sort().map((f) => path.resolve(folder, f));
  const notes: string[] = [];
  const all: ParsedClaim[] = [];
  for (const f of files) {
    try {
      const parsed = parseStatement(f, pdfText(f));
      if (!parsed.length) notes.push(`${path.basename(f)}: no claims found in this PDF`);
      all.push(...parsed);
    } catch (err) {
      notes.push(`${path.basename(f)}: could not be read (${(err as Error).message.split('\n')[0]})`);
    }
  }
  const claims = dedupe(all, notes);

  const planNames = [...new Set(all.map((p) => p.plan_name).filter(Boolean))] as string[];
  const plan: PlanOption | null = planOptionFromName(planNames[0] ?? null);
  const people = new Map(claims.map((p) => [p.claim.member_ibx_id, p.claim]));
  const tier: CoverageTier = people.size > 1 ? 'family' : 'single';
  const year = Number(args.find((a) => a.startsWith('--year='))?.slice(7)) || 2026;
  if (planNames.length > 1) notes.push(`More than one plan name seen: ${planNames.join(' | ')}`);

  // Same eligibility maths the dashboard will show, without touching the database.
  const memberIndex = new Map([...people.keys()].map((id, i) => [id, i + 1]));
  const engine = evaluate(
    claims.map((p) => ({ ...p.claim, member_id: memberIndex.get(p.claim.member_ibx_id) ?? null, user_override_qualifies: null })),
    { plan_option: plan, coverage_tier: tier, plan_year: year },
  );

  console.log(`\n${files.length} PDFs, ${all.length} claim entries, ${claims.length} distinct claims`);
  console.log(`Plan: ${planNames[0] ?? 'unknown'} -> ${plan ?? 'UNKNOWN'}, ${tier} coverage, plan year ${year}`);
  console.log(`People: ${[...people.values()].map((c) => `${c.member_name} (${c.relationship}, ${c.member_ibx_id})`).join(', ')}\n`);
  console.log(['Service   ', pad('Patient', 17), pad('Provider', 30), 'Net', '    Billed', '   Copay', ' Deductible', '  Coins', ' NotCov', ' You owe', ' HRA est', ' Status'].join(' '));
  for (const p of claims) {
    const c = p.claim;
    const el = engine.results.get(c.claim_number)!;
    const m = (v: number, w: number) => formatCents(v).padStart(w);
    console.log(
      [c.service_start, pad(c.member_name, 17), pad(c.provider_name ?? '', 30), pad(c.network_status, 3), m(c.billed_cents, 10), m(c.copay_cents, 8), m(c.deductible_cents, 11), m(c.coinsurance_cents, 7), m(p.not_covered_cents, 7), m(c.patient_resp_cents, 8), m(el.expected_cents, 8), ` ${el.status}`].join(' '),
    );
    console.log(`           #${c.claim_number}  ${path.basename(p.file)}${c.service_end !== c.service_start ? `  (through ${c.service_end})` : ''}`);
    for (const w of p.warnings) console.log(`           ! ${w}`);
    if (el.status === 'not_eligible' || el.status === 'needs_review') console.log(`           - ${el.reasons.join('; ')}`);
  }
  const sum = (f: (p: ParsedClaim) => number) => claims.reduce((a, p) => a + f(p), 0);
  const tt = engine.totals;
  console.log(`\nTotals: copay ${formatCents(sum((p) => p.claim.copay_cents))}, deductible ${formatCents(sum((p) => p.claim.deductible_cents))}, coinsurance ${formatCents(sum((p) => p.claim.coinsurance_cents))}, you owe ${formatCents(sum((p) => p.claim.patient_resp_cents))}`);
  console.log(`HRA estimate: copay benefit ${formatCents(tt.copay_reimb_cents)} of ${formatCents(tt.copay_cap_cents)}; deductible counted ${formatCents(tt.deductible_applied_cents)} against a ${formatCents(tt.threshold_cents)} threshold, HRA pays ${formatCents(tt.hra_deductible_paid_cents)} of ${formatCents(tt.cap_cents)}`);
  if (notes.length) console.log(`\nNotes:\n${notes.map((n) => `  - ${n}`).join('\n')}`);

  if (!write) {
    console.log('\nDry run: nothing was written. Re-run with --write to import.');
    return;
  }

  const { currentEobFile, getSettings, recordEobFile, setSettings, upsertClaim, upsertMember } = await import('../src/db/repo.js');
  const counts = { new: 0, changed: 0, unchanged: 0, copied: 0 };
  for (const p of claims) {
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
  const patch: Parameters<typeof setSettings>[0] = { last_ibx_fetch_at: new Date().toISOString(), last_ibx_fetch_claims: claims.length, last_ibx_fetch_pdfs: claims.length };
  if (getSettings().plan_source !== 'manual') {
    patch.coverage_tier = tier;
    if (plan) Object.assign(patch, { plan_option: plan, plan_source: 'ibx' });
  }
  setSettings(patch);
  console.log(`\nImported into ${paths.data}: ${counts.new} new, ${counts.changed} changed, ${counts.unchanged} unchanged, ${counts.copied} PDFs copied.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
