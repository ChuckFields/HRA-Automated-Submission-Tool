import { describe, expect, it } from 'vitest';
import { evaluate, type ClaimInput, type EngineSettings } from './engine.js';

let n = 0;
function claim(over: Partial<ClaimInput>): ClaimInput {
  n += 1;
  return {
    claim_number: `C${String(n).padStart(3, '0')}`,
    member_id: 1,
    service_start: '2026-01-15',
    service_end: '2026-01-15',
    claim_type: 'medical',
    network_status: 'in',
    claim_status: 'processed',
    deductible_cents: 0,
    copay_cents: 0,
    coinsurance_cents: 0,
    user_override_qualifies: null,
    ...over,
  };
}

const base: EngineSettings = { plan_option: 'gold', coverage_tier: 'family', plan_year: 2026 };

describe('eligibility engine', () => {
  it('requires setup', () => {
    const out = evaluate([claim({ deductible_cents: 100 })], { ...base, plan_option: null });
    expect([...out.results.values()][0].status).toBe('setup_required');
  });

  it('reproduces the Gold family worked example', () => {
    const claims = [
      claim({ service_start: '2026-01-15', service_end: '2026-01-15', member_id: 1, deductible_cents: 120_000, copay_cents: 4_000 }),
      claim({ service_start: '2026-02-03', service_end: '2026-02-03', member_id: 2, deductible_cents: 150_000, copay_cents: 8_000 }),
      claim({ service_start: '2026-03-10', service_end: '2026-03-10', member_id: 3, deductible_cents: 80_000 }),
      claim({ service_start: '2026-04-02', service_end: '2026-04-02', member_id: 1, deductible_cents: 130_000 }),
      claim({ service_start: '2026-05-20', service_end: '2026-05-20', member_id: 2, deductible_cents: 60_000, copay_cents: 4_000 }),
      claim({ service_start: '2026-06-01', service_end: '2026-06-01', member_id: 3, copay_cents: 8_000 }),
    ];
    const out = evaluate(claims, base);
    const r = claims.map((c) => out.results.get(c.claim_number)!);
    expect(r.map((x) => x.deductible_reimb_cents)).toEqual([0, 0, 50_000, 130_000, 20_000, 0]);
    expect(r.map((x) => x.copay_reimb_cents)).toEqual([2_000, 4_000, 0, 0, 2_000, 4_000]);
    expect(r.map((x) => x.expected_cents)).toEqual([2_000, 4_000, 50_000, 130_000, 22_000, 4_000]);
    expect(out.totals.hra_deductible_paid_cents).toBe(200_000);
    expect(out.totals.hra_deductible_remaining_cents).toBe(0);
    expect(out.totals.copay_reimb_cents).toBe(12_000);
  });

  it('marks below-threshold deductible claims as accumulates', () => {
    const out = evaluate([claim({ deductible_cents: 50_000 })], { ...base, plan_option: 'silver' });
    const r = [...out.results.values()][0];
    expect(r.status).toBe('accumulates');
    expect(r.expected_cents).toBe(0);
  });

  it.each([
    ['gold', 'single', 150_000, 100_000],
    ['gold', 'family', 300_000, 200_000],
    ['silver', 'single', 375_000, 100_000],
    ['silver', 'family', 750_000, 200_000],
  ] as const)('%s %s pays exactly the band above the threshold', (plan, tier, T, C) => {
    const claims = [
      claim({ service_start: '2026-01-01', service_end: '2026-01-01', deductible_cents: T }),
      claim({ service_start: '2026-02-01', service_end: '2026-02-01', deductible_cents: C + 12_345 }),
    ];
    const out = evaluate(claims, { ...base, plan_option: plan, coverage_tier: tier });
    const [a, b] = claims.map((c) => out.results.get(c.claim_number)!);
    expect(a.status).toBe('accumulates');
    expect(a.deductible_reimb_cents).toBe(0);
    expect(b.deductible_reimb_cents).toBe(C);
    expect(out.totals.threshold_cents).toBe(T);
  });

  it('rejects out-of-network, pending, denied, other-year and dental', () => {
    const claims = [
      claim({ network_status: 'out', deductible_cents: 100 }),
      claim({ claim_status: 'pending', deductible_cents: 100 }),
      claim({ claim_status: 'denied', deductible_cents: 100 }),
      claim({ service_start: '2025-12-31', service_end: '2025-12-31', deductible_cents: 100 }),
      claim({ claim_type: 'dental', deductible_cents: 100 }),
      claim({ deductible_cents: 0, copay_cents: 0 }),
    ];
    const out = evaluate(claims, base);
    for (const c of claims) expect(out.results.get(c.claim_number)!.status).toBe('not_eligible');
  });

  it('counts prescription copays toward the copay benefit', () => {
    const out = evaluate([claim({ claim_type: 'rx', copay_cents: 3_000 })], base);
    const r = [...out.results.values()][0];
    expect(r.status).toBe('qualifies');
    expect(r.copay_reimb_cents).toBe(1_500);
    expect(r.submit_copay).toBe(true);
    expect(r.submit_deductible).toBe(false);
  });

  it('flags which benefits to submit', () => {
    const out = evaluate([claim({ deductible_cents: 10_000, copay_cents: 4_000 })], { ...base, plan_option: 'silver' });
    const r = [...out.results.values()][0];
    expect(r.submit_deductible).toBe(true); // below threshold but still accumulates
    expect(r.submit_copay).toBe(true);
    expect(r.status).toBe('qualifies'); // copay half pays out
  });

  it('flags unknown network for review and keeps it out of the accumulator', () => {
    const claims = [claim({ network_status: 'unknown', deductible_cents: 500_000 }), claim({ service_start: '2026-02-01', service_end: '2026-02-01', deductible_cents: 100 })];
    const out = evaluate(claims, base);
    expect(out.results.get(claims[0].claim_number)!.status).toBe('needs_review');
    expect(out.results.get(claims[1].claim_number)!.ded_cum_before).toBe(0);
  });

  it('caps copay reimbursement at $500', () => {
    const claims = Array.from({ length: 12 }, (_, i) =>
      claim({ service_start: `2026-${String(i + 1).padStart(2, '0')}-01`, service_end: `2026-${String(i + 1).padStart(2, '0')}-01`, copay_cents: 10_000 }),
    );
    const out = evaluate(claims, base);
    const reimb = claims.map((c) => out.results.get(c.claim_number)!.copay_reimb_cents);
    expect(reimb.slice(0, 10)).toEqual(Array(10).fill(5_000));
    expect(reimb[10]).toBe(0);
    expect(out.results.get(claims[10].claim_number)!.status).toBe('not_eligible');
    expect(out.totals.copay_remaining_cents).toBe(0);
  });

  it('honours user overrides', () => {
    const claims = [claim({ network_status: 'out', deductible_cents: 100, user_override_qualifies: 1 }), claim({ deductible_cents: 100, user_override_qualifies: 0 })];
    const out = evaluate(claims, base);
    expect(out.results.get(claims[0].claim_number)!.status).toBe('accumulates');
    expect(out.results.get(claims[1].claim_number)!.status).toBe('not_eligible');
  });
});
