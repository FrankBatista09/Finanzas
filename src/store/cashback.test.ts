// Cashback in the reducers: the amount per month, the flag and what turning it off clears.

import { describe, expect, it } from 'vitest';
import { cardCalc } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, CreditCard } from '../../shared/types';
import { cardCashbackChange, cardPatchChange, newCard, reduce } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const apply = (s: AppState, a: Action | null) => (a ? reduce(s, a) : s);
const flagged = (): AppState => apply({ ...seedState(), cards: [CARD] }, cardPatchChange({ ...seedState(), cards: [CARD] }, 'card', { cashback: true }));

describe('cashback', () => {
  it('needs the flag, an open month and a number >= 0', () => {
    const plain = { ...seedState(), cards: [CARD] };
    expect(cardCashbackChange(plain, OCT, 'card', 5)).toBeNull();
    const s = flagged();
    expect(s.cards[0]!.cashback).toBe(true);
    expect(cardCashbackChange(s, '2026-09', 'card', 5)).toBeNull();
    expect(cardCashbackChange(s, OCT, 'card', -1)).toBeNull();
    expect(cardCashbackChange(s, OCT, 'nope', 5)).toBeNull();
    expect(cardCalc(apply(s, cardCashbackChange(s, OCT, 'card', 5)), OCT, 'card').cashback).toBe(5);
  });

  it('writing 0 removes it from the month, like the server', () => {
    const s = flagged();
    const on = apply(s, cardCashbackChange(s, OCT, 'card', 5));
    expect('cards' in apply(on, cardCashbackChange(on, OCT, 'card', 0)).months[OCT]!).toBe(false);
  });

  it('turning the flag off clears the amounts and drops the key', () => {
    const s = flagged();
    const on = apply(s, cardCashbackChange(s, OCT, 'card', 5));
    const off = apply(on, cardPatchChange(on, 'card', { cashback: false }));
    expect('cashback' in off.cards[0]!).toBe(false);
    expect('cards' in off.months[OCT]!).toBe(false);
  });

  it('a new card carries the flag only when asked', () => {
    expect(newCard(seedState(), { name: 'A', cashback: true }, 'a')!.cashback).toBe(true);
    expect('cashback' in newCard(seedState(), { name: 'B' }, 'b')!).toBe(false);
  });
});
