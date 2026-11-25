import fs from 'node:fs';
import { createSubmission, currentEobFile, getClaim, getSettings, listMembers, submissionsForClaim, updateSubmission } from '../db/repo.js';
import { launchPortal, step, type PortalSession } from '../portals/shared/browser.js';
import { summitConfig as cfg } from '../portals/summit/config.js';
import { ensureSummitLoggedIn, summitUrl } from '../portals/summit/session.js';
import { draftExists, prefillClaimForm, saveAsDraft, waitForUserSubmit, type PrefillPayload } from '../portals/summit/submit.js';
import { buildClaimsView } from '../services/claimsView.js';
import { registerBridgePage } from '../dev/pageBridge.js';
import { isoToUs, nowIso } from '../util/dates.js';
import { centsToPlain, formatCents } from '../util/money.js';
import type { JobContext } from './runner.js';
import type { Benefit } from '../types.js';

export interface PrefillPlan {
  claim_number: string;
  benefit: Benefit;
  payload: PrefillPayload;
  amount_cents: number;
  expected_cents: number;
  warnings: string[];
}

const BENEFIT_WORD: Record<Benefit, string> = { deductible: 'deductible', copay: 'copay' };

/** Work out exactly what will be typed into Summit for one benefit of one claim. Shared by the confirm modal and the job. */
export function planPrefill(claimNumber: string, benefit: Benefit): PrefillPlan {
  const claim = getClaim(claimNumber);
  if (!claim) throw new Error(`Unknown claim ${claimNumber}`);
  const settings = getSettings();
  const member = listMembers().find((m) => m.id === claim.member_id);
  const view = buildClaimsView();
  const row = view.rows.find((r) => r.claim_number === claimNumber);
  if (!row) throw new Error(`Claim ${claimNumber} not in view`);
  const eob = currentEobFile(claimNumber);
  const warnings: string[] = [];
  const el = row.eligibility;

  if (!eob || !fs.existsSync(eob.file_path)) throw new Error('No claim document on disk for this claim. Run "Fetch claims" first.');
  if (!member) throw new Error('This claim is not linked to a member.');

  const amount = benefit === 'deductible' ? claim.deductible_cents : claim.copay_cents;
  if (amount <= 0) throw new Error(`This EOB has no ${BENEFIT_WORD[benefit]} amount to submit.`);
  const expected = benefit === 'deductible' ? el.deductible_reimb_cents : el.copay_reimb_cents;

  // Claimant: the saved Summit id, else a unique name match, else leave it to the user.
  let claimantValue = member.summit_claimant_label ?? '';
  let claimantLabel = settings.summit_claimants.find((c) => c.value === claimantValue)?.label ?? '';
  if (!claimantValue) {
    const byName = settings.summit_claimants.filter((c) => c.label.trim().toLowerCase() === member.display_name.trim().toLowerCase());
    if (byName.length === 1) {
      claimantValue = byName[0].value;
      claimantLabel = byName[0].label;
    } else if (byName.length > 1) {
      warnings.push(`Summit lists ${byName.length} claimants named "${member.display_name}"; pick the right one in Settings → Members, or in the form.`);
    } else {
      warnings.push(`No Summit claimant chosen for ${member.display_name}; pick it in Settings → Members, or in the form.`);
    }
  }
  if (el.status === 'not_eligible') warnings.push(`This claim is marked NOT eligible: ${el.reasons.join('; ')}`);
  if (el.status === 'needs_review') warnings.push(`Needs review: ${el.reasons.join('; ')}`);
  if (benefit === 'deductible' && !el.submit_deductible && el.status !== 'not_eligible') warnings.push('The HRA deductible benefit for this year is already used up.');
  if (benefit === 'copay' && !el.submit_copay && el.status !== 'not_eligible') warnings.push('The copay benefit for this year is already used up.');

  const b = cfg.benefits[benefit];
  let codeValue = b.defaultCodeValue;
  let codeLabel = b.defaultCodeLabel;
  // Service codes don't change what the MERP pays (the category picks the account), so keep them generic:
  // "Medical Service" for deductible claims, "copay% reimbursement" for copays, "RX/Pharmacy" for prescriptions.
  if (claim.claim_type === 'rx') {
    codeValue = cfg.rxCode.value;
    codeLabel = cfg.rxCode.label;
  }

  const notes = [
    `IBX claim #${claim.claim_number}`,
    `${BENEFIT_WORD[benefit]} ${formatCents(amount)} per EOB`,
    `expected HRA reimbursement ${formatCents(expected)}`,
  ].join('; ');

  const payload: PrefillPayload = {
    benefit,
    claimant_value: claimantValue,
    claimant_label: claimantLabel || member.display_name,
    service_start_us: isoToUs(claim.service_start),
    service_end_us: isoToUs(claim.service_end),
    amount_plain: centsToPlain(amount),
    provider: (claim.provider_name ?? '').slice(0, 100),
    category_value: b.categoryValue,
    category_label: b.categoryLabel,
    code_value: codeValue,
    code_label: codeLabel,
    description: `${claim.provider_name ? claim.provider_name + ' - ' : ''}${claim.claim_type === 'rx' ? 'prescription ' : ''}${BENEFIT_WORD[benefit]} ${isoToUs(claim.service_start)} (IBX #${claim.claim_number})`.slice(0, 200),
    notes,
    pdf_path: eob.file_path,
  };
  return { claim_number: claimNumber, benefit, payload, amount_cents: amount, expected_cents: expected, warnings };
}

export async function prefillJob(job: JobContext): Promise<string> {
  const { claim_number, benefit, force, finish_later } = (job.payload ?? {}) as { claim_number: string; benefit: Benefit; force?: boolean; finish_later?: boolean };
  const prior = submissionsForClaim(claim_number).filter((s) => s.benefit === benefit && s.status !== 'cancelled');
  if (prior.length && !force) {
    throw new Error(`The ${BENEFIT_WORD[benefit]} for claim ${claim_number} already has a submission (${prior[prior.length - 1].status}).`);
  }
  const plan = planPrefill(claim_number, benefit);
  for (const w of plan.warnings) job.log(`Note: ${w}`);

  const submission = createSubmission({
    claim_number,
    benefit,
    submitted_via: 'app',
    amount_cents: plan.amount_cents,
    claimant_label: plan.payload.claimant_value || plan.payload.claimant_label,
    description: plan.payload.description,
    notes: plan.payload.notes,
    status: 'unconfirmed',
    job_run_id: job.id,
  });

  let session: PortalSession | null = null;
  let ok = false;
  try {
    session = await launchPortal('summit', job);
    const page = session.page;
    registerBridgePage('summit', page); // dev bridge only; its routes are not in the packaged app
    await ensureSummitLoggedIn(page, job);

    if (finish_later) {
      // Draft mode: fill the form and click "Finish Later". Nothing is submitted; the claim waits in Summit's
      // "Unfinished Claims" list (as an Unconfirmed row here) until the user opens it there and submits it.
      const what = `${BENEFIT_WORD[benefit]} claim for ${formatCents(plan.amount_cents)}`;
      const already = await step(job, page, 'Check for an existing draft', async () => {
        await page.goto(summitUrl(cfg.paths.claimForm), { waitUntil: 'domcontentloaded' });
        await page.locator(cfg.form.submitButton).first().waitFor({ state: 'visible', timeout: 30_000 });
        await page.waitForTimeout(2500);
        return draftExists(page, plan.payload.description);
      });
      if (!already) {
        await prefillClaimForm(page, job, plan.payload);
        await saveAsDraft(page, job, plan.payload.description);
      }
      ok = true;
      return already
        ? `Summit already has an unfinished ${what}; left it as it is.`
        : `Saved the ${what} as a draft in Summit (Unfinished Claims). Open it there, tick the terms box and click Submit Claim.`;
    }

    await prefillClaimForm(page, job, plan.payload);
    job.waitingForUser(`The ${BENEFIT_WORD[benefit]} claim is filled in. Check it in the browser window, then click Submit Claim yourself. This app never clicks Submit.`);

    const result = await waitForUserSubmit(page, job, 15 * 60_000);
    ok = true;
    if (result.outcome === 'submitted') {
      updateSubmission(submission.id, { status: 'submitted', summit_claim_id: result.summitId, submitted_at: nowIso(), status_checked_at: nowIso() });
      job.resume();
      return `Submitted ${BENEFIT_WORD[benefit]} claim to Summit${result.summitId ? ` (Summit #${result.summitId})` : ''} for ${formatCents(plan.amount_cents)}`;
    }
    job.resume();
    const why = result.outcome === 'closed' ? 'the browser window was closed' : 'no confirmation was seen within 15 minutes';
    return `Form was filled but ${why}. If you did submit it, click "I submitted it" on the claim row; otherwise click "I cancelled".`;
  } catch (err) {
    updateSubmission(submission.id, { status: 'cancelled' });
    throw err;
  } finally {
    await session?.finish(ok);
  }
}
