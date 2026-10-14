// The rows of the credit card section of "Fixed monthly expenses": pure, no React and no texts.
// A card with the cashback flag gets a derived row right under its own; the amounts come from shared/calc.ts cardCalc.

import type { CardCalc } from '../../../shared/calc';

export type CardTableRow = { kind: 'card'; calc: CardCalc } | { kind: 'cashback'; calc: CardCalc };

/** Each card's row, followed by its cashback row when the card has the flag (calc.card.cashback). The cards come in the given order. */
export function cardTableRows(cards: readonly CardCalc[]): CardTableRow[] {
  return cards.flatMap<CardTableRow>((calc) => (calc.card.cashback ? [{ kind: 'card', calc }, { kind: 'cashback', calc }] : [{ kind: 'card', calc }]));
}

/** What the cashback row shows in the money columns: the credit it gives, negative; a plain 0 when there is none. */
export const cashbackShown = (calc: Pick<CardCalc, 'cashback'>): number => (calc.cashback === 0 ? 0 : -calc.cashback);
