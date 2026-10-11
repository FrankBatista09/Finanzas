// Pure logic of the "Pay credit card" dialog: what it proposes when it opens and when it can be confirmed.
// No React and no UI text. The money (what is left to pay) is computed by shared/calc.ts cardCalc.

import { cardAccountFor, cardCalc } from '../../../shared/calc';
import type { AppState, MonthKey } from '../../../shared/types';
import { snapToTotal } from '../../store';

/** What the dialog lets the user type: the amount as text (a half-typed field is not a number) and the account. */
export interface PayForm {
  amount: string;
  accountId: string;
}

/** With less than half a cent left to pay, the credit card is fully paid. */
export const isFullyPaid = (left: number): boolean => left < 0.005;

/**
 * What it proposes when it opens: paying everything that is left (with two decimals) from the account of that credit
 * card's last payment or, if it was never paid, the default account. With no money account, the account stays empty.
 */
export function payForm(state: AppState, key: MonthKey, cardId: string): PayForm {
  return { amount: Math.max(0, cardCalc(state, key, cardId).remainder).toFixed(2), accountId: cardAccountFor(state, key, cardId)?.id ?? '' };
}

/**
 * The amount to pay: a number > 0 and no greater than what is left. Typing what is left, rounded, counts as exactly
 * that, so no remainder of cents is left behind. null if the field is invalid (the confirmation stays disabled).
 */
export function payAmount(text: string, left: number): number | null {
  const n = text.trim() === '' ? NaN : Number(text);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const amount = snapToTotal(n, left);
  return amount <= left ? amount : null;
}

/** What will be left to pay with that amount; with an invalid amount, everything that is left. */
export function payRest(text: string, left: number): number {
  const amount = payAmount(text, left);
  return amount === null ? left : left - amount;
}
