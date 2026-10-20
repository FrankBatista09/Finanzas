// Paying chosen credit card purchases in the reducers: the rules the server also enforces, the links on the
// purchases (also in an earlier month) and what removing the payment does to them.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, monthCalc, unsettledCardPurchases } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, CreditCard, Transaction } from '../../shared/types';
import { cardPurchasesPayment, cardUnpay, cardUnpayOne, reduce } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});

/** September (closed) has purchase `s1` of 100; October has `a` 200 and `b` 10 USD (587.60 DOP), and a debit one. */
function state(): AppState {
  const seed = seedState();
  const byMonth: Record<string, Transaction[]> = {
    '2026-09': [tx('s1', '2026-09', '2026-09-05', 100)],
    [OCT]: [tx('a', OCT, '2026-10-03', 200), tx('b', OCT, '2026-10-04', 10, { cur: 'USD' }), tx('d', OCT, '2026-10-05', 40, { method: 'Debit card' })],
  };
  return { ...seed, months: Object.fromEntries(Object.entries(seed.months).map(([k, m]) => [k, { ...m, tx: byMonth[k] ?? [] }])), cards: [CARD] };
}

const apply = (s: AppState, action: Action | null): AppState => (action ? reduce(s, action) : s);
const pay = (s: AppState, ids: string[], accountId = 'dr') => cardPurchasesPayment(s, OCT, 'card', ids, accountId, 'p1', '2026-10-20');
const ids = (s: AppState) => unsettledCardPurchases(s, OCT, 'card').map((p) => p.tx.id);
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

describe('cardPurchasesPayment', () => {
  it('adds one payment worth the sum, links the purchases (also from an earlier month) and charges the account and the budget', () => {
    const s = state();
    const paid = apply(s, pay(s, ['s1', 'a']));
    expect(paid.months[OCT]!.cards![0]!.payments).toEqual([{ id: 'p1', date: '2026-10-20', accountId: 'dr', amount: 300 }]);
    expect(paid.months['2026-09']!.tx[0]!.cardPaymentId).toBe('p1');
    expect(paid.months[OCT]!.tx.find((t) => t.id === 'a')!.cardPaymentId).toBe('p1');
    expect(paid.months[OCT]!.tx.find((t) => t.id === 'b')).not.toHaveProperty('cardPaymentId');
    expect(ids(paid)).toEqual(['b']);
    expect(cardCalc(paid, OCT, 'card').remainder).toBeCloseTo(cardCalc(s, OCT, 'card').remainder - 300, 6);
    expect(bal(paid, 'dr')).toBeCloseTo(bal(s, 'dr') - 300, 6);
    expect(monthCalc(paid, OCT).used).toBeCloseTo(monthCalc(s, OCT).used + 300, 6);
  });

  it('converts a purchase in another currency into the card currency', () => {
    const s = state();
    expect(pay(s, ['b'])).toMatchObject({ payment: { amount: 587.6 } });
  });

  it('is not allowed for an empty or repeated selection, a purchase already paid, of another kind or unknown, or a bad account or month', () => {
    const s = state();
    expect(pay(s, [])).toBeNull();
    expect(pay(s, ['a', 'a'])).toBeNull();
    expect(pay(s, ['d'])).toBeNull();
    expect(pay(s, ['nope'])).toBeNull();
    expect(pay(s, ['a'], 'nope')).toBeNull();
    expect(cardPurchasesPayment(s, '2026-09', 'card', ['s1'], 'dr', 'p1', '2026-09-20')).toBeNull();
    expect(cardPurchasesPayment(s, OCT, 'nope', ['a'], 'dr', 'p1', '2026-10-20')).toBeNull();
    const paid = apply(s, pay(s, ['a']));
    expect(pay(paid, ['a', 'b'])).toBeNull();
  });

  it('refuses a sum above what is left', () => {
    const s = state();
    const half = apply(s, cardPurchasesPayment(s, OCT, 'card', ['s1'], 'dr', 'p0', '2026-10-20'));
    // Visa owes 887.60; after paying the 100 and a free 500 only 287.60 is left and b (587.60) does not fit.
    const rest = reduce(half, { type: 'card/pay', key: OCT, cardId: 'card', payment: { id: 'free', date: '2026-10-21', accountId: 'dr', amount: 500 } });
    expect(pay(rest, ['b'])).toBeNull();
    expect(pay(rest, ['a'])).not.toBeNull();
  });

  it('removing the payment frees its purchases, one at a time or all of them', () => {
    const s = state();
    const one = apply(s, pay(s, ['s1', 'a']));
    const second = apply(one, cardPurchasesPayment(one, OCT, 'card', ['b'], 'dr', 'p2', '2026-10-21'));
    const freed = apply(second, cardUnpayOne(second, OCT, 'card', 'p1'));
    expect(ids(freed)).toEqual(['s1', 'a']);
    expect(freed.months[OCT]!.tx.find((t) => t.id === 'b')!.cardPaymentId).toBe('p2');
    expect(ids(apply(second, cardUnpay(second, OCT, 'card')))).toEqual(['s1', 'a', 'b']);
  });
});
