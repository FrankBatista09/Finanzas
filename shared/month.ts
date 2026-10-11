import { TIMEZONE } from './constants';
import { MONTH_NAMES } from './i18n';
import type { ISODate, Language, MonthKey } from './types';

const KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isMonthKey(v: unknown): v is MonthKey {
  return typeof v === 'string' && KEY_RE.test(v);
}

/** Validates the format and that the day exists in that month (rejects 2026-02-30). */
export function isISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  // A two-digit year typed into a cell (0026), or an absurd one, is not a date in these finances, and Excel
  // cannot represent anything before 1900.
  if (+m[1]! < 1900 || +m[1]! > 2100) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCDate() === +m[3]!;
}

/** '2026-10' → 'October 2026' (or 'Octubre 2026', 'Ekim 2026' depending on the language). */
export function label(key: MonthKey, lang: Language = 'en'): string {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[lang][+m! - 1]} ${y}`;
}

/**
 * 'October 2026' → '2026-10' (sheet name in the Excel); null if it is not a month.
 * Without `months` it recognizes the month name in any of the app's languages.
 */
export function keyFromLabel(name: string, months?: readonly string[]): MonthKey | null {
  const mm = /^(\S+)\s+(\d{4})$/.exec(name.trim());
  if (!mm) return null;
  const lists = months ? [months] : Object.values(MONTH_NAMES);
  for (const list of lists) {
    const i = list.indexOf(mm[1]!);
    if (i >= 0) return `${mm[2]}-${String(i + 1).padStart(2, '0')}`;
  }
  return null;
}

export function nextKey(key: MonthKey): MonthKey {
  let [y, m] = key.split('-').map(Number) as [number, number];
  m++;
  if (m > 12) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function prevKey(key: MonthKey): MonthKey {
  let [y, m] = key.split('-').map(Number) as [number, number];
  m--;
  if (m < 1) {
    m = 12;
    y--;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** '2026-10-07' → '2026-10' */
export function monthOf(date: ISODate): MonthKey {
  return date.slice(0, 7);
}

/** First day of the month: '2026-10' → '2026-10-01'. */
export function firstDay(key: MonthKey): ISODate {
  return `${key}-01`;
}

/** Last day of the month: '2026-02' → '2026-02-28'. */
export function lastDay(key: MonthKey): ISODate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** true if the date falls within that month. */
export function inMonth(date: ISODate, key: MonthKey): boolean {
  return monthOf(date) === key;
}

/** The date if it falls in the month; if it is earlier, the first day of the month; if it is later, the last one. */
export function clampToMonth(date: ISODate, key: MonthKey): ISODate {
  const k = monthOf(date);
  return k === key ? date : k < key ? firstDay(key) : lastDay(key);
}

/** Months between two keys, both included ('2026-08'..'2027-10' → 15). */
export function monthSpan(start: MonthKey, end: MonthKey): number {
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  return (ey - sy) * 12 + (em - sm) + 1;
}

/** Today's date in the user's time zone (not the server's, nor UTC). */
export function todayISO(now: Date = new Date(), timeZone: string = TIMEZONE): ISODate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function currentMonthKey(now: Date = new Date(), timeZone: string = TIMEZONE): MonthKey {
  return monthOf(todayISO(now, timeZone));
}
