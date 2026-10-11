// What the budget panel and the close dialog decide to show and send: the previous month's leftover, the budget
// history and the parts the next month starts with. No React: the numbers come from shared/calc.ts with the
// sample data (Aug and Sep closed, Oct open with a budget of 65,000 + 5,000).
//
// shared/calc.ts memoizes rates per state object: each test builds its own and does not touch it after calculating.

import { describe, expect, it } from 'vitest';
import { budgetSummary, leftoverFor, monthCalc } from '../../shared/calc';
import type { Leftover } from '../../shared/calc';
import { f2 } from '../../shared/format';
import { seedState, setBudgets } from '../../shared/seed';
import type { AppState, BudgetEntry, Income } from '../../shared/types';
import { createI18n } from '../i18n';
import {
  BUDGET_KIND,
  budgetHistoryRows,
  closeBudgetForm,
  closeFieldInvalid,
  closeRequest,
  extraDefaultAccount,
  extraDefaultDate,
  extraInput,
  extraProblem,
  leftoverView,
  newExtraForm,
  overrunLines,
  summaryRows,
} from './budgetModel';
import type { CloseBudgetField, CloseBudgetForm } from './budgetModel';

const entry = (over: Partial<BudgetEntry> & Pick<BudgetEntry, 'id' | 'amount' | 'kind'>): BudgetEntry => ({
  date: '2026-10-08',
  accountId: 'dr',
  note: '',
  ...over,
});

const income = (over: Partial<Income> & Pick<Income, 'id' | 'amount'>): Income => ({
  date: '2026-10-03',
  desc: 'Refund',
  accountId: 'dr',
  cur: 'DOP',
  budget: true,
  ...over,
});

/** The sample data with whatever `change` does to it, before calculating anything. */
function stateWith(change: (state: AppState) => void): AppState {
  const state = seedState();
  change(state);
  return state;
}

describe('leftoverView: the "Leftover from last month" line', () => {
  it('with no previous month nothing is shown', () => {
    const state = seedState();
    expect(leftoverFor(state, '2026-08')).toEqual({ previousKey: null, leftover: null, added: false });
    expect(leftoverView(leftoverFor(state, '2026-08'), false)).toBeNull();
    expect(leftoverView(leftoverFor(state, '2026-08'), true)).toBeNull();
  });

  it('offer: open month, something was left over and it has not been added yet', () => {
    const state = seedState();
    const view = leftoverView(leftoverFor(state, '2026-10'), false);
    // September: a budget of 70,000 − 66,636.54 used.
    expect(view).toEqual({ amount: monthCalc(state, '2026-09').avail, from: '2026-09', status: 'offer' });
    expect(f2(view!.amount)).toBe('3,363.46');
  });

  it('offer also with a negative leftover: the previous month went over and it can be subtracted', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-09']!, { dr: 60000 }));
    const view = leftoverView(leftoverFor(state, '2026-10'), false);
    expect(view).toMatchObject({ from: '2026-09', status: 'offer' });
    expect(f2(view!.amount)).toBe('-6,636.54');
  });

  it('added: the month already has its leftover movement', () => {
    const state = stateWith((s) => s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' })));
    const leftover = leftoverFor(state, '2026-10');
    expect(leftover.added).toBe(true);
    expect(leftoverView(leftover, false)).toMatchObject({ from: '2026-09', status: 'added' });
    // It stays added even if the month is closed later.
    expect(leftoverView(leftover, true)!.status).toBe('added');
  });

  it('plain: in a closed month, only the figure', () => {
    const state = seedState();
    // September (closed) shows what was left over from August, with no button.
    const view = leftoverView(leftoverFor(state, '2026-09'), true);
    expect(view).toEqual({ amount: monthCalc(state, '2026-08').avail, from: '2026-08', status: 'plain' });
  });

  it('plain: if 0 was left over (or something that is 0.00 with two decimals) there is nothing to add', () => {
    const of = (leftover: number): Leftover => ({ previousKey: '2026-09', leftover, added: false });
    expect(leftoverView(of(0), false)!.status).toBe('plain');
    expect(leftoverView(of(0.004), false)!.status).toBe('plain');
    expect(leftoverView(of(-0.004), false)!.status).toBe('plain');
    // One cent is already something.
    expect(leftoverView(of(0.01), false)!.status).toBe('offer');
    expect(leftoverView(of(-0.01), false)!.status).toBe('offer');
  });

  it('the previous month is the closest recorded one, even if it is not the calendar one', () => {
    const state = stateWith((s) => delete s.months['2026-09']);
    expect(leftoverView(leftoverFor(state, '2026-10'), false)).toMatchObject({ from: '2026-08', status: 'offer' });
  });
});

describe('budgetHistoryRows: the budget history', () => {
  it('sample data: the initial and the adjustment of October, with the running total', () => {
    const state = seedState();
    expect(budgetHistoryRows(state, '2026-10')).toEqual([
      {
        key: 'initial:seed-bg-2026-10-1',
        id: 'seed-bg-2026-10-1',
        date: '2026-10-01',
        kind: 'initial',
        kindKey: 'budgetKindInitial',
        account: 'DR account',
        amount: '65,000.00',
        currency: 'DOP',
        negative: false,
        total: '65,000.00',
        note: '',
        deletable: true,
      },
      {
        key: 'adjust:seed-bg-2026-10-2',
        id: 'seed-bg-2026-10-2',
        date: '2026-10-05',
        kind: 'adjust',
        kindKey: 'budgetKindExtra',
        account: 'DR account',
        amount: '5,000.00',
        currency: 'DOP',
        negative: false,
        total: '70,000.00',
        note: 'Car repair',
        deletable: true,
      },
    ]);
  });

  it('each kind of movement has its text, and they are the five in the dictionary', () => {
    expect(BUDGET_KIND).toEqual({
      initial: 'budgetKindInitial',
      adjust: 'budgetKindAdjust',
      leftover: 'budgetKindLeftover',
      income: 'budgetKindIncome',
      transfer: 'budgetKindTransfer',
    });
    const state = stateWith((s) => {
      // The transfer on the 2nd (1,500 USD at 58.76) marked to move budget: it shows up in two rows.
      s.months['2026-10']!.transfers[0]!.budget = true;
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
      s.incomes.push(income({ id: 'in-b', amount: 1000, date: '2026-10-09' }));
    });
    const rows = budgetHistoryRows(state, '2026-10');
    expect(rows.map((r) => [r.kind, r.kindKey])).toEqual([
      ['initial', 'budgetKindInitial'],
      ['transfer', 'budgetKindTransfer'],
      ['transfer', 'budgetKindTransfer'],
      ['adjust', 'budgetKindExtra'],
      ['leftover', 'budgetKindLeftover'],
      ['income', 'budgetKindIncome'],
    ]);
    const { t } = createI18n('es');
    expect(rows.map((r) => t(r.kindKey))).toEqual(['Inicial', 'Envío', 'Envío', 'Extra', 'Sobrante', 'Ingreso']);
    expect(rows.map((r) => createI18n('en').t(r.kindKey))[1]).toBe('Transfer');
    // What was sent, as a negative in the origin account, and what was received in the destination one; like an
    // income, it cannot be removed from the history. Each row has its own key: the id is the same.
    expect(rows[1]).toMatchObject({ key: expect.stringMatching(/:out$/), account: 'US account', amount: '-1,500.00', currency: 'USD', negative: true, note: 'Remitly', deletable: false });
    expect(rows[2]).toMatchObject({ key: expect.stringMatching(/:in$/), account: 'DR account', amount: '88,140.00', currency: 'DOP', negative: false, note: 'Remitly', deletable: false });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('amounts are in the currency of their account; the total, in the main one, and that of the last row is the month budget', () => {
    const state = stateWith((s) => {
      const month = s.months['2026-10']!;
      month.rates = [
        { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
        { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
      ];
      // A part in dollars, from the US account.
      month.budgetLog.push(entry({ id: 'bg-us', accountId: 'us', amount: 200, kind: 'initial', date: '2026-10-02' }));
      // An income in dollars that goes into the DR account: it raises its part in pesos, at the rate of its date (58).
      s.incomes.push(income({ id: 'in-usd', amount: 100, cur: 'USD', date: '2026-10-03', desc: 'Freelance' }));
      // And another in pesos that goes into the US account, already at the new rate (60).
      s.incomes.push(income({ id: 'in-dop', amount: 3000, cur: 'DOP', accountId: 'us', date: '2026-10-06', desc: 'Gift' }));
    });
    const rows = budgetHistoryRows(state, '2026-10');
    expect(rows.map((r) => [r.date, r.kind, r.account, r.amount, r.currency, r.note])).toEqual([
      ['2026-10-01', 'initial', 'DR account', '65,000.00', 'DOP', ''],
      ['2026-10-02', 'initial', 'US account', '200.00', 'USD', ''],
      ['2026-10-03', 'income', 'DR account', '5,800.00', 'DOP', 'Freelance'],
      ['2026-10-05', 'adjust', 'DR account', '5,000.00', 'DOP', 'Car repair'],
      ['2026-10-06', 'income', 'US account', '50.00', 'USD', 'Gift'],
    ]);
    // What is in dollars adds to the total at the month's last rate (60): 200 USD = 12,000 and 50 USD = 3,000.
    expect(rows.map((r) => r.total)).toEqual(['65,000.00', '77,000.00', '82,800.00', '87,800.00', '90,800.00']);
    expect(rows.at(-1)!.total).toBe(f2(monthCalc(state, '2026-10').budget));
  });

  it('the total of the last row is the month budget, also in the sample months and with another main currency', () => {
    for (const key of ['2026-08', '2026-09', '2026-10']) {
      const state = seedState();
      expect(budgetHistoryRows(state, key).at(-1)!.total, key).toBe(f2(monthCalc(state, key).budget));
    }
    const usd = stateWith((s) => {
      s.mainCurrency = 'USD';
      s.secondCurrency = 'DOP';
    });
    const rows = budgetHistoryRows(usd, '2026-10');
    // The amounts stay in pesos (the account); the total, in dollars: 70,000 / 58.76.
    expect(rows.map((r) => `${r.amount} ${r.currency}`)).toEqual(['65,000.00 DOP', '5,000.00 DOP']);
    expect(rows.at(-1)!.total).toBe('1,191.29');
    expect(rows.at(-1)!.total).toBe(f2(monthCalc(usd, '2026-10').budget));
  });

  it('a movement that subtracts carries its sign and is flagged as negative', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(
        entry({ id: 'bg-cut', amount: -2500.5, kind: 'adjust', note: 'Less this month' }),
        entry({ id: 'bg-left', amount: -6636.54, kind: 'leftover', date: '2026-10-09' }),
      );
    });
    const rows = budgetHistoryRows(state, '2026-10').slice(2);
    expect(rows.map((r) => [r.kind, r.amount, r.negative, r.total])).toEqual([
      ['adjust', '-2,500.50', true, '67,499.50'],
      ['leftover', '-6,636.54', true, '60,862.96'],
    ]);
    expect(budgetHistoryRows(state, '2026-10').slice(0, 2).every((r) => !r.negative)).toBe(true);
  });

  it('on the same date the log movements go first, in their order, and then the incomes', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-first', amount: 1000, date: '2026-10-01' }));
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-same', amount: 10, kind: 'adjust', date: '2026-10-01' }));
    });
    expect(budgetHistoryRows(state, '2026-10').map((r) => r.id)).toEqual(['seed-bg-2026-10-1', 'bg-same', 'in-first', 'seed-bg-2026-10-2']);
  });

  it('a log movement of an open month is removed with ×; an income, never (it is removed or unchecked as an income)', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
      s.incomes.push(income({ id: 'in-b', amount: 1000, date: '2026-10-09' }));
    });
    expect(budgetHistoryRows(state, '2026-10').map((r) => [r.kind, r.deletable])).toEqual([
      ['initial', true],
      ['adjust', true],
      ['leftover', true],
      ['income', false],
    ]);
  });

  it('a movement just added, still without a server id (local-…), cannot be removed yet', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(
        entry({ id: 'local-1', amount: 500, kind: 'adjust' }),
        // Only the prefix counts: a server id with "local" in the middle can be removed.
        entry({ id: 'bg-local-2', amount: 500, kind: 'adjust' }),
      );
    });
    expect(budgetHistoryRows(state, '2026-10').map((r) => [r.id, r.deletable])).toEqual([
      ['seed-bg-2026-10-1', true],
      ['seed-bg-2026-10-2', true],
      ['local-1', false],
      ['bg-local-2', true],
    ]);
  });

  it('in a closed month nothing is removed', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-sep', amount: 1000, date: '2026-09-10' }));
    });
    const rows = budgetHistoryRows(state, '2026-09');
    expect(rows.map((r) => [r.kind, r.amount, r.deletable])).toEqual([
      ['initial', '70,000.00', false],
      ['income', '1,000.00', false],
    ]);
    // The same month, reopened: the log one can be removed again.
    const reopened = stateWith((s) => {
      s.months['2026-09']!.closed = false;
    });
    expect(budgetHistoryRows(reopened, '2026-09').map((r) => r.deletable)).toEqual([true]);
  });

  it('an income without the checkbox, or from another month, is not part of the history', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-plain', amount: 1000, budget: false }), income({ id: 'in-nov', amount: 1000, date: '2026-11-02' }));
    });
    // The sample salaries do not raise the budget either.
    expect(budgetHistoryRows(state, '2026-10').map((r) => r.kind)).toEqual(['initial', 'adjust']);
  });

  it('a month with no log, or one that does not exist, gives an empty list', () => {
    const empty = stateWith((s) => setBudgets(s.months['2026-10']!, {}));
    expect(budgetHistoryRows(empty, '2026-10')).toEqual([]);
    expect(budgetHistoryRows(seedState(), '2027-01')).toEqual([]);
  });
});

describe('closeBudgetForm: what the close dialog asks', () => {
  it('October (November does not exist yet): one field per account with a part, holding the part of this month, and the leftover', () => {
    const state = seedState();
    const form = closeBudgetForm(state, '2026-10');
    expect(form).toEqual({
      next: '2026-11',
      nextExists: false,
      fields: [{ accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '70000', exact: 70000 }],
      leftover: monthCalc(state, '2026-10').avail,
    });
    expect(f2(form.leftover!)).toBe('20,850.29');
  });

  it('if the next month already exists nothing is asked: closing does not touch it', () => {
    expect(closeBudgetForm(seedState(), '2026-09')).toEqual({ next: '2026-10', nextExists: true, fields: [], leftover: null });
    expect(closeBudgetForm(seedState(), '2026-08')).toMatchObject({ next: '2026-09', nextExists: true });
  });

  it('a month that does not exist: no fields and no leftover', () => {
    expect(closeBudgetForm(seedState(), '2027-03')).toEqual({ next: '2027-04', nextExists: false, fields: [], leftover: null });
  });

  it('several accounts with a part: one field for each, in the order of the accounts and in its currency', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: 58248, us: 200 }));
    expect(closeBudgetForm(state, '2026-10').fields).toEqual([
      { accountId: 'us', name: 'US account', currency: 'USD', amount: '200', exact: 200 },
      { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '58248', exact: 58248 },
    ]);
  });

  it('the incomes that raised the budget are not inherited: the field holds only what is in the log', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-dr', amount: 4000 }), income({ id: 'in-us', amount: 50, cur: 'USD', accountId: 'us' }));
    });
    const calc = monthCalc(state, '2026-10');
    expect(calc.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes])).toEqual([
      ['us', 50, 0, 50],
      ['dr', 74000, 70000, 4000],
    ]);
    // The US account only has what comes from the income: no field. The DR account, its 70,000 from the log.
    expect(closeBudgetForm(state, '2026-10').fields).toEqual([{ accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '70000', exact: 70000 }]);
  });

  it('what the transfers moved is not inherited either: the next month starts with the log', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-us', accountId: 'us', amount: 2200, kind: 'initial' }));
      // 1,500 USD from the US account to the DR account at 58.76, the month rate.
      s.months['2026-10']!.transfers[0]!.budget = true;
    });
    const calc = monthCalc(state, '2026-10');
    expect(calc.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog])).toEqual([
      ['us', 700, 2200],
      ['dr', 158140, 70000],
    ]);
    const form = closeBudgetForm(state, '2026-10');
    expect(form.fields).toEqual([
      { accountId: 'us', name: 'US account', currency: 'USD', amount: '2200', exact: 2200 },
      { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '70000', exact: 70000 },
    ]);
    // Moving creates no budget: the leftover is the same as without the transfer marked (20,850.29 + the 2,200 USD).
    expect(form.leftover!).toBeCloseTo(20850.29 + 2200 * 58.76, 2);
  });

  it('an account with a negative part because of a transfer, with no log, is not asked about when closing', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.transfers[0]!.budget = true;
    });
    expect(monthCalc(state, '2026-10').budgetParts.find((p) => p.account.id === 'us')!.amount).toBe(-1500);
    expect(closeBudgetForm(state, '2026-10').fields.map((f) => f.accountId)).toEqual(['dr']);
  });

  it('the field shows two decimals and keeps the exact part', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', accountId: 'us', amount: 57.244044, kind: 'leftover' }));
    });
    expect(closeBudgetForm(state, '2026-10').fields[0]).toEqual({
      accountId: 'us',
      name: 'US account',
      currency: 'USD',
      amount: '57.24',
      exact: 57.244044,
    });
  });

  it('a negative part (a negative leftover with nothing else) starts at 0', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', accountId: 'us', amount: -120, kind: 'leftover' }));
    });
    expect(closeBudgetForm(state, '2026-10').fields[0]).toMatchObject({ accountId: 'us', amount: '0', exact: 0 });
  });

  it('a hidden account that still has a part also gets a field', () => {
    const state = stateWith((s) => {
      setBudgets(s.months['2026-10']!, { dr: 58248, us: 200 });
      s.accounts.find((a) => a.id === 'us')!.hidden = true;
    });
    expect(closeBudgetForm(state, '2026-10').fields.map((f) => f.accountId)).toEqual(['us', 'dr']);
  });

  it('if nothing is left over there is nothing to offer; if the month went over, the leftover is negative', () => {
    const used = monthCalc(seedState(), '2026-10').used;
    const exact = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: used }));
    expect(closeBudgetForm(exact, '2026-10').leftover).toBeNull();
    const cents = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: used + 0.004 }));
    expect(closeBudgetForm(cents, '2026-10').leftover).toBeNull();
    const over = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: 40000 }));
    expect(f2(closeBudgetForm(over, '2026-10').leftover!)).toBe('-9,149.71');
  });

  it('with no budget log: no fields, but the (negative) leftover is still offered', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-10']!, {}));
    const form = closeBudgetForm(state, '2026-10');
    expect(form.fields).toEqual([]);
    expect(f2(form.leftover!)).toBe('-49,149.71');
  });
});

describe('closeFieldInvalid', () => {
  it('empty counts as 0; a number >= 0 is valid', () => {
    for (const text of ['', '   ', '0', '0.00', '70000', '1234.56', ' 50 ', '1e3']) expect(closeFieldInvalid(text), `"${text}"`).toBe(false);
  });

  it('a negative or something that is not a number is not', () => {
    for (const text of ['-1', '-0.01', 'abc', '1,5', '12x', 'Infinity', 'NaN']) expect(closeFieldInvalid(text), `"${text}"`).toBe(true);
  });
});

describe('closeRequest: what is sent when closing', () => {
  const field = (over: Partial<CloseBudgetField> = {}): CloseBudgetField => ({
    accountId: 'dr',
    name: 'DR account',
    currency: 'DOP',
    amount: '70000',
    exact: 70000,
    ...over,
  });
  const form = (over: Partial<CloseBudgetForm> = {}): CloseBudgetForm => ({
    next: '2026-11',
    nextExists: false,
    fields: [field()],
    leftover: 20850.29,
    ...over,
  });

  it('nothing touched: the parts of this month and the leftover not added', () => {
    const f = closeBudgetForm(seedState(), '2026-10');
    expect(closeRequest(f, f.fields, false)).toEqual({ budgets: { dr: 70000 }, addLeftover: false });
  });

  it('with the checkbox checked the leftover is added', () => {
    const f = closeBudgetForm(seedState(), '2026-10');
    expect(closeRequest(f, f.fields, true)).toEqual({ budgets: { dr: 70000 }, addLeftover: true });
  });

  it('the checkbox does not count if there was no leftover to offer', () => {
    const f = form({ leftover: null });
    expect(closeRequest(f, f.fields, true)).toEqual({ budgets: { dr: 70000 }, addLeftover: false });
  });

  it('an untouched field sends the exact part, not the rounded one it shows', () => {
    const us = field({ accountId: 'us', currency: 'USD', amount: '57.24', exact: 57.244044 });
    expect(closeRequest(form({ fields: [us] }), [us], false)).toEqual({ budgets: { us: 57.244044 }, addLeftover: false });
  });

  it('an edited field sends the typed number', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    const typed = [
      { ...f.fields[0]!, amount: '65000.5' },
      { ...f.fields[1]!, amount: '57.2' },
    ];
    expect(closeRequest(f, typed, false)).toEqual({ budgets: { dr: 65000.5, us: 57.2 }, addLeftover: false });
  });

  it('empty or 0 leaves that account with no part: 0 is sent, it is not omitted', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    const typed = [
      { ...f.fields[0]!, amount: '' },
      { ...f.fields[1]!, amount: '0' },
    ];
    expect(closeRequest(f, typed, true)).toEqual({ budgets: { dr: 0, us: 0 }, addLeftover: true });
    expect(closeRequest(f, [{ ...f.fields[0]!, amount: '  ' }, f.fields[1]!], false)).toEqual({ budgets: { dr: 0, us: 200 }, addLeftover: false });
  });

  it('with no accounts with a part an empty split is sent', () => {
    expect(closeRequest(form({ fields: [] }), [], true)).toEqual({ budgets: {}, addLeftover: true });
  });

  it('if the next month already exists nothing is sent (undefined): the server would not touch it', () => {
    const f = closeBudgetForm(seedState(), '2026-09');
    expect(closeRequest(f, f.fields, false)).toBeUndefined();
    expect(closeRequest(f, f.fields, true)).toBeUndefined();
    // Even if fields remained, or one of them were invalid.
    expect(closeRequest(form({ nextExists: true }), [field({ amount: '-5' })], true)).toBeUndefined();
  });

  it('if any field is invalid, null: the month cannot be closed until it is fixed', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    expect(closeRequest(f, [f.fields[0]!, { ...f.fields[1]!, amount: '-5' }], false)).toBeNull();
    expect(closeRequest(f, [{ ...f.fields[0]!, amount: 'abc' }, f.fields[1]!], true)).toBeNull();
  });
});

describe('overrunLines: negative budget parts', () => {
  it('one line per negative part, with how much it is over in the currency of its account', () => {
    const state = seedState();
    const month = state.months['2026-10']!;
    month.transfers = [...month.transfers, { id: 'big', monthKey: '2026-10', date: '2026-10-05', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 800, rate: 58, budget: true, fee: 0 }];
    expect(overrunLines(monthCalc(state, '2026-10').budgetParts)).toEqual([{ id: 'us', amount: '800.00', currency: 'USD', account: 'US account' }]);
  });

  it('none if there are no negative parts', () => {
    expect(overrunLines(monthCalc(seedState(), '2026-10').budgetParts)).toEqual([]);
  });
});

describe('extra budget dialog: defaults and what it sends', () => {
  it('date: today in the current month, the first day in any other', () => {
    expect(extraDefaultDate('2026-10', '2026-10-09')).toBe('2026-10-09');
    expect(extraDefaultDate('2026-09', '2026-10-09')).toBe('2026-09-01');
    expect(extraDefaultDate('2026-11', '2026-10-31')).toBe('2026-11-01');
  });

  it('account: the first budget part, else the first account', () => {
    const calc = monthCalc(seedState(), '2026-10');
    expect(extraDefaultAccount(calc.budgetParts, [{ id: 'us' }, { id: 'dr' }])).toBe('dr');
    expect(extraDefaultAccount([], [{ id: 'us' }, { id: 'dr' }])).toBe('us');
    expect(extraDefaultAccount([], [])).toBe('');
  });

  it('only a positive amount, an account and a date inside the month can be confirmed', () => {
    const base = newExtraForm('2026-10', '2026-10-09', monthCalc(seedState(), '2026-10').budgetParts, [{ id: 'dr' }]);
    expect(base).toEqual({ accountId: 'dr', incomeId: '', amount: '', note: '', date: '2026-10-09' });
    expect(extraProblem(base, '2026-10')).toBe('amount');
    for (const amount of ['0', '-5', 'abc']) expect(extraProblem({ ...base, amount }, '2026-10')).toBe('amount');
    expect(extraProblem({ ...base, amount: '5', date: '2026-11-01' }, '2026-10')).toBe('date');
    expect(extraProblem({ ...base, amount: '5', accountId: '' }, '2026-10')).toBe('account');
    expect(extraInput({ ...base, amount: '5000', note: '  Medical ' }, '2026-10')).toEqual({
      accountId: 'dr',
      amount: 5000,
      date: '2026-10-09',
      note: 'Medical',
      kind: 'adjust',
      incomeId: null,
    });
    expect(extraInput({ ...base, amount: '0' }, '2026-10')).toBeNull();
  });
});

describe('summaryRows', () => {
  it('lists the initial budget, each addition with its date and note, then total, spent and remaining', () => {
    const rows = summaryRows(budgetSummary(seedState(), '2026-10'));
    expect(rows.map((r) => [r.kind, r.labelKey, r.date, r.note, r.amount])).toEqual([
      ['initial', 'summaryInitial', null, '', '65,000.00'],
      ['addition', 'budgetKindExtra', '05/10', 'Car repair', '5,000.00'],
      ['total', 'summaryTotal', null, '', '70,000.00'],
      ['spent', 'summarySpent', null, '', '49,149.71'],
      ['remaining', 'summaryRemaining', null, '', '20,850.29'],
    ]);
    expect(rows.at(-1)!.second).toBe('354.84');
    // The compact form (close dialog) folds the additions into one row.
    expect(summaryRows(budgetSummary(seedState(), '2026-10'), true).map((r) => r.kind)).toEqual(['initial', 'added', 'total', 'spent', 'remaining']);
  });

  it('overspent: "Over budget by" with the magnitude, flagged negative', () => {
    const state = stateWith((s) => s.months['2026-10']!.budgetLog.push(entry({ id: 'cut', amount: -60000, kind: 'adjust' })));
    const last = summaryRows(budgetSummary(state, '2026-10')).at(-1)!;
    expect(last).toMatchObject({ kind: 'remaining', labelKey: 'summaryOver', negative: true, amount: '39,149.71' });
  });

  it('without a second currency no row carries a second figure', () => {
    const state = { ...seedState(), secondCurrency: null };
    expect(summaryRows(budgetSummary(state, '2026-10')).every((r) => r.second === null)).toBe(true);
  });
});
