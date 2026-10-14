// Cashback on a credit card: a credit that reduces what is owed (total, remainder, pending) and nothing else.

import { describe, expect, it } from 'vitest';
import { balances, cardCalc, monthCalc } from './calc';
import { seedState } from './seed';
import type { AppState, MonthCard } from './types';

const SEP = '2026-09';
const OCT = '2026-10';

/** The sample state with a card (cashback flag as given) and what each month stored for it. */
function withCard(flag: boolean, stored: Partial<Record<string, MonthCard>>): AppState {
  const s = seedState();
  s.cards = [{ id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, ...(flag ? { cashback: true } : {}), sort: 0 }];
  for (const [key, card] of Object.entries(stored)) s.months[key] = { ...s.months[key]!, cards: [card!] };
  return s;
}

describe('cardCalc with cashback', () => {
  it('is deducted from the total, the remainder and the pending fixed amount', () => {
    const without = withCard(true, { [OCT]: { cardId: 'card', other: 1000, payments: [] } });
    const withCb = withCard(true, { [OCT]: { cardId: 'card', other: 1000, cashback: 150, payments: [] } });
    const a = cardCalc(without, OCT, 'card');
    const b = cardCalc(withCb, OCT, 'card');
    expect(a.cashback).toBe(0);
    expect(b).toMatchObject({ other: 1000, cashback: 150, total: 850, remainder: 850 });
    expect(monthCalc(withCb, OCT).pending).toBeCloseTo(monthCalc(without, OCT).pending - 150, 6);
  });

  it('does not move income, balances, used or available', () => {
    const without = withCard(true, { [OCT]: { cardId: 'card', other: 1000, payments: [] } });
    const withCb = withCard(true, { [OCT]: { cardId: 'card', other: 1000, cashback: 150, payments: [] } });
    const a = monthCalc(without, OCT);
    const b = monthCalc(withCb, OCT);
    expect(b.used).toBe(a.used);
    expect(b.avail).toBe(a.avail);
    expect(balances(withCb, OCT).accounts.map((x) => x.balance)).toEqual(balances(without, OCT).accounts.map((x) => x.balance));
  });

  it('carries the remainder after the deduction to the next month', () => {
    const s = withCard(true, { [SEP]: { cardId: 'card', other: 500, cashback: 100, payments: [] } });
    expect(cardCalc(s, SEP, 'card').remainder).toBe(400);
    expect(cardCalc(s, OCT, 'card')).toMatchObject({ previous: 400, total: 400 });
  });

  it('a payment applies on top of it', () => {
    const s = withCard(true, { [OCT]: { cardId: 'card', other: 1000, cashback: 100, payments: [{ id: 'p', date: '2026-10-20', accountId: 'dr', amount: 300 }] } });
    expect(cardCalc(s, OCT, 'card')).toMatchObject({ total: 900, paid: 300, remainder: 600 });
  });

  it('more cashback than owed leaves a plain negative total (a credit in favor)', () => {
    const s = withCard(true, { [OCT]: { cardId: 'card', other: 100, cashback: 250, payments: [] } });
    expect(cardCalc(s, OCT, 'card')).toMatchObject({ total: -150, remainder: -150 });
  });

  it('an amount stored while the card has no cashback flag is ignored', () => {
    const s = withCard(false, { [OCT]: { cardId: 'card', other: 1000, cashback: 150, payments: [] } });
    expect(cardCalc(s, OCT, 'card')).toMatchObject({ cashback: 0, total: 1000 });
  });
});
