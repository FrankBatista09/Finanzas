// What a credit card was charged this month, item by item, and the short status line of its row in "Monthly expenses".
// Pure, no React and no texts. The money itself comes from shared/calc.ts cardCalc; this lists what adds up to its `charged`.

import { chargedTo, convert, isCardTx, isCharged } from '../../../shared/calc';
import type { CardCalc } from '../../../shared/calc';
import type { AppState, Currency, ISODate, MonthKey } from '../../../shared/types';
import { sortFixed } from './rows';

export interface CardItem {
  id: string;
  kind: 'fixed' | 'tx';
  name: string;
  /** The transaction's date; null for a monthly expense (it has no date of its own). */
  date: ISODate | null;
  /** In its own currency. */
  amount: number;
  cur: Currency;
  /** In the card's currency, converted the same way cardCalc does, so the items add up to `charged`. */
  converted: number;
}

/** The ticked monthly expenses (in sheet order) and then the credit card transactions (oldest first) of `key` charged to the card. */
export function cardItems(state: AppState, key: MonthKey, cardId: string): CardItem[] {
  const month = state.months[key];
  const card = state.cards.find((c) => c.id === cardId);
  if (!month || !card) return [];
  const fixed = sortFixed(month.fixed)
    .filter((f) => isCharged(f) && chargedTo(state, f.cardId) === cardId)
    .map<CardItem>((f) => ({ id: f.id, kind: 'fixed', name: f.name, date: null, amount: f.amount, cur: f.cur, converted: convert(state, key, f.amount, f.cur, card.cur) }));
  // ISO dates sort as text; the sort is stable, so the same day keeps the order it was added in.
  const tx = month.tx
    .filter((t) => isCardTx(t) && chargedTo(state, t.cardId) === cardId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map<CardItem>((t) => ({ id: t.id, kind: 'tx', name: t.desc, date: t.date, amount: t.amount, cur: t.cur, converted: convert(state, key, t.amount, t.cur, card.cur, t.date) }));
  return [...fixed, ...tx];
}

/** Which status line the card row shows: how the payments stand once there are some, otherwise just what is owed. */
export function cardStatus(card: Pick<CardCalc, 'payments'>): 'paid' | 'owed' {
  return card.payments.length > 0 ? 'paid' : 'owed';
}
