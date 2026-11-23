import { COPAY_RULE, DEDUCTIBLE_RULES } from './rules.js';
import type { ClaimStatus, ClaimType, CoverageTier, NetworkStatus, PlanOption } from '../types.js';

export interface ClaimInput {
  claim_number: string;
  member_id: number | null;
  service_start: string;
  service_end: string;
  claim_type: ClaimType;
  network_status: NetworkStatus;
  claim_status: ClaimStatus;
  deductible_cents: number;
  copay_cents: number;
  coinsurance_cents: number;
  user_override_qualifies: number | null;
}

export interface EngineSettings {
  plan_option: PlanOption | null;
  coverage_tier: CoverageTier | null;
  plan_year: number;
}

export type EligibilityStatus =
  | 'setup_required'
  | 'qualifies' // expected reimbursement > 0
  | 'accumulates' // deductible applied but below the employee-paid threshold: submit so Alera's running total is right
  | 'needs_review' // in/out of network unknown
  | 'not_eligible';

export interface EligibilityResult {
  claim_number: string;
  status: EligibilityStatus;
  reasons: string[];
  /** The deductible dollars on this EOB count toward the HRA benefit (submit them even when the payout is $0). */
  submit_deductible: boolean;
  /** The copay dollars on this EOB can be submitted to the copay benefit. */
  submit_copay: boolean;
  deductible_reimb_cents: number;
  copay_reimb_cents: number;
  expected_cents: number;
  ded_cum_before: number;
  ded_cum_after: number;
  copay_pool_before: number;
  copay_pool_after: number;
}

export interface EngineTotals {
  deductible_applied_cents: number;
  threshold_cents: number;
  cap_cents: number;
  hra_deductible_paid_cents: number;
  hra_deductible_remaining_cents: number;
  copay_reimb_cents: number;
  copay_remaining_cents: number;
  copay_cap_cents: number;
  per_member_deductible_cents: Record<string, number>;
}

export interface EngineOutput {
  results: Map<string, EligibilityResult>;
  totals: EngineTotals;
}

function gate(c: ClaimInput, s: EngineSettings): { ok: boolean; status: EligibilityStatus; reasons: string[] } {
  const reasons: string[] = [];
  const yearStart = `${s.plan_year}-01-01`;
  const yearEnd = `${s.plan_year}-12-31`;

  if (c.user_override_qualifies === 0) return { ok: false, status: 'not_eligible', reasons: ['Marked not eligible by you'] };
  if (c.user_override_qualifies === 1) return { ok: true, status: 'qualifies', reasons: ['Marked eligible by you'] };

  if (c.service_start < yearStart || c.service_end > yearEnd) {
    reasons.push(`Service date outside plan year ${s.plan_year}`);
  }
  if (c.claim_type === 'dental' || c.claim_type === 'vision') reasons.push(`${c.claim_type} claim is not covered by the MERP`);
  if (c.network_status === 'out') reasons.push('Out of network (MERP covers in-network only)');
  if (c.claim_status === 'pending') reasons.push('Still pending with IBX');
  if (c.claim_status === 'denied') reasons.push('Denied by IBX');
  if (c.deductible_cents <= 0 && c.copay_cents <= 0) reasons.push('No deductible or copay applied');
  if (reasons.length) return { ok: false, status: 'not_eligible', reasons };

  if (c.network_status === 'unknown') {
    return { ok: false, status: 'needs_review', reasons: ['Could not tell if in-network; check the EOB'] };
  }
  if (c.claim_status === 'unknown') {
    return { ok: false, status: 'needs_review', reasons: ['Claim status unknown; check the EOB'] };
  }
  return { ok: true, status: 'qualifies', reasons: [] };
}

const EMPTY = { deductible_reimb_cents: 0, copay_reimb_cents: 0, expected_cents: 0, submit_deductible: false, submit_copay: false };

export function evaluate(claims: ClaimInput[], s: EngineSettings): EngineOutput {
  const results = new Map<string, EligibilityResult>();
  const perMember: Record<string, number> = {};

  if (!s.plan_option || !s.coverage_tier) {
    for (const c of claims) {
      results.set(c.claim_number, {
        claim_number: c.claim_number, status: 'setup_required', reasons: ['Run Sync Summit (plan) and Fetch claims (coverage tier) so the plan rules can be applied'],
        ...EMPTY, ded_cum_before: 0, ded_cum_after: 0, copay_pool_before: 0, copay_pool_after: 0,
      });
    }
    return {
      results,
      totals: {
        deductible_applied_cents: 0, threshold_cents: 0, cap_cents: 0, hra_deductible_paid_cents: 0,
        hra_deductible_remaining_cents: 0, copay_reimb_cents: 0, copay_remaining_cents: COPAY_RULE.cap,
        copay_cap_cents: COPAY_RULE.cap, per_member_deductible_cents: {},
      },
    };
  }

  const rule = DEDUCTIBLE_RULES[s.plan_option][s.coverage_tier];
  const T = rule.threshold;
  const C = rule.cap;

  const sorted = [...claims].sort((a, b) =>
    a.service_start < b.service_start ? -1 : a.service_start > b.service_start ? 1 : a.claim_number.localeCompare(b.claim_number),
  );

  let dedCum = 0;
  let copayPool = 0;
  let hraDedPaid = 0;

  for (const c of sorted) {
    const g = gate(c, s);
    if (!g.ok) {
      results.set(c.claim_number, {
        claim_number: c.claim_number, status: g.status, reasons: g.reasons, ...EMPTY,
        ded_cum_before: dedCum, ded_cum_after: dedCum, copay_pool_before: copayPool, copay_pool_after: copayPool,
      });
      continue;
    }

    const before = dedCum;
    const after = before + Math.max(0, c.deductible_cents);
    const dedReimb = Math.max(0, Math.min(after, T + C) - Math.max(before, T));
    const copayReimb = Math.min(Math.round(Math.max(0, c.copay_cents) * COPAY_RULE.rate), Math.max(0, COPAY_RULE.cap - copayPool));
    const expected = dedReimb + copayReimb;
    const submitDeductible = c.deductible_cents > 0 && before < T + C; // pointless once the HRA band is used up
    const submitCopay = c.copay_cents > 0 && copayReimb > 0;

    const reasons = [...g.reasons];
    let status: EligibilityStatus = 'qualifies';
    if (dedReimb > 0) reasons.push(`Deductible dollars ${fmt(Math.max(before, T))}–${fmt(Math.min(after, T + C))} fall in the HRA band`);
    if (copayReimb > 0) reasons.push(`50% of ${fmt(c.copay_cents)} copay`);
    if (c.deductible_cents > 0 && dedReimb === 0) {
      reasons.push(submitDeductible
        ? `Deductible below the ${fmt(T)} employee-paid threshold (running total ${fmt(after)}); submit anyway so Alera's total stays current`
        : `HRA deductible benefit of ${fmt(C)} already used`);
    }
    if (c.copay_cents > 0 && copayReimb === 0) reasons.push('Copay benefit of $500 already used');
    if (expected === 0) status = submitDeductible ? 'accumulates' : 'not_eligible';

    results.set(c.claim_number, {
      claim_number: c.claim_number, status, reasons,
      submit_deductible: submitDeductible, submit_copay: submitCopay,
      deductible_reimb_cents: dedReimb, copay_reimb_cents: copayReimb, expected_cents: expected,
      ded_cum_before: before, ded_cum_after: after, copay_pool_before: copayPool, copay_pool_after: copayPool + copayReimb,
    });

    dedCum = after;
    copayPool += copayReimb;
    hraDedPaid += dedReimb;
    const mk = String(c.member_id ?? 'unknown');
    perMember[mk] = (perMember[mk] ?? 0) + Math.max(0, c.deductible_cents);
  }

  return {
    results,
    totals: {
      deductible_applied_cents: dedCum,
      threshold_cents: T,
      cap_cents: C,
      hra_deductible_paid_cents: hraDedPaid,
      hra_deductible_remaining_cents: Math.max(0, C - hraDedPaid),
      copay_reimb_cents: copayPool,
      copay_remaining_cents: Math.max(0, COPAY_RULE.cap - copayPool),
      copay_cap_cents: COPAY_RULE.cap,
      per_member_deductible_cents: perMember,
    },
  };
}

function fmt(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
