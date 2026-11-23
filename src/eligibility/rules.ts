import type { CoverageTier, PlanOption } from '../types.js';

/**
 * MERP deductible benefit, from the Summary Plan Description.
 * The employee pays the first `threshold` of in-network deductible; the HRA pays 100% of the next `cap`.
 * All values in cents.
 */
export const DEDUCTIBLE_RULES: Record<PlanOption, Record<CoverageTier, { threshold: number; cap: number; ibxDeductible: number }>> = {
  gold: {
    single: { threshold: 150_000, cap: 100_000, ibxDeductible: 250_000 },
    family: { threshold: 300_000, cap: 200_000, ibxDeductible: 500_000 },
  },
  silver: {
    single: { threshold: 375_000, cap: 100_000, ibxDeductible: 475_000 },
    family: { threshold: 750_000, cap: 200_000, ibxDeductible: 950_000 },
  },
};

/** 50% of copays, up to $500 per employee per plan year. */
export const COPAY_RULE = { rate: 0.5, cap: 50_000 };

export const PLAN_LABELS: Record<PlanOption, string> = {
  gold: 'Personal Choice PPO Gold Classic $2,500',
  silver: 'Personal Choice PPO Silver Secure $4,750',
};
