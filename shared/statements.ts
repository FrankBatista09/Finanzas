// Credit card statements: the periods a cutoff day cuts purchases into. Pure date logic, no money.
//
// The statement with cutoff date D covers the purchases dated from the day after the previous cutoff up to D, both
// included: a purchase made ON the cutoff day belongs to the statement that closes that day. A cutoff day the month
// does not have (31 in November, 30 or 31 in February) falls on the last day of that month.

import { lastDay, monthOf, nextKey, prevKey } from './month';
import type { ISODate, MonthKey } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/** The cutoff date of a card in a month: the cutoff day, or the month's last day when the month is shorter. */
export function cutoffIn(key: MonthKey, cutoffDay: number): ISODate {
  const last = Number(lastDay(key).slice(8));
  return `${key}-${pad(Math.min(cutoffDay, last))}`;
}

/** '2026-10-14' + 1 → '2026-10-15'. */
export function addDays(date: ISODate, days: number): ISODate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The cutoff date of the statement a purchase made on `date` belongs to. */
export function statementOf(date: ISODate, cutoffDay: number): ISODate {
  const here = cutoffIn(monthOf(date), cutoffDay);
  return date <= here ? here : cutoffIn(nextKey(monthOf(date)), cutoffDay);
}

/** The statement right before the one closing on `cutoff`. */
export function previousStatement(cutoff: ISODate, cutoffDay: number): ISODate {
  return cutoffIn(prevKey(monthOf(cutoff)), cutoffDay);
}

/** The statement right after the one closing on `cutoff`. */
export function nextStatement(cutoff: ISODate, cutoffDay: number): ISODate {
  return cutoffIn(nextKey(monthOf(cutoff)), cutoffDay);
}

/** First and last day (both included) of the statement closing on `cutoff`. */
export function statementPeriod(cutoff: ISODate, cutoffDay: number): { from: ISODate; to: ISODate } {
  return { from: addDays(previousStatement(cutoff, cutoffDay), 1), to: cutoff };
}

/**
 * The statement a fixed expense of month `key` belongs to. It has no date, only the month and a free-text `day`: with a
 * day that is a number past the month's cutoff it falls in the next statement; with no day or a day that is not a
 * number ("15th", "end") it counts for the month's own statement, the one closing in that month.
 */
export function fixedStatement(key: MonthKey, day: string, cutoffDay: number): ISODate {
  const cutoff = cutoffIn(key, cutoffDay);
  const text = day.trim();
  const n = /^\d{1,2}$/.test(text) ? Number(text) : null;
  return n === null || n <= Number(cutoff.slice(8)) ? cutoff : nextStatement(cutoff, cutoffDay);
}

/**
 * The statements to offer, oldest first: every one with a purchase plus the one containing `today`, so the current
 * statement is always there even when it is empty.
 */
export function statementList(cutoffs: Iterable<ISODate>, today: ISODate, cutoffDay: number): ISODate[] {
  return [...new Set([...cutoffs, statementOf(today, cutoffDay)])].sort();
}
