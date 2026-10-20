// Pure logic of the list of unpaid credit card purchases: what the checked ones add up to and what stays pending.
// No React and no UI text. Which purchases are unpaid and their amounts come from shared/calc.ts cardPurchases.

import { sumCardPurchases } from '../../../shared/calc';
import type { CardPurchase } from '../../../shared/calc';

export interface Selection {
  /** Checked purchases that are still in the list. */
  ids: string[];
  /** What they add up to in the card's currency, to cents. */
  sum: number;
}

/** The checked purchases that are still unpaid (one that was paid or deleted meanwhile drops out) and their sum. */
export function selection(purchases: readonly Pick<CardPurchase, 'tx' | 'amount'>[], checked: ReadonlySet<string>): Selection {
  const chosen = purchases.filter((p) => checked.has(p.tx.id));
  return { ids: chosen.map((p) => p.tx.id), sum: sumCardPurchases(chosen) };
}

/** What stays to pay on the card after paying `sum` of it (never negative). */
export function pendingAfter(remainder: number, sum: number): number {
  return Math.max(0, remainder - sum);
}

/** Paying the selection is possible when it is not empty and does not exceed what is left (half a cent of slack, as the server). */
export function canPaySelection(sel: Selection, remainder: number): boolean {
  return sel.ids.length > 0 && sel.sum > 0 && sel.sum <= remainder + 0.005 + 1e-6;
}
