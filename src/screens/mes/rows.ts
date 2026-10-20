// Order, lists and formats of the "Month" sheet's tables: what the prototype's renderVals() prepares before painting.
// Pure functions, no React and no strings: the ones that depend on the language are in strings.ts.

import type { TransferFee } from '../../../shared/calc';
import { CREDIT_CARD_METHOD, METHODS, VIAS } from '../../../shared/constants';
import { fRate } from '../../../shared/format';
import { firstDay } from '../../../shared/month';
import type { Account, CreditCard, Currency, FixedExpense, ISODate, Month, MonthKey, MonthRate, Transaction } from '../../../shared/types';
import type { AccountOption, Money, PairRate } from '../../store';

// Text length limits the server enforces. The cell does not let you go past them: that way the save is not rejected
// (and undone) because of a text that is too long.
export { MAX_LEN } from '../../../shared/constants';

/** Fixed expenses in the sheet's order (`sort`). Ties keep the order they arrived in. */
export function sortFixed<T extends Pick<FixedExpense, 'sort'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort - b.sort);
}

/**
 * Transactions from newest to oldest. The order is stable: those of the same day stay as they
 * were (the one just added, below the ones with its same date), same as in the prototype.
 */
export function sortTxDesc<T extends Pick<Transaction, 'date'>>(rows: readonly T[]): T[] {
  // ISO dates sort correctly as text; they are compared without localeCompare so as not to depend on the locale.
  return [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * A history row: a transaction (it can be edited and deleted) or the fee of a transfer (calc.transferFees),
 * which is not a stored row: it is shown, counts in the totals and changes with its transfer.
 */
export type HistoryRow = { kind: 'tx'; key: string; date: ISODate; tx: Transaction } | { kind: 'fee'; key: string; date: ISODate; fee: TransferFee };

/**
 * The month's history: the transactions and the transfer fees together, from newest to
 * oldest. On the same date the transactions go first, in their order, and then the fees.
 */
export function historyRows(tx: readonly Transaction[], fees: readonly TransferFee[], order: HistoryOrder = 'dateNewest'): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...tx.map((t) => ({ kind: 'tx' as const, key: t.id, date: t.date, tx: t })),
    ...fees.map((fee) => ({ kind: 'fee' as const, key: `fee:${fee.transferId}`, date: fee.date, fee })),
  ];
  if (order === 'dateNewest') return sortTxDesc(rows);
  if (order === 'dateOldest') return [...sortTxDesc(rows)].reverse();
  // By when it was recorded: the stored timestamp, the row's place in the list breaking ties (it is read in the order it
  // was inserted). A row without a timestamp yet (just added, not saved) is the newest. A fee is not a stored row: it
  // goes at the end of its own date.
  const stamp = (r: HistoryRow): string => (r.kind === 'tx' ? (r.tx.createdAt ?? '9999') : `${r.date} 24`);
  const placed = rows.map((row, i) => ({ row, i }));
  placed.sort((a, b) => (stamp(a.row) < stamp(b.row) ? -1 : stamp(a.row) > stamp(b.row) ? 1 : a.i - b.i));
  const oldestFirst = placed.map((p) => p.row);
  return order === 'addedOldest' ? oldestFirst : oldestFirst.reverse();
}

/** How the history is ordered: by the transaction's date, or by when it was recorded; newest or oldest first. */
export type HistoryOrder = 'dateNewest' | 'dateOldest' | 'addedNewest' | 'addedOldest';
export const HISTORY_ORDERS: readonly HistoryOrder[] = ['dateNewest', 'dateOldest', 'addedNewest', 'addedOldest'];

/**
 * The fee of the most recent transfer made through that via (case-insensitive), in this month or in earlier
 * ones: it is the one suggested for the next transfer, because each service usually charges the same every time. 0 if
 * there is none. "Most recent" is by date; on the same date, the one recorded later.
 */
export function lastFee(months: Readonly<Record<MonthKey, Pick<Month, 'transfers'>>>, monthKey: MonthKey, via: string): number {
  const wanted = via.trim().toLowerCase();
  let hit: { date: ISODate; fee: number } | null = null;
  for (const key of Object.keys(months).sort()) {
    if (key > monthKey) break;
    for (const t of months[key]!.transfers) {
      if (t.via.trim().toLowerCase() === wanted && (!hit || t.date >= hit.date)) hit = { date: t.date, fee: t.fee || 0 };
    }
  }
  return hit?.fee ?? 0;
}

// ── Credit cards in the selects ──────────────────────────────────────────────

/** "Pay with" value for an account; with a credit card it is `card:<id>`. */
export const PAY_ACCOUNT = 'account';
const PAY_CARD = 'card:';

/** The value of a fixed expense's "Pay with" select: its credit card, or the first active one if it does not say which. */
export function payWithValue(onCard: boolean, cardId: string | null | undefined, firstActive: string | null): string {
  return onCard ? `${PAY_CARD}${cardId ?? firstActive ?? ''}` : PAY_ACCOUNT;
}

/** The reverse: the chosen select value becomes `onCard` and the credit card (no credit card when it is an account). */
export function parsePayWith(value: string): { onCard: boolean; cardId?: string } {
  return value.startsWith(PAY_CARD) ? { onCard: true, cardId: value.slice(PAY_CARD.length) } : { onCard: false };
}

export interface CardOption {
  value: string;
  label: string;
}

/** The active credit cards by name; the one the row already has stays even if it is off, so the select does not lie. */
export function cardOptions(cards: readonly CreditCard[], current?: string | null): CardOption[] {
  return [...cards].filter((c) => c.active || c.id === current).sort((a, b) => a.sort - b.sort).map((c) => ({ value: c.id, label: c.name }));
}

/** "Pay with": the account and one option per active credit card (plus the row's own, if it is off). */
export function payWithOptions(accountLabel: string, cards: readonly CreditCard[], current?: string | null): CardOption[] {
  return [{ value: PAY_ACCOUNT, label: accountLabel }, ...cardOptions(cards, current).map((o) => ({ value: `${PAY_CARD}${o.value}`, label: o.label }))];
}

/** The payment methods offered: with no active credit card, "Credit card" makes no sense (unless the row already has it). */
export function methodChoices(hasCard: boolean, current?: string): readonly string[] {
  const base: readonly string[] = hasCard ? METHODS : METHODS.filter((m) => m !== CREDIT_CARD_METHOD);
  return current === undefined || base.includes(current) ? base : [...base, current];
}

/**
 * Options of a category or method select. If the row comes with a value that is not in the list
 * (data imported from Excel or recorded by Claude), it is appended at the end: without that the <select> would show
 * the first option and the real value would change without anyone asking for it.
 */
export function optionsWith(base: readonly string[], value: string): readonly string[] {
  return base.includes(value) ? base : [...base, value];
}

export interface LabelledOption {
  value: string;
  label: string;
}

/**
 * The options as CellSelect wants them when what is shown is not what is stored: the value is the canonical
 * name (in English) and the text, its name in the current language (catLabel / methodLabel from useI18n).
 * A value from outside the list has no translation and is shown as is.
 */
export function labelled(values: readonly string[], label: (value: string) => string): LabelledOption[] {
  return values.map((value) => ({ value, label: label(value) }));
}

// ── Amounts and accounts of a row ────────────────────────────────────────────

/** A row with its two computed columns: the amount in the main currency and in the second one. */
export type WithMoney<T> = { row: T } & Money;

/**
 * The rows with their amounts already converted (`inBoth` from useFinanzas()): a row with its own date (a
 * transaction), at the rate in effect on its date; one without a date (a fixed expense), at the month's last one. A
 * memoized row gets the two figures and not the function, which changes with every state change.
 */
export function withMoney<T extends { amount: number; cur: Currency; date?: ISODate }>(
  rows: readonly T[],
  inBoth: (amount: number, cur: Currency, key?: MonthKey, date?: ISODate) => Money,
): WithMoney<T>[] {
  return rows.map((row) => ({ row, ...inBoth(row.amount, row.cur, undefined, row.date) }));
}

/**
 * The options of a row's account select: the visible ones (`base`, the same list for every row, so the
 * memoized ones do not repaint) and, only if the row's account is not among them because it was hidden later,
 * that one after them with its name: it has to stay visible instead of changing to another on its own.
 */
export function rowAccountOptions(base: readonly AccountOption[], accounts: readonly Account[], id: string): readonly AccountOption[] {
  if (!id || base.some((o) => o.value === id)) return base;
  return [...base, { value: id, label: accounts.find((a) => a.id === id)?.name ?? '—' }];
}

// ── Month rates ──────────────────────────────────────────────────────────────

// usedCurrencies and shownRates live in store/view.ts: the top bar needs to know which rates are needed.
export { accountsInUse, currenciesInUse, hasActivity, shownRates, usedCurrencies } from '../../store/view';

/** No rate is needed: all the money is in one currency and there is no rate typed this month to show. */
export function noRatesNeeded(shown: readonly PairRate[]): boolean {
  return shown.length === 0;
}

const samePair = (r: { from: Currency; to: Currency }, from: Currency, to: Currency) =>
  (r.from === from && r.to === to) || (r.from === to && r.to === from);

/**
 * A row of the "Month rates" card.
 *  typed     a rate typed in this month, with its date: it can be corrected and removed.
 *  resolved  the rate in effect for a pair that has none typed in this month (default value, transfers, crossed rate
 *            or an earlier month): nothing is stored to remove; typing in it creates the pair's rate, from `date`.
 */
export type RateRow =
  | { kind: 'typed'; key: string; from: Currency; to: Currency; rate: number; date: ISODate }
  | { kind: 'resolved'; key: string; from: Currency; to: Currency; rate: number; date: ISODate; info: PairRate };

/**
 * The date suggested for a new rate of that pair: `draftDate` (today if the month is the current one; otherwise its
 * first day) when the pair already has a typed rate in effect; if it has none, the first day of the month, so
 * that the rate also covers this month's earlier rows. `rates` are the ones from useFinanzas().
 */
export function newRateDate(from: Currency, to: Currency, rates: readonly PairRate[], monthKey: MonthKey, draftDate: ISODate): ISODate {
  // RateInfo.date is only set when the rate in effect is a typed one (from this month or an earlier one).
  const typed = rates.find((r) => samePair(r, from, to))?.date ?? null;
  return typed === null ? firstDay(monthKey) : draftDate;
}

/**
 * The card's rows: for each pair shown (`shown`, in its order), its rates typed in this month by
 * date (those with the same date, as they arrived) or, if it has none, the one in effect with its source. A row's
 * key is its pair and its date: typing in a 'resolved' row makes the 'typed' one with that same key appear in its
 * place, and the field being typed in does not unmount.
 */
export function rateRows(
  shown: readonly PairRate[],
  typed: readonly MonthRate[],
  rates: readonly PairRate[],
  monthKey: MonthKey,
  draftDate: ISODate,
): RateRow[] {
  return shown.flatMap((pair): RateRow[] => {
    const id = [pair.from, pair.to].sort().join('-');
    const mine = typed.filter((r) => r.rate > 0 && samePair(r, pair.from, pair.to)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (mine.length > 0) return mine.map((r) => ({ kind: 'typed', key: `${id}:${r.date}`, from: r.from, to: r.to, rate: r.rate, date: r.date }));
    const date = newRateDate(pair.from, pair.to, rates, monthKey, draftDate);
    return [{ kind: 'resolved', key: `${id}:${date}`, from: pair.from, to: pair.to, rate: pair.rate, date, info: pair }];
  });
}

/**
 * A rate as text: two decimals, as in the whole app. One below 1 (1 DOP = 0.0170 USD) gets four,
 * as in the top bar: with two it would say nothing.
 */
export function showRate(rate: number): string {
  return rate > 0 && rate < 1 ? rate.toFixed(4) : fRate(rate);
}

/**
 * Suggestions for a transfer's via: first the usual ones (VIAS) and then the ones already used in this month
 * and in earlier ones, from newest to oldest. The via is free text; this only saves typing it.
 * They are not repeated even if the capitalization differs ("paypal" is not offered next to "PayPal").
 */
export function viaSuggestions(months: Readonly<Record<MonthKey, Pick<Month, 'transfers'>>>, monthKey: MonthKey): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const offer = (via: string) => {
    const text = via.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  VIAS.forEach(offer);
  // 'YYYY-MM' keys sort correctly as text.
  const keys = Object.keys(months)
    .filter((key) => key <= monthKey)
    .sort()
    .reverse();
  for (const key of keys) [...months[key]!.transfers].reverse().forEach((t) => offer(t.via));
  return out;
}

/** '2026-10-02' → '02/10' ("Date" column of the transfers). */
export function shortDate(date: ISODate): string {
  return `${date.slice(8)}/${date.slice(5, 7)}`;
}

/** How a transfer is named in the labels of its cells: "Remitly 02/10". */
export function transferName(t: { via: string; date: ISODate }): string {
  return `${t.via} ${shortDate(t.date)}`.trim();
}

/**
 * The rate inside its field: with at least two decimals, as in the rest of the sheet (58.7 → '58.70'),
 * but without trimming the extra ones the user typed (58.755 stays as '58.755').
 */
export function rateText(rate: number): string {
  const two = fRate(rate);
  // The field never yields a non-finite value (parseAmount turns it into 0); just in case, it is shown as fRate paints it.
  return !Number.isFinite(rate) || Number(two) === rate ? two : String(rate);
}

/** Width of a category's bar: its share of the largest value (`MonthCalc.catMax`, which is never 0). */
export function barWidth(value: number, max: number): string {
  return `${(value / max) * 100}%`;
}
