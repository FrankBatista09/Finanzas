// Adding Credit-card purchases to a month in the reducers: the rules the server also enforces, the fixed row standing for
// a purchase and how it follows (or is removed with) the purchase.

import { describe, expect, it } from 'vitest';
import { cardCalc, cardPurchases, unpaidCardPurchases } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, CreditCard, Transaction } from '../../shared/types';
import { cardInclusion, cardUnpay, reduce } from './reducers';
import type { Action } from './reducers';

const SEP = '2026-09';
const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});

/** September (closed) has purchase `s1` of 100; October has `a` 200 and `b` 10 USD (587.60 DOP) and a debit one; all unpaid. */
function state(): AppState {
  const seed = seedState();
  const byMonth: Record<string, Transaction[]> = {
    [SEP]: [tx('s1', SEP, '2026-09-05', 100)],
    [OCT]: [tx('a', OCT, '2026-10-03', 200, { cardId: 'card' }), tx('b', OCT, '2026-10-04', 10, { cur: 'USD' }), tx('d', OCT, '2026-10-05', 40, { method: 'Debit card' })],
  };
  return { ...seed, months: Object.fromEntries(Object.entries(seed.months).map(([k, m]) => [k, { ...m, tx: byMonth[k] ?? [], fixed: [] }])), cards: [CARD] };
}

const apply = (s: AppState, action: Action | null): AppState => (action ? reduce(s, action) : s);
let n = 0;
const include = (s: AppState, ids: string[], destination: 'fixed' | 'history', key = OCT) => cardInclusion(s, key, 'card', ids, destination, () => `new${++n}`);
const find = (s: AppState, id: string) => Object.values(s.months).flatMap((m) => m.tx).find((t) => t.id === id)!;

describe('cardInclusion', () => {
  it('refuses what the server refuses', () => {
    const s = state();
    expect(include(s, ['a'], 'history', SEP)).toBeNull(); // closed month
    expect(include(s, ['a'], 'history', '2030-01')).toBeNull(); // no such month
    expect(include(s, [], 'history')).toBeNull();
    expect(include(s, ['a', 'a'], 'history')).toBeNull();
    expect(include(s, ['d'], 'history')).toBeNull(); // not a Credit-card purchase
    expect(include(s, ['nope'], 'history')).toBeNull();
    expect(cardInclusion(s, OCT, 'nope', ['a'], 'history', () => 'x')).toBeNull();
    const off = { ...s, cards: [{ ...CARD, active: false }] };
    expect(include(off, ['a'], 'fixed')).toBeNull();
    expect(include(off, ['a'], 'history')).not.toBeNull();
    const once = apply(s, include(s, ['a'], 'history'));
    expect(include(once, ['a'], 'history')).toBeNull(); // already added
  });

  it('history marks the purchases (also from an earlier sheet) and they enter the card total', () => {
    const s = state();
    const next = apply(s, include(s, ['s1', 'a'], 'history'));
    expect(find(next, 's1').cardMonth).toBe(OCT);
    expect(find(next, 'a').cardMonth).toBe(OCT);
    expect(find(next, 'b').cardMonth).toBeUndefined();
    expect(next.months[OCT]!.fixed).toEqual([]);
    expect(cardCalc(next, OCT, 'card').charged).toBe(300);
    expect(unpaidCardPurchases(next, OCT, 'card').map((p) => p.tx.id)).toEqual(['b']);
  });

  it('fixed creates a ticked fixed expense on the card for each, linked to the purchase', () => {
    const s = state();
    const action = include(s, ['a', 'b'], 'fixed')!;
    expect(action).toMatchObject({ type: 'card/include', fixedIds: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    const next = apply(s, action);
    expect(next.months[OCT]!.fixed).toMatchObject([
      { name: 'a', amount: 200, cur: 'DOP', paid: true, onCard: true, cardId: 'card', accountId: 'dr' },
      { name: 'b', amount: 10, cur: 'USD', paid: true, onCard: true, cardId: 'card' },
    ]);
    expect(find(next, 'a')).toMatchObject({ cardMonth: OCT, cardFixedId: next.months[OCT]!.fixed[0]!.id });
    expect(cardCalc(next, OCT, 'card').charged).toBeCloseTo(787.6, 2);
    // Applying it twice changes nothing more.
    expect(reduce(next, action).months[OCT]!.fixed).toHaveLength(2);
  });

  it('deleting the fixed row returns the purchase to unpaid', () => {
    const s = state();
    const next = apply(s, include(s, ['a'], 'fixed'));
    const fixedId = next.months[OCT]!.fixed[0]!.id;
    const back = reduce(next, { type: 'fixed/remove', id: fixedId });
    expect(find(back, 'a').cardMonth).toBeUndefined();
    expect(find(back, 'a').cardFixedId).toBeUndefined();
    expect(cardPurchases(back, OCT, 'card').find((p) => p.tx.id === 'a')!.status).toBe('unpaid');
  });

  it('deleting or moving the purchase takes its fixed row along', () => {
    const s = state();
    const next = apply(s, include(s, ['a'], 'fixed'));
    expect(reduce(next, { type: 'tx/remove', id: 'a' }).months[OCT]!.fixed).toEqual([]);
    const outside = { id: 'o', monthKey: OCT, date: '2026-10-03', name: 'a', desc: '', accountId: 'dr', amount: 200, cur: 'DOP' as const };
    expect(reduce(next, { type: 'tx/moveOutside', id: 'a', row: outside }).months[OCT]!.fixed).toEqual([]);
  });

  it('editing the purchase edits its fixed row; leaving the card method removes it', () => {
    const s = state();
    const next = apply(s, include(s, ['a'], 'fixed'));
    const edited = reduce(next, { type: 'tx/patch', id: 'a', patch: { amount: 250, desc: 'Renamed', cur: 'USD' } });
    expect(edited.months[OCT]!.fixed[0]).toMatchObject({ name: 'Renamed', amount: 250, cur: 'USD' });
    const debit = reduce(next, { type: 'tx/patch', id: 'a', patch: { method: 'Debit card' } });
    expect(debit.months[OCT]!.fixed).toEqual([]);
    expect(find(debit, 'a').cardMonth).toBeUndefined();
    // A note on an unrelated purchase touches nothing.
    expect(reduce(s, { type: 'tx/patch', id: 'a', patch: { notes: 'x' } }).months[OCT]!.fixed).toEqual([]);
  });

  it('removing the payment frees the old per-purchase links and the status goes back to "this month"', () => {
    const s = state();
    const included = apply(s, include(s, ['a'], 'history'));
    const paid = reduce(included, { type: 'card/pay', key: OCT, cardId: 'card', payment: { id: 'p1', date: '2026-10-20', accountId: 'dr', amount: 200 } });
    expect(cardPurchases(paid, OCT, 'card').find((p) => p.tx.id === 'a')!.status).toBe('paid');
    const back = apply(paid, cardUnpay(paid, OCT, 'card'));
    expect(cardPurchases(back, OCT, 'card').find((p) => p.tx.id === 'a')!.status).toBe('month');
  });
});
