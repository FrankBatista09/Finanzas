// Pure logic of a credit card's statement panel: which statements to offer, what each one lists and what the checked
// purchases add up to. No React and no UI text. The items and their amounts come from shared/calc.ts cardStatementItems.

import { sumCardPurchases } from '../../../shared/calc';
import type { StatementItem } from '../../../shared/calc';
import { statementList, statementOf } from '../../../shared/statements';
import type { ISODate } from '../../../shared/types';

/** The statements to offer, oldest first (those with an item and the current one); empty for a card with no cutoff day. */
export function statementCutoffs(items: readonly Pick<StatementItem, 'statement'>[], today: ISODate, cutoffDay: number | null): ISODate[] {
  if (!cutoffDay) return [];
  return statementList(
    items.flatMap((i) => (i.statement ? [i.statement] : [])),
    today,
    cutoffDay,
  );
}

/** The statement the panel opens on: the one containing today. null without a cutoff day (the panel lists everything). */
export function currentStatement(today: ISODate, cutoffDay: number | null): ISODate | null {
  return cutoffDay ? statementOf(today, cutoffDay) : null;
}

/** The statement `delta` places away in the offered list, kept inside it; `current` not in the list counts as the last one. */
export function stepStatement(cutoffs: readonly ISODate[], current: ISODate, delta: number): ISODate {
  const at = cutoffs.indexOf(current);
  const from = at < 0 ? cutoffs.length - 1 : at;
  return cutoffs[Math.min(Math.max(from + delta, 0), cutoffs.length - 1)] ?? current;
}

/** What a statement lists; null (no cutoff day) lists everything. */
export function itemsIn<T extends Pick<StatementItem, 'statement'>>(items: readonly T[], statement: ISODate | null): T[] {
  return statement === null ? [...items] : items.filter((i) => i.statement === statement);
}

/** Only a transaction that is not in any month yet can be picked; a fixed expense is ticked in its own table. */
export const canPick = (item: Pick<StatementItem, 'kind' | 'status'>): boolean => item.kind === 'tx' && item.status === 'unpaid';

export interface Selection {
  /** Checked items that can still be picked, in list order. */
  ids: string[];
  /** What they add up to in the card's currency, to cents. */
  sum: number;
}

/** The checked items that are still pickable (one added or deleted meanwhile drops out) and their sum. */
export function selection(items: readonly StatementItem[], checked: ReadonlySet<string>): Selection {
  const chosen = items.filter((i) => canPick(i) && checked.has(i.id));
  return { ids: chosen.map((i) => i.id), sum: sumCardPurchases(chosen.map((i) => ({ amount: i.converted }))) };
}

/** The statement's total and what is unpaid in it, in the card's currency, to cents. */
export function statementTotals(items: readonly StatementItem[]): { total: number; unpaid: number } {
  const sum = (list: readonly StatementItem[]) => sumCardPurchases(list.map((i) => ({ amount: i.converted })));
  return { total: sum(items), unpaid: sum(items.filter((i) => i.status === 'unpaid')) };
}

/** '2026-10-13' → 'Oct 13' / '13 oct' / '13 Eki', in the user's language. */
export function dayLabel(date: ISODate, lang: string): string {
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
