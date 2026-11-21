/**
 * Date helpers. All business dates (due dates, periods, job schedules) are in IST.
 * IST has no daylight saving, so a fixed +05:30 offset is exact.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar parts of a moment as seen in IST. */
export function istParts(date: Date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1, // 1-12
    day: ist.getUTCDate(),
    hour: ist.getUTCHours(),
  };
}

/** "YYYY-MM" billing period for a moment, in IST. */
export function periodOf(date: Date = new Date()): string {
  const { year, month } = istParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The instant of IST midnight at the start of the given IST calendar day. */
export function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

/** [start, end) instants of an IST calendar month given as "YYYY-MM". */
export function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number);
  const start = istMidnight(y, m, 1);
  const end = m === 12 ? istMidnight(y + 1, 1, 1) : istMidnight(y, m + 1, 1);
  return { start, end };
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Whole IST calendar days from `from` to `to` (positive if `to` is later). */
export function istDayDiff(from: Date, to: Date): number {
  const a = istParts(from);
  const b = istParts(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** "Nov 2026" */
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** ISO week key like "2026-W47" (IST). */
export function isoWeekKey(date: Date = new Date()): string {
  const { year, month, day } = istParts(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
