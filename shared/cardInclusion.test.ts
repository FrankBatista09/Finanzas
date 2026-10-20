// A Credit-card purchase starts unpaid and only enters a card total when it is added to a month. What that changes in the
// card total, what is owed, the category breakdown, the statement panel's items and when a payment makes a purchase paid.

import { describe, expect, it } from 'vitest';
import { cardCalc, cardOwed, cardPurchases, cardStatementItems, completingPayment, monthCalc, purchaseMonth, unpaidCardPurchases } from './calc';
import { seedState } from './seed';
import type { AppState, CreditCard, FixedExpense, Transaction } from './types';

const SEP = '2026-09';
const OCT = '2026-10';
const visa: CreditCard = { id: 'visa', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: 13, dueDay: null, active: true, sort: 0 };

const tx = (id: string, monthKey: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id, monthKey, date, desc: id, place: '', cat: 'Food', method: 'Credit card', amount, cur: 'DOP', accountId: 'dr', notes: '', source: 'web', createdAt: null, cardId: 'visa', ...extra,
});
const fixedRow = (id: string, monthKey: string, extra: Partial<FixedExpense> = {}): FixedExpense => ({
  id, monthKey, name: id, day: '', amount: 100, cur: 'DOP', paid: true, accountId: 'dr', sort: 0, onCard: true, cardId: 'visa', ...extra,
});

/** Aug and Sep closed, Oct open, with only the given rows (the seed's own fixed expenses and transactions are removed). */
function stateWith(rows: { tx?: Transaction[]; fixed?: FixedExpense[]; payments?: Record<string, { id: string; date: string; amount: number }[]> }): AppState {
  const seed = seedState();
  const months = Object.fromEntries(
    Object.entries(seed.months).map(([key, m]) => [
      key,
      {
        ...m,
        tx: (rows.tx ?? []).filter((t) => t.monthKey === key),
        fixed: (rows.fixed ?? []).filter((f) => f.monthKey === key),
        cards: rows.payments?.[key] ? [{ cardId: 'visa', other: 0, payments: rows.payments[key]!.map((p) => ({ ...p, accountId: 'dr' })) }] : undefined,
      },
    ]),
  );
  return { ...seed, months, cards: [visa] };
}

describe('the card total', () => {
  it('leaves out an unpaid purchase and counts one added to the month', () => {
    const state = stateWith({ tx: [tx('unpaid', OCT, '2026-10-02', 100, { cardMonth: null }), tx('added', OCT, '2026-10-03', 50, { cardMonth: OCT })] });
    const c = cardCalc(state, OCT, 'visa');
    expect(c.charged).toBe(50);
    expect(c.total).toBe(50);
  });

  it('counts a purchase in the month it was added to, not in the sheet it lives in', () => {
    const state = stateWith({ tx: [tx('sep', SEP, '2026-09-20', 70, { cardMonth: OCT })] });
    expect(cardCalc(state, SEP, 'visa').charged).toBe(0);
    expect(cardCalc(state, OCT, 'visa').charged).toBe(70);
  });

  it('feeds the pending fixed of the month: only the added purchases are in it', () => {
    const before = monthCalc(stateWith({ tx: [tx('a', OCT, '2026-10-02', 100, { cardMonth: null })] }), OCT);
    const after = monthCalc(stateWith({ tx: [tx('a', OCT, '2026-10-02', 100, { cardMonth: OCT })] }), OCT);
    expect(after.pending - before.pending).toBe(100);
    expect(after.used).toBe(before.used);
  });
});

describe('what is owed', () => {
  it('is what is left of the total plus every unpaid purchase, including older months', () => {
    const state = stateWith({
      tx: [tx('old', SEP, '2026-09-05', 30, { cardMonth: null }), tx('unpaid', OCT, '2026-10-02', 100, { cardMonth: null }), tx('added', OCT, '2026-10-03', 50, { cardMonth: OCT })],
      payments: { [OCT]: [{ id: 'p1', date: '2026-10-09', amount: 20 }] },
    });
    expect(cardCalc(state, OCT, 'visa').remainder).toBe(30);
    expect(cardOwed(state, OCT, 'visa')).toBe(30 + 130);
    // Seen from September only September's unpaid purchase counts.
    expect(cardOwed(state, SEP, 'visa')).toBe(30);
  });

  it('carries unpaid purchases over by itself, with nothing stored', () => {
    const state = stateWith({ tx: [tx('old', SEP, '2026-09-05', 30, { cardMonth: null })] });
    expect(unpaidCardPurchases(state, OCT, 'visa').map((p) => p.tx.id)).toEqual(['old']);
    expect(cardCalc(state, OCT, 'visa').previous).toBe(0);
  });

  it('is never negative when the card is in credit', () => {
    const state = stateWith({ tx: [tx('added', OCT, '2026-10-03', 50, { cardMonth: OCT })], payments: { [OCT]: [{ id: 'p1', date: '2026-10-09', amount: 50 }] } });
    expect(cardOwed(state, OCT, 'visa')).toBe(0);
  });
});

describe('a purchase added as a fixed expense', () => {
  const linked = () =>
    stateWith({ tx: [tx('t', OCT, '2026-10-02', 100, { cardMonth: OCT, cardFixedId: 'f' })], fixed: [fixedRow('f', OCT, { name: 't' })] });

  it('is in the card total once, through the fixed row', () => {
    expect(cardCalc(linked(), OCT, 'visa').charged).toBe(100);
    expect(cardCalc(linked(), OCT, 'visa').total).toBe(100);
  });

  it('is in the categories once, as the purchase, and not as a fixed expense', () => {
    const asHistory = monthCalc(stateWith({ tx: [tx('t', OCT, '2026-10-02', 100, { cardMonth: OCT })] }), OCT);
    const asFixed = monthCalc(linked(), OCT);
    expect(asFixed.categories).toEqual(asHistory.categories);
    expect(asFixed.categories.find((c) => c.name === 'Food')?.value).toBe(100);
    expect(asFixed.categories.find((c) => c.fixed)).toBeUndefined();
    // A fixed row that stands for nothing does count as a fixed expense.
    const plain = monthCalc(stateWith({ fixed: [fixedRow('f', OCT)] }), OCT);
    expect(plain.categories.find((c) => c.fixed)?.value).toBe(100);
  });

  it('goes back to unpaid when the fixed row is deleted', () => {
    const state = linked();
    const gone = { ...state, months: { ...state.months, [OCT]: { ...state.months[OCT]!, fixed: [] } } };
    expect(purchaseMonth(gone, gone.months[OCT]!.tx[0]!)).toBeNull();
    expect(cardCalc(gone, OCT, 'visa').total).toBe(0);
    expect(cardOwed(gone, OCT, 'visa')).toBe(100);
    expect(cardPurchases(gone, OCT, 'visa')[0]!.status).toBe('unpaid');
  });
});

describe('paying makes the purchases of the month paid', () => {
  const base = (payments: { id: string; date: string; amount: number }[]) =>
    stateWith({
      tx: [tx('a', OCT, '2026-10-02', 100, { cardMonth: OCT }), tx('b', OCT, '2026-10-03', 50, { cardMonth: OCT }), tx('late', OCT, '2026-10-04', 5, { cardMonth: null })],
      payments: { [OCT]: payments },
    });
  const status = (state: AppState) => Object.fromEntries(cardPurchases(state, OCT, 'visa').map((p) => [p.tx.id, p.status]));

  it('stay "this month" while something is left to pay', () => {
    expect(status(base([]))).toEqual({ a: 'month', b: 'month', late: 'unpaid' });
    expect(status(base([{ id: 'p1', date: '2026-10-09', amount: 100 }]))).toEqual({ a: 'month', b: 'month', late: 'unpaid' });
  });

  it('become paid, with the date of the payment that completed it', () => {
    const state = base([
      { id: 'p1', date: '2026-10-09', amount: 100 },
      { id: 'p2', date: '2026-10-15', amount: 50 },
    ]);
    expect(status(state)).toEqual({ a: 'paid', b: 'paid', late: 'unpaid' });
    expect(cardPurchases(state, OCT, 'visa')[0]!.payment).toEqual({ id: 'p2', date: '2026-10-15', accountId: 'dr', key: OCT });
    expect(completingPayment(state, OCT, 'visa')?.id).toBe('p2');
  });

  it('accept half a cent of slack, and a payment that overshoots completes it', () => {
    expect(status(base([{ id: 'p1', date: '2026-10-09', amount: 149.996 }])).a).toBe('paid');
    expect(completingPayment(base([{ id: 'p1', date: '2026-10-09', amount: 150 }]), OCT, 'visa')?.id).toBe('p1');
  });

  it('return to "this month" when the payment is removed', () => {
    const paid = base([{ id: 'p1', date: '2026-10-09', amount: 150 }]);
    expect(status(paid).a).toBe('paid');
    const removed = { ...paid, months: { ...paid.months, [OCT]: { ...paid.months[OCT]!, cards: [{ cardId: 'visa', other: 0, payments: [] }] } } };
    expect(status(removed).a).toBe('month');
  });

  it('a new purchase added after the month was fully paid makes it "this month" again', () => {
    const paid = base([{ id: 'p1', date: '2026-10-09', amount: 150 }]);
    const more = { ...paid, months: { ...paid.months, [OCT]: { ...paid.months[OCT]!, tx: paid.months[OCT]!.tx.map((t) => (t.id === 'late' ? { ...t, cardMonth: OCT } : t)) } } };
    expect(status(more)).toEqual({ a: 'month', b: 'month', late: 'month' });
  });

  it('an old link to a payment that still exists keeps the purchase paid', () => {
    const state = stateWith({ tx: [tx('a', OCT, '2026-10-02', 100, { cardMonth: OCT, cardPaymentId: 'p1' })], payments: { [OCT]: [{ id: 'p1', date: '2026-10-09', amount: 10 }] } });
    expect(status(state).a).toBe('paid');
  });
});

describe('cardStatementItems', () => {
  const state = () =>
    stateWith({
      tx: [
        tx('unpaid', OCT, '2026-10-02', 100, { cardMonth: null }),
        tx('added', OCT, '2026-10-14', 50, { cardMonth: OCT }),
        tx('stand', OCT, '2026-10-05', 25, { cardMonth: OCT, cardFixedId: 'standin' }),
        tx('debit', OCT, '2026-10-06', 9, { method: 'Debit card' }),
        tx('usd', OCT, '2026-10-07', 10, { cur: 'USD', cardMonth: null }),
      ],
      fixed: [
        fixedRow('ticked', OCT, { day: '5' }),
        fixedRow('late', OCT, { day: '20', paid: false }),
        fixedRow('nodate', OCT, { day: '' }),
        fixedRow('standin', OCT, { name: 'stand', amount: 25 }),
        fixedRow('account', OCT, { onCard: false, cardId: undefined }),
      ],
    });

  it('lists the card transactions and on-card fixed expenses, never the stand-in row nor other methods', () => {
    const ids = cardStatementItems(state(), OCT, 'visa').map((i) => `${i.kind}:${i.id}`);
    expect(ids.sort()).toEqual(['fixed:late', 'fixed:nodate', 'fixed:ticked', 'tx:added', 'tx:stand', 'tx:unpaid', 'tx:usd']);
  });

  it('gives each item its statement, status and amount in the card currency', () => {
    const by = Object.fromEntries(cardStatementItems(state(), OCT, 'visa').map((i) => [i.id, i]));
    expect(by.unpaid).toMatchObject({ statement: '2026-10-13', status: 'unpaid', converted: 100 });
    expect(by.added).toMatchObject({ statement: '2026-11-13', status: 'month', includedIn: OCT });
    expect(by.usd!.converted).toBeGreaterThan(10);
    expect(by.usd!.cur).toBe('USD');
    // Fixed expenses: the day decides the statement; ticked is in the month, unticked is unpaid.
    expect(by.ticked).toMatchObject({ date: '2026-10-05', statement: '2026-10-13', status: 'month' });
    expect(by.late).toMatchObject({ date: '2026-10-20', statement: '2026-11-13', status: 'unpaid' });
    expect(by.nodate).toMatchObject({ date: null, statement: '2026-10-13' });
  });

  it('has no statement without a cutoff day', () => {
    const s = state();
    const none = { ...s, cards: [{ ...visa, cutoffDay: null }] };
    expect(cardStatementItems(none, OCT, 'visa').every((i) => i.statement === null)).toBe(true);
  });

  it('takes the months up to the viewed one', () => {
    const s = stateWith({ tx: [tx('sep', SEP, '2026-09-20', 10, { cardMonth: null })], fixed: [fixedRow('f', SEP)] });
    expect(cardStatementItems(s, SEP, 'visa').map((i) => i.id).sort()).toEqual(['f', 'sep']);
    expect(cardStatementItems(s, '2026-08', 'visa')).toEqual([]);
    expect(cardStatementItems(s, OCT, 'nope')).toEqual([]);
  });
});
