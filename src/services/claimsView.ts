import { eobFileMap, getSettings, listClaims, listMembers, listSubmissions, listSummitActivity } from '../db/repo.js';
import { evaluate, type EligibilityResult, type EngineTotals } from '../eligibility/engine.js';
import { daysUntil, planYearBounds } from '../util/dates.js';
import type { Benefit, Claim, Member, Submission } from '../types.js';

export interface ClaimRow extends Claim {
  member_name: string;
  relationship: string;
  has_pdf: boolean;
  eligibility: EligibilityResult;
  /** Latest live (not cancelled) submission per benefit. */
  submissions: Record<Benefit, Submission | null>;
  changed_after_submission: boolean;
}

export interface ClaimsView {
  rows: ClaimRow[];
  totals: EngineTotals;
  members: Member[];
  deadline: { date: string; days_left: number };
  pending_expected_cents: number;
  /** What Alera has approved/paid so far, by benefit: 50% of approved copays, the HRA band for deductibles. */
  received_cents: number;
  received_copay_cents: number;
  received_deductible_cents: number;
  unmatched_activity: number;
}

export function latestSubmissions(subs: Submission[]): Record<Benefit, Submission | null> {
  const live = subs.filter((s) => s.status !== 'cancelled');
  const pick = (b: Benefit) => live.filter((s) => s.benefit === b).at(-1) ?? null;
  return { deductible: pick('deductible'), copay: pick('copay') };
}

export function buildClaimsView(): ClaimsView {
  const settings = getSettings();
  const claims = listClaims();
  const members = listMembers();
  const memberById = new Map(members.map((m) => [m.id, m]));
  const eobs = eobFileMap();
  const subsByClaim = new Map<string, Submission[]>();
  for (const s of listSubmissions()) {
    if (!subsByClaim.has(s.claim_number)) subsByClaim.set(s.claim_number, []);
    subsByClaim.get(s.claim_number)!.push(s);
  }

  const engine = evaluate(claims, {
    plan_option: settings.plan_option,
    coverage_tier: settings.coverage_tier,
    plan_year: settings.plan_year,
  });

  let pendingExpected = 0;
  let receivedCopay = 0;
  let receivedDeductible = 0;
  const rows: ClaimRow[] = claims.map((c) => {
    const m = c.member_id ? memberById.get(c.member_id) : undefined;
    const submissions = latestSubmissions(subsByClaim.get(c.claim_number) ?? []);
    const el = engine.results.get(c.claim_number)!;
    const changedAfter = (['deductible', 'copay'] as Benefit[]).some((b) => {
      const s = submissions[b];
      return Boolean(s && s.status !== 'unconfirmed' && c.last_changed_at && s.submitted_at && c.last_changed_at > s.submitted_at);
    });
    if (!submissions.deductible) pendingExpected += el.deductible_reimb_cents;
    if (!submissions.copay) pendingExpected += el.copay_reimb_cents;
    const sc = submissions.copay;
    if (sc && (sc.status === 'approved' || sc.status === 'paid')) receivedCopay += Math.round((sc.approved_cents ?? sc.amount_cents) / 2);
    const sd = submissions.deductible;
    if (sd && (sd.status === 'approved' || sd.status === 'paid')) receivedDeductible += el.deductible_reimb_cents;
    return {
      ...c,
      member_name: m?.display_name ?? 'Unknown',
      relationship: m?.relationship ?? 'unknown',
      has_pdf: eobs.has(c.claim_number),
      eligibility: el,
      submissions,
      changed_after_submission: changedAfter,
    };
  });

  const bounds = planYearBounds(settings.plan_year);
  return {
    rows,
    totals: engine.totals,
    members,
    deadline: { date: bounds.deadline, days_left: daysUntil(bounds.deadline) },
    pending_expected_cents: pendingExpected,
    received_cents: receivedCopay + receivedDeductible,
    received_copay_cents: receivedCopay,
    received_deductible_cents: receivedDeductible,
    unmatched_activity: listSummitActivity().filter((a) => !a.matched_claim_number).length,
  };
}
