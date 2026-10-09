// The items a credit card was charged this month and the status line of its row.

import { describe, expect, it } from 'vitest';
import { cardCalc } from '../../../shared/calc';
import { seedState } from '../../../shared/seed';
import type { AppState, CreditCard } from '../../../shared/types';
import { cardItems } from './cardItems';

const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const OTHER: CreditCard = { ...CARD, id: 'other', name: 'Other', sort: 1 };

function stateWith(): AppState {
  const s = { ...seedState(), cards: [CARD, OTHER] };
  const base = s.months[OCT]!;
  const fixed = { id: 'f', monthKey: OCT, name: 'Netflix', day: '5', amount: 10, cur: 'USD' as const, paid: true, accountId: 'dr', sort: 0, onCard: true, cardId: 'card' };
  const tx = { id: 't', monthKey: OCT, date: '2026-10-03', desc: 'Dinner', place: '', cat: 'Food', method: 'Credit card', amount: 500, cur: 'DOP' as const, accountId: 'dr', notes: '', source: 'web' as const, createdAt: null, cardId: 'card' };
  s.months[OCT] = {
    ...base,
    fixed: [
      fixed,
      { ...fixed, id: 'unticked', name: 'Gym', paid: false },
      { ...fixed, id: 'elsewhere', name: 'Phone', cardId: 'other' },
      { ...fixed, id: 'account', name: 'Rent', onCard: false },
    ],
    tx: [tx, { ...tx, id: 'cash', desc: 'Taxi', method: 'Cash' }, { ...tx, id: 'late', desc: 'Late', date: '2026-10-20' }, { ...tx, id: 'early', desc: 'Early', date: '2026-10-01' }, { ...tx, id: 'o', desc: 'Not mine', cardId: 'other' }],
  };
  return s;
}

describe('cardItems', () => {
  it('lists the ticked expenses of the card first, then its credit card transactions by date, and nothing else', () => {
    const items = cardItems(stateWith(), OCT, 'card');
    expect(items.map((i) => [i.kind, i.name, i.date])).toEqual([
      ['fixed', 'Netflix', null],
      ['tx', 'Early', '2026-10-01'],
      ['tx', 'Dinner', '2026-10-03'],
      ['tx', 'Late', '2026-10-20'],
    ]);
  });

  it('adds up, converted to the card currency, to what the card says was charged', () => {
    const s = stateWith();
    const items = cardItems(s, OCT, 'card');
    expect(items[0]!.amount).toBe(10);
    expect(items[0]!.cur).toBe('USD');
    expect(items[0]!.converted).toBeGreaterThan(10);
    expect(items.reduce((a, i) => a + i.converted, 0)).toBeCloseTo(cardCalc(s, OCT, 'card').charged, 6);
  });

  it('is empty for an unknown card or month', () => {
    expect(cardItems(stateWith(), OCT, 'nope')).toEqual([]);
    expect(cardItems(stateWith(), '1999-01', 'card')).toEqual([]);
  });
});

