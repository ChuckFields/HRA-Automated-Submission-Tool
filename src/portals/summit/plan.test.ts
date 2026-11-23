import { describe, expect, it } from 'vitest';
import { summitConfig } from './config.js';

describe('plan detection from the Summit home page', () => {
  it('reads Option 2 as Silver', () => {
    expect(summitConfig.planOptionFromText('Accounts Calendar Year: 2026 Option 2 - 3750/7500 $2,000.00 HRA 01/01/2026 - 12/31/2026')).toBe('silver');
  });
  it('reads Option 1 as Gold', () => {
    expect(summitConfig.planOptionFromText('Option 1 - 1500/3000 $2,000.00 HRA')).toBe('gold');
  });
  it('returns null when nothing matches', () => {
    expect(summitConfig.planOptionFromText('Additional CoPay Reimb $355.00 MERP')).toBeNull();
  });
});
