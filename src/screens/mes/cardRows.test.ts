import { describe, expect, it } from 'vitest';
import { cardCalc } from '../../../shared/calc';
import { seedState } from '../../../shared/seed';
import type { AppState } from '../../../shared/types';
import { cardTableRows, cashbackShown } from './cardRows';

const OCT = '2026-10';
const card = (id: string, sort: number, cashback: boolean) => ({
  id, name: id, bank: null, last4: null, cur: 'DOP' as const, limit: null, cutoffDay: null, dueDay: null, active: true, ...(cashback ? { cashback } : {}), sort,
});

describe('cardTableRows', () => {
  it('puts a cashback row right under the card that has the flag and only under it', () => {
    const state: AppState = { ...seedState(), cards: [card('a', 0, false), card('b', 1, true), card('c', 2, false)] };
    const calcs = ['a', 'b', 'c'].map((id) => cardCalc(state, OCT, id));
    expect(cardTableRows(calcs).map((r) => `${r.kind}:${r.calc.card.id}`)).toEqual(['card:a', 'card:b', 'cashback:b', 'card:c']);
  });

  it('shows the amount negative, and a plain 0 when there is none', () => {
    expect(cashbackShown({ cashback: 25 })).toBe(-25);
    expect(Object.is(cashbackShown({ cashback: 0 }), 0)).toBe(true);
  });
});
