import fs from 'node:fs';
import path from 'node:path';
import {
  createSubmission,
  getSettings,
  linkSummitActivity,
  listClaims,
  listMembers,
  listSubmissions,
  listSummitActivity,
  setSettings,
  updateMember,
  updateSubmission,
  upsertSummitActivity,
} from '../db/repo.js';
import { launchPortal, sleep, step } from '../portals/shared/browser.js';
import { scrapeActivity, summitConfig as cfg } from '../portals/summit/config.js';
import { ensureSummitLoggedIn, summitUrl } from '../portals/summit/session.js';
import { readClaimantOptions } from '../portals/summit/submit.js';
import { nowIso } from '../util/dates.js';
import { parseMoney } from '../util/money.js';
import { paths } from '../util/paths.js';
import type { JobContext } from './runner.js';
import type { Benefit, Member, SubmissionStatus, SummitActivity, SummitClaimant } from '../types.js';

export function mapSummitStatus(text: string | null): SubmissionStatus {
  const t = (text ?? '').toLowerCase();
  if (/paid|reimbursed|check|ach|deposit/.test(t)) return 'paid';
  if (/approved|processed/.test(t)) return 'approved';
  if (/denied|rejected/.test(t)) return 'denied';
  if (/pending|received|review|submitted|in process/.test(t)) return 'pending';
  return 'unknown';
}

function rawOf(row: SummitActivity): Record<string, string> {
  try {
    return JSON.parse(row.raw_json) as Record<string, string>;
  } catch {
    return {};
  }
}

/** "Example, Sam" -> "sam example" so it can be compared with IBX's member names. */
function normalizeName(s: string | null | undefined): string {
  const t = (s ?? '').trim().toLowerCase();
  if (t.includes(',')) {
    const [last, first] = t.split(',').map((x) => x.trim());
    return `${first} ${last}`.replace(/\s+/g, ' ');
  }
  return t.replace(/\s+/g, ' ');
}

/** Try to attach each Summit activity row to one of our IBX claims. Pure DB work; safe to re-run. */
export function matchActivity(log: (l: string) => void): { matched: number; unmatched: number } {
  const claims = listClaims();
  const members = listMembers();
  const submissions = listSubmissions();
  let matched = 0;
  let unmatched = 0;

  for (const row of listSummitActivity()) {
    if (row.matched_claim_number && row.match_method === 'manual') {
      matched += 1;
      continue;
    }
    const raw = rawOf(row);
    const benefit = cfg.benefitOfCategory(raw['Service Category'] ?? null);
    let claimNumber: string | null = null;
    let method: string | null = null;

    // 1. A submission we made already carries the Summit claim number.
    if (row.summit_claim_id) {
      const s = submissions.find((x) => x.summit_claim_id === row.summit_claim_id);
      if (s) {
        claimNumber = s.claim_number;
        method = 'id';
      }
    }
    // 2. The IBX claim number appears anywhere in the row (we write it into Notes/Description).
    if (!claimNumber) {
      const hit = claims.find((c) => c.claim_number.length >= 6 && row.raw_json.includes(c.claim_number));
      if (hit) {
        claimNumber = hit.claim_number;
        method = 'notes';
      }
    }
    // 3. Same person, same service date, amount equals the matching figure on the EOB.
    if (!claimNumber && row.service_date) {
      const who = normalizeName(row.claimant_label);
      const memberIds = members.filter((m) => who && (normalizeName(m.display_name) === who || m.summit_claimant_label === row.claimant_label)).map((m) => m.id);
      const candidates = claims.filter((c) => {
        if (c.service_start !== row.service_date) return false;
        if (memberIds.length && !memberIds.includes(c.member_id ?? -1)) return false;
        if (row.amount_cents === null) return true;
        if (benefit === 'copay') return c.copay_cents === row.amount_cents;
        if (benefit === 'deductible') return c.deductible_cents === row.amount_cents;
        return [c.deductible_cents, c.copay_cents, c.deductible_cents + c.copay_cents].includes(row.amount_cents);
      });
      if (candidates.length === 1) {
        claimNumber = candidates[0].claim_number;
        method = 'heuristic';
      }
    }

    if (claimNumber) {
      matched += 1;
      if (row.matched_claim_number !== claimNumber) linkSummitActivity(row.id, claimNumber, method);
      syncSubmissionFromActivity({ ...row, matched_claim_number: claimNumber }, log);
    } else {
      unmatched += 1;
    }
  }
  return { matched, unmatched };
}

/** Make sure the matched claim has a submission row (for the right benefit) reflecting what Summit shows. */
export function syncSubmissionFromActivity(row: SummitActivity, log: (l: string) => void): void {
  const claimNumber = row.matched_claim_number!;
  const raw = rawOf(row);
  const benefit: Benefit = cfg.benefitOfCategory(raw['Service Category'] ?? null) ?? 'deductible';
  const status = mapSummitStatus(row.status);
  const subs = listSubmissions().filter((s) => s.claim_number === claimNumber && s.benefit === benefit && s.status !== 'cancelled');
  const existing = subs.find((s) => s.summit_claim_id && s.summit_claim_id === row.summit_claim_id) ?? subs.at(-1);
  const approved = raw['Approved Amount'] ? parseMoney(raw['Approved Amount']) : null;
  const paymentMethod = raw['Payment Method'] ?? null;
  if (existing) {
    updateSubmission(existing.id, {
      status: status === 'unknown' ? existing.status : status,
      summit_claim_id: existing.summit_claim_id ?? row.summit_claim_id,
      submitted_at: existing.submitted_at ?? row.posted_date ?? nowIso(),
      status_checked_at: nowIso(),
      approved_cents: approved,
      payment_method: paymentMethod,
      amount_cents: row.amount_cents ?? existing.amount_cents,
    });
  } else {
    createSubmission({
      claim_number: claimNumber,
      benefit,
      submitted_via: 'manual',
      amount_cents: row.amount_cents ?? 0,
      approved_cents: approved,
      payment_method: paymentMethod,
      claimant_label: row.claimant_label,
      status: status === 'unknown' ? 'pending' : status,
      summit_claim_id: row.summit_claim_id,
      submitted_at: row.posted_date ?? nowIso(),
    });
    log(`Recorded a ${benefit} submission for claim ${claimNumber} found in Summit (${row.status ?? 'status unknown'})`);
  }
}

/**
 * Pair IBX members with Summit claimants without asking the user. Unique names match directly; when two
 * claimants share a name (a child named after a parent), Summit lists the employee first, then spouse,
 * then dependents, so the lower id goes to the earlier relationship.
 */
export function autoMapClaimants(claimants: SummitClaimant[], members: Member[]): string[] {
  const log: string[] = [];
  const order: Record<string, number> = { self: 0, spouse: 1, child: 2, unknown: 3 };
  const byName = new Map<string, SummitClaimant[]>();
  for (const c of claimants) {
    const k = normalizeName(c.label);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(c);
  }
  for (const [name, options] of byName) {
    const matching = members
      .filter((m) => normalizeName(m.display_name) === name)
      .sort((a, b) => (order[a.relationship] ?? 3) - (order[b.relationship] ?? 3));
    const sorted = [...options].sort((a, b) => Number(a.value) - Number(b.value));
    matching.forEach((m, i) => {
      const pick = sorted[i];
      if (!pick) return;
      if (m.summit_claimant_label !== pick.value) {
        updateMember(m.id, { summit_claimant_label: pick.value });
        log.push(`Matched ${m.display_name} (${m.relationship}) to Summit claimant ${pick.label} (${pick.value})`);
      }
    });
  }
  return log;
}

export async function syncSummitJob(job: JobContext): Promise<string> {
  const session = await launchPortal('summit', job);
  let ok = false;
  try {
    // Keep a copy of the raw transactions JSON for debugging; the table text is what we parse.
    session.page.on('response', async (res) => {
      if (!cfg.api.transactions.test(res.url()) || res.request().method() !== 'GET') return;
      try {
        const body = await res.text();
        fs.mkdirSync(path.join(paths.discovery, 'summit'), { recursive: true });
        fs.writeFileSync(path.join(paths.discovery, 'summit', 'GetTransactions.json'), body);
      } catch {
        /* ignore */
      }
    });

    await ensureSummitLoggedIn(session.page, job);

    await step(job, session.page, 'Detect plan option from the account names', async () => {
      const text = await session.page.locator('main').innerText({ timeout: 10_000 }).catch(() => '');
      const plan = cfg.planOptionFromText(text);
      const current = getSettings();
      if (!plan) {
        job.log('Could not tell the plan option from the Summit home page');
      } else if (current.plan_source === 'manual' && current.plan_option) {
        job.log(`Summit says ${plan}; keeping your manual choice of ${current.plan_option}`);
      } else if (current.plan_option !== plan || current.plan_source !== 'summit') {
        setSettings({ plan_option: plan, plan_source: 'summit' });
        job.log(`Plan option detected from Summit: ${plan === 'silver' ? 'Silver Secure $4,750' : 'Gold Classic $2,500'}`);
      }
    });

    await step(job, session.page, 'Open transactions', async () => {
      await session.page.goto(summitUrl(cfg.paths.activity), { waitUntil: 'domcontentloaded' });
      await sleep(3000);
    });
    const rows = await step(job, session.page, 'Read transactions', () => scrapeActivity(session.page, job.log));
    job.log(`Summit shows ${rows.length} transactions`);
    for (const r of rows) upsertSummitActivity(r);
    const m = matchActivity(job.log);

    await step(job, session.page, 'Read claimant list from the claim form', async () => {
      await session.page.goto(summitUrl(cfg.paths.claimForm), { waitUntil: 'domcontentloaded' });
      await session.page.locator(cfg.form.submitButton).first().waitFor({ state: 'visible', timeout: 30_000 });
      const claimants = await readClaimantOptions(session.page);
      if (claimants.length) {
        setSettings({ summit_claimants: claimants });
        job.log(`Claimants in Summit: ${claimants.map((c) => `${c.label} (${c.value})`).join(', ')}`);
        for (const line of autoMapClaimants(claimants, listMembers())) job.log(line);
      }
      await session.page.goto(summitUrl(cfg.paths.home), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    });

    ok = true;
    setSettings({ last_summit_sync_at: new Date().toISOString(), last_summit_sync_transactions: rows.length });
    return `${rows.length} Summit transactions read; ${m.matched} matched to IBX claims, ${m.unmatched} need manual linking`;
  } finally {
    await session.finish(ok);
  }
}
