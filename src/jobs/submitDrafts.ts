/**
 * Submit the claims waiting in Summit's "Unfinished Claims" list.
 *
 * Summit is the source of truth here, not this app's records: the user may have edited a draft, deleted one, or
 * added one by hand since the app saved them. So the job reads the list as it stands, opens each draft, checks
 * what the form actually holds, and submits that. A draft that points at an IBX claim (the "IBX #..." the app
 * writes into the description and notes) updates that claim's row; any other draft is still submitted and is
 * picked up by the next Sync Summit run.
 *
 * Payload: { dry_run?: boolean } lists the drafts and what would happen; { limit?: number } stops after that many.
 */
import { createSubmission, getClaim, getJobRun, listSubmissions, submissionsForClaim, updateSubmission } from '../db/repo.js';
import { registerBridgePage } from '../dev/pageBridge.js';
import { launchPortal, step, type PortalSession } from '../portals/shared/browser.js';
import { summitConfig as cfg } from '../portals/summit/config.js';
import { ensureSummitLoggedIn } from '../portals/summit/session.js';
import { listDrafts, openDraft, openDraftList, submitOpenDraft, type DraftForm, type DraftRow } from '../portals/summit/submit.js';
import { nowIso } from '../util/dates.js';
import { formatCents, parseMoney } from '../util/money.js';
import type { JobContext } from './runner.js';
import type { Benefit, Submission } from '../types.js';

const keyOf = (r: DraftRow) => [r.saved, r.start, r.end, r.description, r.amount].join('|');
const label = (r: DraftRow) => `${r.start} ${r.amount} "${r.description}"`;

/** The IBX claim a draft refers to, from the "IBX #123" / "IBX claim #123" the app writes into it. */
export function claimNumberIn(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(/IBX(?:\s+claim)?\s*#\s*(\d{6,})/i);
    if (m) return m[1];
  }
  return null;
}

export function benefitIn(category: string, description: string): Benefit | null {
  return cfg.benefitOfCategory(category) ?? (/\bdeductible\b/i.test(description) ? 'deductible' : /\bcopay\b/i.test(description) ? 'copay' : null);
}

function liveSubmission(claimNumber: string, benefit: Benefit): Submission | null {
  return submissionsForClaim(claimNumber).filter((s) => s.benefit === benefit && s.status !== 'cancelled').at(-1) ?? null;
}

/** Why this draft should not be submitted as it stands, or null when it is good to go. */
function problemWith(form: DraftForm): string | null {
  const missing = [
    !form.has_attachment && 'receipt/EOB attachment',
    !form.claimant && 'claimant',
    !form.start && 'service start',
    !form.end && 'service end',
    parseMoney(form.amount) <= 0 && 'amount',
    !form.provider && 'provider',
    !form.category && 'service category',
    !form.description && 'description',
  ].filter(Boolean);
  return missing.length ? `missing ${missing.join(', ')}` : null;
}

export async function submitDraftsJob(job: JobContext): Promise<string> {
  const { dry_run, limit } = (job.payload ?? {}) as { dry_run?: boolean; limit?: number };
  let session: PortalSession | null = null;
  let ok = false;
  const counts = { submitted: 0, skipped: 0 };
  try {
    session = await launchPortal('summit', job);
    const page = session.page;
    registerBridgePage('summit', page);
    await ensureSummitLoggedIn(page, job);

    const initial = await step(job, page, 'Read the Unfinished Claims list', async () => {
      await openDraftList(page);
      return listDrafts(page);
    });
    job.log(`Summit has ${initial.length} unfinished claim${initial.length === 1 ? '' : 's'}`);

    if (dry_run) {
      for (const r of initial) {
        const n = claimNumberIn(r.description);
        const benefit = benefitIn('', r.description);
        const sub = n && benefit && getClaim(n) ? liveSubmission(n, benefit) : null;
        const note = !n || !getClaim(n) ? 'not linked to an IBX claim here (added or edited by hand); would still be submitted'
          : sub && sub.status !== 'unconfirmed' ? `claim ${n} is already ${sub.status} in this app; would be SKIPPED`
          : `claim ${n}${sub && sub.amount_cents !== parseMoney(r.amount) ? ` (amount changed from ${formatCents(sub.amount_cents)})` : ''}; would be submitted`;
        job.log(`  ${label(r)} -> ${note}`);
      }
      for (const s of orphans(initial)) job.log(`  No draft in Summit any more for claim ${s.claim_number} (${s.benefit}, ${formatCents(s.amount_cents)}); a full run marks it cancelled`);
      ok = true;
      return `Preview only: ${initial.length} unfinished claims in Summit, nothing submitted`;
    }

    const done = new Set<string>();
    const max = limit && limit > 0 ? limit : Infinity;
    while (counts.submitted < max && !job.cancelled) {
      const rows = await listDrafts(page);
      const index = rows.findIndex((r) => !done.has(keyOf(r)));
      if (index < 0) break;
      const row = rows[index];
      done.add(keyOf(row));
      job.progress({ ...counts, of: initial.length });

      const outcome = await step(job, page, `Draft ${label(row)}`, async () => {
        const form = await openDraft(page, index, row);
        const problem = problemWith(form);
        if (problem) return `SKIPPED, ${problem}`;
        const n = claimNumberIn(form.description, form.notes);
        const benefit = benefitIn(form.category, form.description);
        const claim = n ? getClaim(n) : undefined;
        const sub = claim && benefit ? liveSubmission(claim.claim_number, benefit) : null;
        if (sub && sub.status !== 'unconfirmed') return `SKIPPED, the ${benefit} for claim ${n} is already ${sub.status}${sub.summit_claim_id ? ` (Summit #${sub.summit_claim_id})` : ''}; delete this draft in Summit if it is a duplicate`;

        const { summitId } = await submitOpenDraft(page, job);
        const amount = parseMoney(form.amount);
        const patch = { status: 'submitted' as const, summit_claim_id: summitId, submitted_at: nowIso(), status_checked_at: nowIso(), amount_cents: amount };
        if (sub) updateSubmission(sub.id, patch);
        else if (claim && benefit) {
          const created = createSubmission({ claim_number: claim.claim_number, benefit, submitted_via: 'app', amount_cents: amount, claimant_label: form.claimant, description: form.description, notes: form.notes, status: 'submitted', job_run_id: job.id });
          updateSubmission(created.id, patch);
        }
        counts.submitted += 1;
        return `submitted${summitId ? ` as Summit #${summitId}` : ''} for ${formatCents(amount)} (${form.claimant}${claim && benefit ? `, IBX claim ${n}` : ', not linked to an IBX claim; Sync Summit will list it'})`;
      });
      job.log(`  ${outcome}`);
      if (outcome.startsWith('SKIPPED')) counts.skipped += 1;
      await openDraftList(page); // fresh form and list for the next one
    }

    // Drafts the app saved that are gone from Summit were deleted there (or submitted by hand, which the next
    // Sync Summit run records). Only judged on a full run, against the list as it was at the start.
    let cancelled = 0;
    if (max === Infinity && !job.cancelled) {
      for (const s of orphans(initial)) {
        updateSubmission(s.id, { status: 'cancelled' });
        cancelled += 1;
        job.log(`No draft in Summit for claim ${s.claim_number} (${s.benefit}); marked cancelled here. If you submitted it by hand, Sync Summit will record it.`);
      }
    }
    ok = true;
    return `${counts.submitted} draft${counts.submitted === 1 ? '' : 's'} submitted to Summit, ${counts.skipped} skipped${cancelled ? `, ${cancelled} no longer in Summit` : ''}. Run Sync Summit to pick up their statuses.`;
  } finally {
    await session?.finish(ok);
  }
}

/** Unconfirmed rows this app created by saving a draft, for which Summit no longer lists a draft. */
function orphans(drafts: DraftRow[]): Submission[] {
  return listSubmissions().filter((s) => {
    if (s.status !== 'unconfirmed' || !s.job_run_id) return false;
    let savedAsDraft = false;
    try {
      savedAsDraft = Boolean(JSON.parse(getJobRun(s.job_run_id)?.payload_json ?? '{}').finish_later);
    } catch {
      /* not a draft job */
    }
    if (!savedAsDraft) return false;
    return !drafts.some((d) => d.description === s.description || (claimNumberIn(d.description) === s.claim_number && benefitIn('', d.description) === s.benefit));
  });
}
