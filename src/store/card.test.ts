// Credit card in the reducers: other charges, paying and undoing, the rules the server also enforces,
// the "on card" fixed expense and the paying account as an account in use.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, monthCalc } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import type { AppState, CreditCard } from '../../shared/types';
import { accountInUse, cardOtherChange, cardPayment, cardUnpay, cardUnpayOne, newFixed, reduce, snapToTotal, targetOf } from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Credit card', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
/** The sample state with the usual single credit card. */
const seed = (): AppState => ({ ...seedState(), cards: [CARD] });

const apply = (state: AppState, action: Action | null): AppState => (action ? reduce(state, action) : state);
const DAY = '2026-10-20';
/** A payment on October's credit card with a fixed id. */
const pay = (s: AppState, amount: number, accountId: string, id = 'p1') => cardPayment(s, OCT, 'card', amount, accountId, id, DAY);
const bal = (s: AppState, id: string) => balances(s, OCT).accounts.find((a) => a.account.id === id)!.balance;

/** October with 1,000 in other charges: the credit card's total is 1,000. */
const owing = (): AppState => apply(seed(), cardOtherChange(seed(), OCT, 'card', 1000));

describe('other charges', () => {
  it('raise the total; a closed month, a nonexistent month or a negative amount is not accepted; 0 leaves it as it was', () => {
    const s = seed();
    expect(cardCalc(owing(), OCT, 'card').total).toBe(1000);
    expect(cardOtherChange(s, '2026-09', 'card', 5)).toBeNull();
    expect(cardOtherChange(s, '2030-01', 'card', 5)).toBeNull();
    expect(cardOtherChange(s, OCT, 'card', -1)).toBeNull();
    expect(cardOtherChange(s, OCT, 'card', NaN)).toBeNull();
    const cleared = apply(owing(), cardOtherChange(owing(), OCT, 'card', 0));
    expect('cards' in cleared.months[OCT]!).toBe(false);
  });

  it('applying the same action twice gives the same result as once', () => {
    const action = cardOtherChange(seed(), OCT, 'card', 40)!;
    const once = reduce(seed(), action);
    expect(reduce(once, action)).toBe(once);
  });
});

describe('paying the credit card', () => {
  it('stores the amount and the account; only then does the balance drop; undoing gives it back', () => {
    const s = owing();
    const before = bal(s, 'dr');
    const paid = apply(s, pay(s, 400, 'dr'));
    expect(paid.months[OCT]!.cards).toEqual([{ cardId: 'card', other: 1000, payments: [{ id: 'p1', date: DAY, accountId: 'dr', amount: 400 }] }]);
    expect(bal(paid, 'dr')).toBeCloseTo(before - 400, 9);
    expect(monthCalc(paid, OCT).used).toBeCloseTo(monthCalc(s, OCT).used + 400, 9);
    expect(reduce(paid, pay(s, 400, 'dr')!)).not.toBe(paid); // another id would be another payment: the same id is not repeated on the server

    const undone = apply(paid, cardUnpay(paid, OCT, 'card'));
    expect(undone.months[OCT]!.cards).toEqual([{ cardId: 'card', other: 1000, payments: [] }]);
    expect(bal(undone, 'dr')).toBe(before);
    expect(cardUnpay(undone, OCT, 'card')).toBeNull();
  });

  it('the amount must be > 0 and not exceed the total; the account, a money account that exists; the month, open', () => {
    const s = owing();
    expect(pay(s, 0, 'dr')).toBeNull();
    expect(pay(s, -5, 'dr')).toBeNull();
    expect(pay(s, 1000.01, 'dr')).toBeNull();
    expect(pay(s, 1000, 'dr')).toMatchObject({ payment: { amount: 1000 } });
    expect(pay(s, 10, 'nope')).toBeNull();
    expect(cardPayment(s, '2026-09', 'card', 10, 'dr', 'p1', DAY)).toBeNull();
    const gold = { ...s, accounts: [...s.accounts, { id: 'gold', name: 'Gold', currency: 'XAU' as const, opening: 1, hidden: false, sort: 9 }] };
    expect(pay(gold, 10, 'gold')).toBeNull();
    // With nothing charged there is nothing to pay.
    expect(pay(seed(), 1, 'dr')).toBeNull();
  });

  it('the total shown with two decimals counts as the total: it leaves no remainder of cents', () => {
    expect(snapToTotal(100, 100.004)).toBe(100.004);
    expect(snapToTotal(99.99, 100.004)).toBe(99.99);
    // 100.006 shows as "100.01": confirming that pays the exact total and does not reject it for going over.
    const s = apply(seed(), cardOtherChange(seed(), OCT, 'card', 100.006));
    expect(pay(s, 100.01, 'dr')).toMatchObject({ payment: { amount: 100.006 } });
    expect(cardCalc(apply(s, pay(s, 100.01, 'dr')), OCT, 'card').remainder).toBe(0);
    expect(pay(s, 100.02, 'dr')).toBeNull();
  });

  it('credit card actions are grouped by month', () => {
    expect(targetOf({ type: 'card/pay', key: OCT, cardId: 'card', payment: { id: 'p1', date: DAY, accountId: 'dr', amount: 1 } })).toBe(`card:${OCT}`);
    expect(targetOf({ type: 'card/unpay', key: OCT, cardId: 'card' })).toBe(`card:${OCT}`);
  });
});

describe('several credit card payments', () => {
  it('they add up, each one lowers the balance of its account, and what is left limits the next one', () => {
    const s = owing();
    const base = { dr: bal(s, 'dr'), us: bal(s, 'us') };
    const one = apply(s, pay(s, 300, 'dr', 'a'));
    const two = apply(one, pay(one, 587.6, 'us', 'b'));
    expect(cardCalc(two, OCT, 'card').paid).toBeCloseTo(887.6, 9);
    expect(cardCalc(two, OCT, 'card').remainder).toBeCloseTo(112.4, 9);
    expect(bal(two, 'dr')).toBeCloseTo(base.dr - 300, 9);
    expect(bal(two, 'us')).toBeCloseTo(base.us - 587.6 / 58.76, 9);
    expect(pay(two, 112.5, 'dr', 'c')).toBeNull();
    expect(pay(two, 112.4, 'dr', 'c')).not.toBeNull();
    // Once fully paid, it cannot be paid any further.
    const full = apply(two, pay(two, 112.4, 'dr', 'c'));
    expect(pay(full, 1, 'dr', 'd')).toBeNull();
  });

  it('removing one gives back only its part; removing all leaves the month without a credit card if there is nothing else', () => {
    const s = apply(seed(), cardOtherChange(seed(), OCT, 'card', 1000));
    const one = apply(s, pay(s, 300, 'dr', 'a'));
    const two = apply(one, pay(one, 200, 'us', 'b'));
    const less = apply(two, cardUnpayOne(two, OCT, 'card', 'a'));
    expect(less.months[OCT]!.cards![0]!.payments.map((p) => p.id)).toEqual(['b']);
    expect(cardUnpayOne(less, OCT, 'card', 'a')).toBeNull();
    expect(cardUnpayOne(less, '2026-09', 'card', 'b')).toBeNull();
    expect(apply(two, cardUnpay(two, OCT, 'card')).months[OCT]!.cards).toEqual([{ cardId: 'card', other: 1000, payments: [] }]);
    // With no other charges, removing the only payment leaves the month without `cards`, the way the server sends it.
    const only = apply(seed(), cardOtherChange(seed(), OCT, 'card', 1000));
    const paid = apply(only, pay(only, 50, 'dr', 'z'));
    const noOther = { ...paid, months: { ...paid.months, [OCT]: { ...paid.months[OCT]!, cards: [{ cardId: 'card', other: 0, payments: paid.months[OCT]!.cards![0]!.payments }] } } };
    expect('cards' in apply(noOther, cardUnpayOne(noOther, OCT, 'card', 'z')).months[OCT]!).toBe(false);
  });
});

describe('fixed expense on card and account in use', () => {
  it('newFixed only sets onCard when asked', () => {
    const s = seed();
    expect('onCard' in newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP' }, 'a')!).toBe(false);
    expect(newFixed(s, OCT, { name: 'Gym', amount: 5, cur: 'DOP', onCard: true }, 'a')).toMatchObject({ onCard: true, paid: false });
  });

  it('the account that paid the credit card is in use', () => {
    const s = owing();
    expect(accountInUse(s, 'us')).toBe(accountInUse(seed(), 'us'));
    const paid = apply(s, pay(s, 10, 'us'));
    expect(accountInUse(paid, 'us')).toBe(true);
  });
});
