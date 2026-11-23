/** Normalize many date spellings to YYYY-MM-DD. Returns null when unparseable. */
export function toIsoDate(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input.toISOString().slice(0, 10);
  const s = String(input).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD -> MM/DD/YYYY (the format most US web forms expect). */
export function isoToUs(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function planYearBounds(year: number): { start: string; end: string; deadline: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31`, deadline: `${year + 1}-03-01` };
}

export function daysUntil(iso: string): number {
  const target = new Date(`${iso}T00:00:00`);
  const today = new Date(`${todayIso()}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
