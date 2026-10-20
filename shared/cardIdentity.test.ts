// Migration 0016 must not change any figure: before it every Credit-card purchase counted in the card total of its own
// month, and the backfill puts each one there (card_month = month_key). The expected numbers below are the ones the old
// rules give, worked out by hand for a multi-month example with two cards, partial payments, cashback and on-card fixed
// expenses. Rates: 1 USD = 50 DOP everywhere.

import { describe, expect, it } from 'vitest';
import { cardCalc, monthCalc } from './calc';
import type { AppState, BudgetEntry, CreditCard, FixedExpense, Month, MonthCard, Transaction } from './types';

const A: CreditCard = { id: 'a', name: 'A', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, cashback: true, sort: 0 };
const B: CreditCard = { id: 'b', name: 'B', bank: null, last4: null, cur: 'USD', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 1 };

const tx = (id: string, monthKey: string, day: number, cat: string, method: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date: `${monthKey}-${String(day).padStart(2, '0')}`, desc: id, place: '', cat, method, amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, ...extra,
});
const fx = (id: string, monthKey: string, amount: number, extra: Partial<FixedExpense> = {}): FixedExpense => ({
  id, monthKey, name: id, day: '', amount, cur: 'DOP', paid: true, accountId: 'dr', sort: 0, ...extra,
});
const pay = (id: string, date: string, amount: number) => ({ id, date, accountId: 'dr', amount });
const log = (key: string): BudgetEntry => ({ id: `b-${key}`, date: `${key}-01`, accountId: 'dr', amount: 10000, kind: 'initial', note: '' });

function month(key: string, rest: Partial<Month> & { cards?: MonthCard[] }): Month {
  return { key, closed: key !== '2026-10', closedAt: null, budgetLog: [log(key)], budgets: { dr: 10000 }, rates: [], fixed: [], transfers: [], tx: [], ...rest };
}

/** The data as it was before 0016: no purchase has a card_month. */
function legacy(): AppState {
  return {
    months: {
      '2026-08': month('2026-08', {
        rates: [{ from: 'USD', to: 'DOP', rate: 50, date: '2026-08-01' }],
        tx: [
          tx('a1', '2026-08', 3, 'Food', 'Credit card', 1000, { cardId: 'a' }),
          tx('a2', '2026-08', 4, 'Food', 'Credit card', 20, { cardId: 'a', cur: 'USD' }),
          tx('b1', '2026-08', 5, 'Shopping', 'Credit card', 8, { cardId: 'b', cur: 'USD' }),
        ],
        fixed: [fx('netflix', '2026-08', 300, { onCard: true, cardId: 'a' }), fx('gym', '2026-08', 400, { onCard: true, cardId: 'a', paid: false })],
        cards: [{ cardId: 'a', other: 100, cashback: 50, payments: [pay('p1', '2026-08-20', 700)] }],
      }),
      '2026-09': month('2026-09', {
        tx: [
          // No card named: it goes to the first active one, A.
          tx('a3', '2026-09', 6, 'Food', 'Credit card', 500),
          tx('b2', '2026-09', 7, 'Shopping', 'Credit card', 30, { cardId: 'b', cur: 'USD' }),
          tx('b3', '2026-09', 8, 'Shopping', 'Credit card', 1500, { cardId: 'b' }),
          tx('d1', '2026-09', 9, 'Food', 'Debit card', 200),
        ],
        fixed: [fx('icloud', '2026-09', 10, { onCard: true, cardId: 'a', cur: 'USD' }), fx('spotify', '2026-09', 5, { onCard: true, cardId: 'b', cur: 'USD' })],
        cards: [
          { cardId: 'a', other: 0, cashback: 20, payments: [pay('p2', '2026-09-10', 1000), pay('p3', '2026-09-25', 650)] },
          { cardId: 'b', other: 0, payments: [pay('p4', '2026-09-12', 40)] },
        ],
      }),
      '2026-10': month('2026-10', {
        tx: [tx('a4', '2026-10', 2, 'Food', 'Credit card', 250, { cardId: 'a' }), tx('d2', '2026-10', 3, 'Transport', 'Debit card', 400)],
        fixed: [fx('rent', '2026-10', 1000)],
      }),
    },
    accounts: [{ id: 'dr', name: 'DR', currency: 'DOP', opening: 0, hidden: false, sort: 0 }],
    incomes: [],
    goals: [],
    contribs: [],
    cards: [A, B],
    mainCurrency: 'DOP',
    secondCurrency: 'USD',
    defaultAccountId: 'dr',
    defaultRate: 60,
    goldPrice: null,
    theme: null,
    language: 'en',
  };
}

/** What migration 0016 does: every Credit-card purchase is added to its own month. */
function backfilled(state: AppState): AppState {
  return {
    ...state,
    months: Object.fromEntries(
      Object.entries(state.months).map(([key, m]) => [key, { ...m, tx: m.tx.map((t) => (t.method === 'Credit card' ? { ...t, cardMonth: key } : t)) }]),
    ),
  };
}

describe('card figures before and after migration 0016', () => {
  const after = backfilled(legacy());
  const card = (key: string, id: string) => {
    const c = cardCalc(after, key, id);
    return { previous: c.previous, other: c.other, charged: c.charged, cashback: c.cashback, total: c.total, paid: c.paid, remainder: c.remainder };
  };

  it('card A, in DOP with cashback and partial payments', () => {
    expect(card('2026-08', 'a')).toEqual({ previous: 0, other: 100, charged: 2300, cashback: 50, total: 2350, paid: 700, remainder: 1650 });
    expect(card('2026-09', 'a')).toEqual({ previous: 1650, other: 0, charged: 1000, cashback: 20, total: 2630, paid: 1650, remainder: 980 });
    expect(card('2026-10', 'a')).toEqual({ previous: 980, other: 0, charged: 250, cashback: 0, total: 1230, paid: 0, remainder: 1230 });
  });

  it('card B, in USD, with purchases in two currencies', () => {
    const near = (got: ReturnType<typeof card>, want: ReturnType<typeof card>) => {
      for (const k of Object.keys(want) as (keyof typeof want)[]) expect(got[k]).toBeCloseTo(want[k], 6);
    };
    near(card('2026-08', 'b'), { previous: 0, other: 0, charged: 8, cashback: 0, total: 8, paid: 0, remainder: 8 });
    near(card('2026-09', 'b'), { previous: 8, other: 0, charged: 65, cashback: 0, total: 73, paid: 40, remainder: 33 });
    near(card('2026-10', 'b'), { previous: 33, other: 0, charged: 0, cashback: 0, total: 33, paid: 0, remainder: 33 });
  });

  it('pending fixed, used, available and the categories of each month', () => {
    const figures = (key: string) => {
      const c = monthCalc(after, key);
      return { fixedAll: c.fixedAll, fixedPaid: c.fixedPaid, pending: c.pending, used: c.used, avail: c.avail, after: c.after, categories: c.categories.map((x) => [x.name, x.value]) };
    };
    const close = (got: ReturnType<typeof figures>, want: ReturnType<typeof figures>) => {
      for (const k of ['fixedAll', 'fixedPaid', 'pending', 'used', 'avail', 'after'] as const) expect(got[k]).toBeCloseTo(want[k], 6);
      expect(got.categories.map(([n]) => n)).toEqual(want.categories.map(([n]) => n));
      got.categories.forEach(([, v], i) => expect(v as number).toBeCloseTo(want.categories[i]![1] as number, 6));
    };
    close(figures('2026-08'),
    // The unticked on-card 'gym' (400) is an ordinary pending fixed expense.
    { fixedAll: 3150, fixedPaid: 700, pending: 2450, used: 700, avail: 9300, after: 6850, categories: [['Fixed expenses', 300], ['Food', 2000], ['Shopping', 400]] });
    close(figures('2026-09'), { fixedAll: 6280, fixedPaid: 3650, pending: 2630, used: 3850, avail: 6150, after: 3520, categories: [['Fixed expenses', 750], ['Shopping', 3000], ['Food', 700]] });
    close(figures('2026-10'), { fixedAll: 3880, fixedPaid: 1000, pending: 2880, used: 1400, avail: 8600, after: 5720, categories: [['Fixed expenses', 1000], ['Transport', 400], ['Food', 250]] });
  });

  it('without the backfill the totals would change: that is what the migration prevents', () => {
    expect(cardCalc(legacy(), '2026-08', 'a').total).toBe(350);
    expect(cardCalc(after, '2026-08', 'a').total).toBe(2350);
  });
});
