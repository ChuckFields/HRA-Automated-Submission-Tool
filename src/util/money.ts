/** Parse "$1,234.56", "1234.56", "(12.00)", "-$5" or a number into integer cents. Returns 0 for blank. */
export function parseMoney(input: unknown): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  const s = String(input).trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s) || s.includes('-');
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (Number.isNaN(cents)) return 0;
  return negative ? -cents : cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/** Dollars with two decimals, no symbol or separators: what a web form's amount field wants. */
export function centsToPlain(cents: number): string {
  return (cents / 100).toFixed(2);
}
