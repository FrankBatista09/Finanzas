import { describe, expect, it } from 'vitest';
import { balances, budgetHistory, budgetsFromLog, leftoverFor, monthCalc, rateFor } from '../../shared/calc';
import { f2 } from '../../shared/format';
import { seedState, setBudgets } from '../../shared/seed';
import type { AppState, BudgetEntry, Income, Month } from '../../shared/types';
import {
  accountInUse,
  accountName,
  budgetEntry,
  budgetPart,
  canHideAccount,
  canRemoveAccount,
  canRemoveGoal,
  contributionChange,
  currencyChange,
  fieldsOf,
  fixedChange,
  goalChange,
  incomeChange,
  isLocalEntry,
  isPatch,
  latestKey,
  leftoverEntry,
  LOCAL_ENTRY,
  mergePatch,
  monthRate,
  newAccount,
  newBudgetEntry,
  newContribution,
  newFixed,
  newGoal,
  newIncome,
  newTransfer,
  newTx,
  normalizeGoalPlan,
  openingForBalance,
  putMonths,
  reduce,
  removeMonth,
  targetOf,
  transferChange,
  txChange,
  typedRate,
} from './reducers';
import type { Action } from './reducers';

const OCT = '2026-10';

/** Freezes the whole tree: if a reducer mutated the state, the test blows up. */
function frozen(base: AppState = seedState()): AppState {
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    Object.values(v).forEach(freeze);
  };
  freeze(base);
  return base;
}

/** Balance of an account at the end of October, in its currency. */
const balanceOf = (state: AppState, id: string, asOf = OCT) => balances(state, asOf).accounts.find((a) => a.account.id === id)!.balance;

/** The sample data with two USD → DOP rates on different dates in October: 58 from day 1 and 60 from day 6. */
function twoRates(): AppState {
  const s = seedState();
  s.months[OCT]!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
  ];
  return s;
}

/** The sample data plus an October income that raises the budget (Income.budget). */
function withBudgetIncome(income: Partial<Income> = {}): AppState {
  const s = seedState();
  s.incomes.push({ id: 'in-budget', date: '2026-10-10', desc: 'Freelance', accountId: 'dr', amount: 10000, cur: 'DOP', budget: true, ...income });
  return s;
}

/** An account's budget part as it is shown (log + incomes that raise it). */
const partOf = (state: AppState, id: string, key = OCT) => monthCalc(state, key).budgetParts.find((p) => p.account.id === id)!;

describe('reduce · month', () => {
  it('edits the budget part of one account without touching the others or anything else', () => {
    const s = frozen();
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 200 } } });
    const m = next.months[OCT]!;
    expect(m.budgets).toEqual({ dr: 70000, us: 200 });
    // What does not change keeps its identity (memoized rows are not repainted).
    expect(m.fixed).toBe(s.months[OCT]!.fixed);
    expect(m.rates).toBe(s.months[OCT]!.rates);
    expect(next.months['2026-09']).toBe(s.months['2026-09']);
    expect(next.contribs).toBe(s.contribs);
    expect(next.accounts).toBe(s.accounts);
  });

  it('the new budget reaches the calculations, each part converted with the month rate', () => {
    const next = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { dr: 50000 } } });
    expect(f2(monthCalc(next, OCT).avail)).toBe('850.29'); // 50,000 − 49,149.71
    const split = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { us: 200, dr: 58248 } } });
    expect(monthCalc(split, OCT).budget).toBeCloseTo(200 * 58.76 + 58248, 8);
  });

  it('0 removes the part, as on the server', () => {
    const next = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { dr: 0 } } });
    expect(next.months[OCT]!.budgets).toEqual({});
    expect(monthCalc(next, OCT).budget).toBe(0);
  });

  it('ignores a month that does not exist, and a patch that changes nothing returns the same state', () => {
    const s = frozen();
    expect(reduce(s, { type: 'month/patch', key: '2030-01', patch: { budgets: { dr: 1 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 70000 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 0 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: {} })).toBe(s);
  });

  it('does not overwrite the budget: adds to the log a movement with the difference for each account', () => {
    const s = frozen();
    // October starts with 65,000 ('initial') + 5,000 ('adjust') in the DR account; the US account has no part.
    const before = s.months[OCT]!.budgetLog;
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000, us: 200 } }, date: '2026-10-09' });
    const log = next.months[OCT]!.budgetLog;
    expect(log).toHaveLength(4);
    // What was already in the log is still there, as is.
    expect(log[0]).toBe(before[0]);
    expect(log[1]).toBe(before[1]);
    // 'adjust' if the account already had movements in the month; 'initial' if it is the first.
    expect(log[2]).toEqual({ id: expect.stringMatching(/^local-/) as string, date: '2026-10-09', accountId: 'dr', amount: 10000, kind: 'adjust', note: '' });
    expect(log[3]).toEqual({ id: expect.stringMatching(/^local-/) as string, date: '2026-10-09', accountId: 'us', amount: 200, kind: 'initial', note: '' });
    expect(new Set(log.map((e) => e.id)).size).toBe(4);
    expect(log.slice(2).every((e) => isLocalEntry(e.id))).toBe(true);
    // Month.budgets is the sum of the log, already computed.
    expect(next.months[OCT]!.budgets).toEqual({ dr: 80000, us: 200 });
    expect(next.months[OCT]!.budgets).toEqual(budgetsFromLog(log));
    expect(monthCalc(next, OCT).budget).toBeCloseTo(80000 + 200 * 58.76, 8);
  });

  it('lowering a part adds a negative movement; setting it to 0, one that cancels it out', () => {
    const s = frozen();
    const lower = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 50000 } }, date: '2026-10-09' });
    expect(lower.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: -20000, kind: 'adjust' });
    expect(lower.months[OCT]!.budgets).toEqual({ dr: 50000 });

    const zero = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 0 } }, date: '2026-10-09' });
    expect(zero.months[OCT]!.budgetLog).toHaveLength(3);
    expect(zero.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: -70000, kind: 'adjust' });
    // The history is kept even though the sum ends up at zero.
    expect(budgetHistory(zero, OCT).map((r) => r.total)).toEqual([65000, 70000, 0]);
  });

  it('the movement carries the date of the action or, without one, the first day of the month', () => {
    const s = frozen();
    const dated = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 50 } }, date: '2026-10-21' });
    expect(dated.months[OCT]!.budgetLog.at(-1)!.date).toBe('2026-10-21');
    const plain = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 50 } } });
    expect(plain.months[OCT]!.budgetLog.at(-1)!.date).toBe('2026-10-01');
  });

  it('is idempotent: repeating the action does not add another movement, and a second change starts from the new sum', () => {
    const s = frozen();
    const action: Action = { type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000, us: 200 } }, date: '2026-10-09' };
    const once = reduce(s, action);
    expect(reduce(once, action)).toBe(once);
    // Another amount for the same account: only the difference from what its log already adds up to.
    const twice = reduce(once, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 81500.5 } }, date: '2026-10-12' });
    expect(twice.months[OCT]!.budgetLog).toHaveLength(5);
    expect(twice.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: 1500.5, kind: 'adjust', date: '2026-10-12' });
    expect(twice.months[OCT]!.budgets).toEqual({ dr: 81500.5, us: 200 });
    expect(new Set(twice.months[OCT]!.budgetLog.map((e) => e.id)).size).toBe(5);
  });

  it('floating-point noise is not a difference', () => {
    const s = seedState();
    s.months[OCT]!.budgetLog = [
      { id: 'a', date: '2026-10-01', accountId: 'us', amount: 0.1, kind: 'initial', note: '' },
      { id: 'b', date: '2026-10-02', accountId: 'us', amount: 0.2, kind: 'adjust', note: '' },
    ];
    s.months[OCT]!.budgets = budgetsFromLog(s.months[OCT]!.budgetLog);
    const f = frozen(s);
    expect(reduce(f, { type: 'month/patch', key: OCT, patch: { budgets: { us: 0.3 } } })).toBe(f);
    expect(reduce(f, { type: 'month/patch', key: OCT, patch: { budgets: { us: 0.3 + 1e-12 } } })).toBe(f);
  });

  it('incomes that raise the budget are not in the log: the patch sets only what the log adds up to', () => {
    const s = frozen(withBudgetIncome());
    // The part shows 80,000 (70,000 from the log + 10,000 from the income); the log already adds up to 70,000.
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 70000 } } })).toBe(s);
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 75000 } } });
    expect(next.months[OCT]!.budgetLog.at(-1)).toMatchObject({ amount: 5000, kind: 'adjust' });
    expect(next.months[OCT]!.budgets).toEqual({ dr: 75000 });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
  });

  it('reopens a closed month', () => {
    const s = frozen();
    const next = reduce(s, { type: 'month/reopen', key: '2026-09' });
    expect(next.months['2026-09']!.closed).toBe(false);
    expect(next.months['2026-09']!.closedAt).toBeNull();
    // Reopening an open one changes nothing.
    expect(reduce(s, { type: 'month/reopen', key: OCT })).toBe(s);
  });
});

describe('reduce · budget log', () => {
  const entry = (over: Partial<BudgetEntry> = {}): BudgetEntry => ({ id: 'bg-new', date: '2026-10-09', accountId: 'dr', amount: 2500, kind: 'adjust', note: 'Gift', ...over });

  it('budget/add adds a movement and recalculates the parts; repeating it does not duplicate it', () => {
    const s = frozen();
    const next = reduce(s, { type: 'budget/add', key: OCT, row: entry() });
    expect(next.months[OCT]!.budgetLog).toHaveLength(3);
    expect(next.months[OCT]!.budgetLog.at(-1)).toEqual(entry());
    expect(next.months[OCT]!.budgets).toEqual({ dr: 72500 });
    expect(monthCalc(next, OCT).budget).toBe(72500);
    // The rest of the month keeps its identity.
    expect(next.months[OCT]!.tx).toBe(s.months[OCT]!.tx);
    expect(next.months[OCT]!.budgetLog[0]).toBe(s.months[OCT]!.budgetLog[0]);
    expect(next.months['2026-09']).toBe(s.months['2026-09']);
    // With the same id it replaces whichever one was there (a refetch can bring it already applied).
    const again = reduce(next, { type: 'budget/add', key: OCT, row: entry() });
    expect(again).toEqual(next);
    expect(again.months[OCT]!.budgetLog).toHaveLength(3);
  });

  it('budget/add: a negative movement cuts the part, and another account gets its first part', () => {
    const s = frozen();
    const cut = reduce(s, { type: 'budget/add', key: OCT, row: entry({ amount: -70000 }) });
    // The account that adds up to 0 no longer appears in the parts, but its log remains.
    expect(cut.months[OCT]!.budgets).toEqual({});
    expect(cut.months[OCT]!.budgetLog).toHaveLength(3);
    const other = reduce(s, { type: 'budget/add', key: OCT, row: entry({ accountId: 'us', amount: 150, kind: 'initial' }) });
    expect(other.months[OCT]!.budgets).toEqual({ dr: 70000, us: 150 });
    expect(monthCalc(other, OCT).budget).toBeCloseTo(70000 + 150 * 58.76, 8);
  });

  it('budget/remove removes that movement and recalculates; one that is not there, or a month that does not exist, changes nothing', () => {
    const s = frozen();
    // The day-5 adjustment (5,000, "Car repair").
    const next = reduce(s, { type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-2' });
    expect(next.months[OCT]!.budgetLog.map((e) => e.id)).toEqual(['seed-bg-2026-10-1']);
    expect(next.months[OCT]!.budgets).toEqual({ dr: 65000 });
    expect(monthCalc(next, OCT).budget).toBe(65000);
    expect(reduce(next, { type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-2' })).toBe(next);
    expect(reduce(s, { type: 'budget/remove', key: OCT, id: 'nope' })).toBe(s);
    // The id belongs to October: it is not in another month.
    expect(reduce(s, { type: 'budget/remove', key: '2026-09', id: 'seed-bg-2026-10-2' })).toBe(s);
    expect(reduce(s, { type: 'budget/remove', key: '2030-01', id: 'seed-bg-2026-10-2' })).toBe(s);
    expect(reduce(s, { type: 'budget/add', key: '2030-01', row: entry() })).toBe(s);
  });

  it('budget/leftover adds the leftover only once per month', () => {
    const s = frozen();
    const row = leftoverEntry(s, OCT, 'local-lo', '2026-10-07')!;
    const next = reduce(s, { type: 'budget/leftover', key: OCT, row });
    expect(next.months[OCT]!.budgetLog.at(-1)).toBe(row);
    expect(next.months[OCT]!.budgets.dr).toBeCloseTo(70000 + row.amount, 8);
    expect(monthCalc(next, OCT).budget).toBeCloseTo(70000 + monthCalc(s, '2026-09').avail, 8);
    expect(leftoverFor(next, OCT).added).toBe(true);
    // The same action again, or another with a different id (the server already wrote it with its own): not repeated.
    expect(reduce(next, { type: 'budget/leftover', key: OCT, row })).toBe(next);
    expect(reduce(next, { type: 'budget/leftover', key: OCT, row: { ...row, id: 'server-id', amount: 1 } })).toBe(next);
    expect(reduce(s, { type: 'budget/leftover', key: '2030-01', row })).toBe(s);
  });

  it('budget/leftover: once the movement is removed, it can be added again', () => {
    const s = frozen();
    const row = { ...leftoverEntry(s, OCT, 'lo-1', '2026-10-07')! };
    const added = reduce(s, { type: 'budget/leftover', key: OCT, row });
    const removed = reduce(added, { type: 'budget/remove', key: OCT, id: 'lo-1' });
    expect(removed.months[OCT]!.budgetLog).toEqual(s.months[OCT]!.budgetLog);
    expect(leftoverFor(removed, OCT).added).toBe(false);
    expect(reduce(removed, { type: 'budget/leftover', key: OCT, row }).months[OCT]!.budgetLog).toHaveLength(3);
  });
});

describe('reduce · month rates', () => {
  it('the typed rate wins over the transfers of the month', () => {
    const s = frozen();
    // August has no typed rate: it comes from its transfers.
    expect(rateFor(s, '2026-08', 'USD', 'DOP').source).toBe('transfers');
    const next = reduce(s, { type: 'rate/set', key: '2026-08', rate: { from: 'USD', to: 'DOP', rate: 60, date: '2026-08-10' } });
    expect(next.months['2026-08']!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 60, date: '2026-08-10' }]);
    expect(monthCalc(next, '2026-08').rate).toEqual({ rate: 60, source: 'month', monthKey: '2026-08', date: '2026-08-10' });
    expect(next.months[OCT]).toBe(s.months[OCT]);
  });

  it('there is one per pair and date: the new one replaces the one for that date, whatever its direction, and in its place', () => {
    // October comes with USD → DOP typed twice: on day 1 and on day 6.
    let s = reduce(frozen(), { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-06' } });
    expect(s.months[OCT]!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-06' },
    ]);
    const first = s.months[OCT]!.rates[0];
    s = reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-06' } });
    expect(s.months[OCT]!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-06' },
      { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-06' },
    ]);
    // The one for another date is not even touched: it still applies to what was recorded before day 6.
    expect(s.months[OCT]!.rates[0]).toBe(first);
    expect(rateFor(s, OCT, 'USD', 'DOP').rate).toBeCloseTo(1 / 0.0165, 10);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-05').rate).toBe(58.76);
  });

  it('several rates for the same pair, each with its date: each row is converted with the one in effect on its own date', () => {
    let s = frozen();
    for (const [rate, date] of [[59, '2026-10-10'], [60, '2026-10-20'], [59.5, '2026-10-15']] as const) {
      s = reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate, date } });
    }
    // They are stored in the order they were typed; shared/calc.ts sorts them by date.
    expect(s.months[OCT]!.rates.map((r) => [r.date, r.rate])).toEqual([
      ['2026-10-01', 58.76],
      ['2026-10-06', 58.76],
      ['2026-10-10', 59],
      ['2026-10-20', 60],
      ['2026-10-15', 59.5],
    ]);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-09').rate).toBe(58.76);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-10').rate).toBe(59);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-17').rate).toBe(59.5);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-25')).toEqual({ rate: 60, source: 'month', monthKey: OCT, date: '2026-10-20' });
    expect(monthCalc(s, OCT).rate!.rate).toBe(60);
    // What is already recorded does not change: the seven October transactions are from days 1 to 7.
    expect(monthCalc(s, OCT).varSpent).toBe(monthCalc(seedState(), OCT).varSpent);
  });

  it('typing the same rate again changes nothing', () => {
    const s = frozen();
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' } })).toBe(s);
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' } })).toBe(s);
    expect(reduce(s, { type: 'rate/set', key: '2030-01', rate: { from: 'USD', to: 'DOP', rate: 1, date: '2030-01-01' } })).toBe(s);
    // The same number on another date is a different rate.
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-07' } }).months[OCT]!.rates).toHaveLength(3);
  });

  it('removing a rate removes only the one for that date; with none, the pair goes back to whatever shared/calc resolves', () => {
    const s = frozen();
    // It is removed even when asked for in the other direction.
    const one = reduce(s, { type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD', date: '2026-10-06' });
    expect(one.months[OCT]!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    expect(one.months[OCT]!.rates[0]).toBe(s.months[OCT]!.rates[0]);
    expect(monthCalc(one, OCT).rate).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-01' });
    const none = reduce(one, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-01' });
    expect(none.months[OCT]!.rates).toEqual([]);
    expect(monthCalc(none, OCT).rate).toEqual({ rate: 58.76, source: 'transfers', monthKey: OCT, date: null });
    // Another pair, another date or another month: nothing to remove.
    expect(reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'TRY', date: '2026-10-06' })).toBe(s);
    expect(reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-02' })).toBe(s);
    expect(reduce(s, { type: 'rate/remove', key: '2026-09', from: 'USD', to: 'DOP', date: '2026-10-06' })).toBe(s);
  });

  it('removing the rate of a date returns its rows to the previous one', () => {
    const s = frozen(twoRates());
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-07').rate).toBe(60);
    const next = reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-06' });
    expect(rateFor(next, OCT, 'USD', 'DOP', '2026-10-07').rate).toBe(58);
    expect(rateFor(next, OCT, 'USD', 'DOP').rate).toBe(58);
  });
});

describe('reduce · month rows', () => {
  it('marks a fixed expense as paid: used goes up and the balance of its account goes down', () => {
    const s = frozen();
    const before = monthCalc(s, OCT);
    const netflix = s.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!;
    const next = reduce(s, { type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    const after = monthCalc(next, OCT);
    expect(after.paidCount).toBe(before.paidCount + 1);
    expect(after.used).toBeCloseTo(before.used + 1137.3, 6);
    expect(after.pending).toBeCloseTo(before.pending - 1137.3, 6);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') - 1137.3, 6);
    // Only that row changes.
    const rows = next.months[OCT]!.fixed;
    expect(rows.filter((r, i) => r !== s.months[OCT]!.fixed[i])).toHaveLength(1);
  });

  it('adds, edits and deletes a transaction', () => {
    const s = frozen();
    const row = newTx(s, OCT, { date: '2026-10-07', desc: ' Uber ', cat: 'Transport', method: 'Card', amount: 850, cur: 'DOP' }, 'tx-new')!;
    expect(row).toMatchObject({ id: 'tx-new', monthKey: OCT, desc: 'Uber', place: '', notes: '', accountId: 'dr', source: 'web', createdAt: null });

    let next = reduce(s, { type: 'tx/add', row });
    expect(next.months[OCT]!.tx).toHaveLength(8);
    expect(monthCalc(next, OCT).varSpent).toBe(10845 + 850);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') - 850, 6);

    next = reduce(next, { type: 'tx/patch', id: 'tx-new', patch: { amount: 10, cur: 'USD' } });
    expect(monthCalc(next, OCT).varSpent).toBeCloseTo(10845 + 10 * 58.76, 6);

    // Paid from another account: the month's spending is the same, but it comes out of the US account.
    next = reduce(next, { type: 'tx/patch', id: 'tx-new', patch: { accountId: 'us' } });
    expect(monthCalc(next, OCT).varSpent).toBeCloseTo(10845 + 10 * 58.76, 6);
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') - 10, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr'), 6);

    next = reduce(next, { type: 'tx/remove', id: 'tx-new' });
    expect(next.months[OCT]!.tx).toEqual(s.months[OCT]!.tx);
  });

  it('finds the row in whatever month it is in (the id is enough)', () => {
    const s = frozen();
    const id = s.months['2026-08']!.tx[0]!.id;
    const next = reduce(s, { type: 'tx/patch', id, patch: { notes: 'revisado' } });
    expect(next.months['2026-08']!.tx[0]!.notes).toBe('revisado');
    expect(next.months[OCT]).toBe(s.months[OCT]);
  });

  it('a transfer moves both accounts: the amount leaves one and amount × rate enters the other', () => {
    const s = frozen();
    const row = newTransfer(s, OCT, { date: '2026-10-08', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 57 }, 'tr-new')!;
    let next = reduce(s, { type: 'transfer/add', row });
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') - 500, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 500 * 57, 6);

    // It is edited; there is no need to delete it and enter it again.
    next = reduce(next, { type: 'transfer/patch', id: 'tr-new', patch: { amount: 600, rate: 58 } });
    expect(next.months[OCT]!.transfers.at(-1)).toMatchObject({ id: 'tr-new', amount: 600, rate: 58, via: 'PayPal' });
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 600 * 58, 6);

    expect(reduce(next, { type: 'transfer/remove', id: 'tr-new' }).months[OCT]!.transfers).toEqual(s.months[OCT]!.transfers);
  });

  it('with no typed rate, a new transfer changes the month rate (weighted average)', () => {
    const s = frozen({ ...seedState(), months: { ...seedState().months, [OCT]: { ...seedState().months[OCT]!, rates: [] } } });
    const row = newTransfer(s, OCT, { date: '2026-10-08', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 57 }, 'tr-new')!;
    const next = reduce(s, { type: 'transfer/add', row });
    expect(monthCalc(next, OCT).rate!.rate).toBeCloseTo((1500 * 58.76 + 500 * 57) / 2000, 10);
  });

  it('editing or deleting a row that does not exist leaves the state unchanged', () => {
    const s = frozen();
    expect(reduce(s, { type: 'fixed/patch', id: 'nope', patch: { paid: true } })).toBe(s);
    expect(reduce(s, { type: 'tx/remove', id: 'nope' })).toBe(s);
    expect(reduce(s, { type: 'transfer/patch', id: 'nope', patch: { amount: 1 } })).toBe(s);
    expect(reduce(s, { type: 'income/patch', id: 'nope', patch: { amount: 1 } })).toBe(s);
    expect(reduce(s, { type: 'income/remove', id: 'nope' })).toBe(s);
    expect(reduce(s, { type: 'contribution/patch', id: 'nope', patch: { amount: 1 } })).toBe(s);
    expect(reduce(s, { type: 'contribution/remove', id: 'nope' })).toBe(s);
    expect(reduce(s, { type: 'account/patch', id: 'nope', patch: { name: 'x' } })).toBe(s);
    expect(reduce(s, { type: 'account/remove', id: 'nope' })).toBe(s);
  });
});

describe('reduce · accounts', () => {
  it('adds an account at the end, renames it, hides it and deletes it', () => {
    const s = frozen();
    const row = newAccount(s, { name: ' TR account ', currency: 'TRY', opening: 1500 }, 'tr')!;
    expect(row).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 1500, hidden: false, sort: 2 });

    let next = reduce(s, { type: 'account/add', row });
    expect(next.accounts.map((a) => a.id)).toEqual(['us', 'dr', 'tr']);
    expect(next.months).toBe(s.months);
    expect(balanceOf(next, 'tr')).toBe(1500);

    next = reduce(next, { type: 'account/patch', id: 'tr', patch: { name: 'Garanti' } });
    expect(next.accounts.at(-1)).toEqual({ ...row, name: 'Garanti' });
    // The other accounts keep their identity.
    expect(next.accounts[0]).toBe(s.accounts[0]);

    // Hidden, it does not add to the total money, but its balance is still calculated.
    const total = balances(next, OCT).totalMain;
    next = reduce(next, { type: 'account/patch', id: 'tr', patch: { hidden: true } });
    expect(balances(next, OCT).totalMain).toBeLessThan(total);
    expect(balances(next, OCT).totalMain).toBeCloseTo(balances(s, OCT).totalMain, 6);
    expect(balanceOf(next, 'tr')).toBe(1500);

    next = reduce(next, { type: 'account/remove', id: 'tr' });
    expect(next.accounts).toEqual(s.accounts);
  });

  it('correcting a balance means changing the opening balance: the movements are not touched', () => {
    const s = frozen();
    const opening = openingForBalance(s, OCT, 'dr', 200000)!;
    const next = reduce(s, { type: 'account/patch', id: 'dr', patch: { opening } });
    expect(balanceOf(next, 'dr')).toBeCloseTo(200000, 6);
    expect(next.months).toBe(s.months);
    expect(next.incomes).toBe(s.incomes);
  });

  it('if the default account is deleted, the choice goes back to the automatic one', () => {
    const s = frozen({ ...seedState(), defaultAccountId: 'spare', accounts: [...seedState().accounts, newAccount(seedState(), { name: 'Spare', currency: 'USD' }, 'spare')!] });
    const next = reduce(s, { type: 'account/remove', id: 'spare' });
    expect(next.defaultAccountId).toBeNull();
    expect(reduce(s, { type: 'account/remove', id: 'us' }).defaultAccountId).toBe('spare');
  });
});

describe('reduce · incomes', () => {
  it('adds, edits and deletes: the income of the month is the sum of its incomes and goes into its account', () => {
    const s = frozen();
    const row = newIncome(s, { date: '2026-10-15', desc: ' Bonus ', accountId: 'us', amount: 1000, cur: 'USD' }, 'in-new')!;
    expect(row).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false, rate: null, recurring: false });

    let next = reduce(s, { type: 'income/add', row });
    expect(next.incomes).toHaveLength(4);
    expect(next.months).toBe(s.months);
    expect(monthCalc(next, OCT).income).toBeCloseTo(6800 * 58.76, 6);
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') + 1000, 8);

    // Received in another currency and in another account: it goes in converted with the month rate of its date.
    next = reduce(next, { type: 'income/patch', id: 'in-new', patch: { accountId: 'dr', amount: 100 } });
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us'), 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 100 * 58.76, 6);

    // Dated in another month, it stops counting in this one.
    next = reduce(next, { type: 'income/patch', id: 'in-new', patch: { date: '2026-09-15' } });
    expect(monthCalc(next, OCT).income).toBeCloseTo(5800 * 58.76, 6);

    expect(reduce(next, { type: 'income/remove', id: 'in-new' }).incomes).toEqual(s.incomes);
  });

  it('an income checked for the budget raises the part of its account without touching the log of the month', () => {
    const s = frozen();
    const row = newIncome(s, { date: '2026-10-15', desc: 'Bonus', accountId: 'dr', amount: 100, cur: 'USD', budget: true }, 'in-new')!;
    expect(row.budget).toBe(true);
    const next = reduce(s, { type: 'income/add', row });
    // No BudgetEntry: shared/calc.ts adds it.
    expect(next.months).toBe(s.months);
    expect(monthCalc(next, OCT).budget).toBeCloseTo(70000 + 100 * 58.76, 8);
    expect(partOf(next, 'dr')).toMatchObject({ fromLog: 70000 });
    expect(partOf(next, 'dr').fromIncomes).toBeCloseTo(5876, 8);
    expect(budgetHistory(next, OCT).at(-1)).toMatchObject({ kind: 'income', id: 'in-new', note: 'Bonus' });

    // Unchecking it turns it back into an ordinary income: it goes into the account, but not into the budget.
    const off = reduce(next, { type: 'income/patch', id: 'in-new', patch: { budget: false } });
    expect(monthCalc(off, OCT).budget).toBe(70000);
    expect(balanceOf(off, 'dr')).toBe(balanceOf(next, 'dr'));
    // And checking one that already existed works too.
    const on = reduce(s, { type: 'income/patch', id: 'seed-in-3', patch: { budget: true } });
    expect(partOf(on, 'us')).toMatchObject({ amount: 5800, fromLog: 0, fromIncomes: 5800 });
    expect(monthCalc(on, OCT).budget).toBeCloseTo(70000 + 5800 * 58.76, 6);
  });
});

describe('reduce · contributions', () => {
  it('adds, edits and deletes; they do not move the balance of any account', () => {
    const s = frozen();
    const row = newContribution(s, { goalId: 'personal', date: '2026-10-05', amount: 100, cur: 'USD' }, 'ct-new')!;
    let next = reduce(s, { type: 'contribution/add', row });
    expect(next.contribs).toHaveLength(9);
    expect(next.months).toBe(s.months);
    expect(balances(next, OCT).totalMain).toBe(balances(s, OCT).totalMain);

    next = reduce(next, { type: 'contribution/patch', id: 'ct-new', patch: { goalId: 'emergency', amount: 150 } });
    expect(next.contribs.at(-1)).toEqual({ ...row, goalId: 'emergency', amount: 150 });
    expect(next.contribs[0]).toBe(s.contribs[0]);

    expect(reduce(next, { type: 'contribution/remove', id: 'ct-new' }).contribs).toEqual(s.contribs);
  });
});

describe('reduce · settings', () => {
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('changes the language without touching the colors, and vice versa', () => {
    const s = frozen();
    const tr = reduce(s, { type: 'settings/patch', patch: { language: 'tr' } });
    expect(tr.language).toBe('tr');
    expect(tr.theme).toBeNull();
    expect(tr.months).toBe(s.months);

    const themed = reduce(tr, { type: 'settings/patch', patch: { theme: ocean } });
    expect(themed.theme).toEqual(ocean);
    expect(themed.language).toBe('tr');
  });

  it('theme: null goes back to the original palette', () => {
    const themed = reduce(frozen(), { type: 'settings/patch', patch: { theme: ocean } });
    expect(reduce(themed, { type: 'settings/patch', patch: { theme: null } }).theme).toBeNull();
  });

  it('currencies and default account: only what comes in changes, and everything is recalculated in the new currency', () => {
    const s = frozen();
    const tr = reduce(s, { type: 'settings/patch', patch: { secondCurrency: 'TRY' } });
    expect([tr.mainCurrency, tr.secondCurrency, tr.defaultAccountId, tr.language]).toEqual(['DOP', 'TRY', 'dr', 'en']);

    const swapped = reduce(s, { type: 'settings/patch', patch: { mainCurrency: 'USD', secondCurrency: 'DOP' } });
    expect([swapped.mainCurrency, swapped.secondCurrency]).toEqual(['USD', 'DOP']);
    expect(monthCalc(swapped, OCT).budget).toBeCloseTo(70000 / 58.76, 8);
    expect(monthCalc(swapped, OCT).budgetSecond).toBeCloseTo(70000, 8);
    // What is stored does not change: nothing converted is persisted.
    expect(swapped.months).toBe(s.months);

    expect(reduce(s, { type: 'settings/patch', patch: { defaultAccountId: null } }).defaultAccountId).toBeNull();
    expect(reduce(s, { type: 'settings/patch', patch: { defaultAccountId: 'us' } }).defaultAccountId).toBe('us');
  });

  it('a patch that changes nothing returns the same state', () => {
    const s = frozen();
    expect(reduce(s, { type: 'settings/patch', patch: {} })).toBe(s);
    expect(reduce(s, { type: 'settings/patch', patch: { language: 'en', theme: null, mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: 'dr' } })).toBe(s);
  });
});

describe('reduce · goals', () => {
  it('adds a goal at the end, edits it and deletes it', () => {
    const s = frozen();
    const row = newGoal(s, { name: ' Car ', monthly: 500, start: '2026-10', end: '2027-09' }, 'g-new')!;
    // With no currency given, the user's main one.
    expect(row).toEqual({ id: 'g-new', name: 'Car', cur: 'DOP', monthly: 500, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });

    let next = reduce(s, { type: 'goal/add', row });
    expect(next.goals.map((g) => g.id)).toEqual(['emergency', 'personal', 'turkey', 'g-new']);
    expect(next.contribs).toBe(s.contribs);
    expect(next.months).toBe(s.months);

    next = reduce(next, { type: 'goal/patch', id: 'g-new', patch: { name: 'New car', monthly: 600, cur: 'USD', approxCur: 'TRY' } });
    expect(next.goals.at(-1)).toEqual({ ...row, name: 'New car', monthly: 600, cur: 'USD', approxCur: 'TRY' });
    // null is a value: it goes back to the user's main currency.
    expect(reduce(next, { type: 'goal/patch', id: 'g-new', patch: { approxCur: null } }).goals.at(-1)!.approxCur).toBeNull();
    // The other goals keep their identity.
    expect(next.goals[0]).toBe(s.goals[0]);

    next = reduce(next, { type: 'goal/remove', id: 'g-new' });
    expect(next.goals).toEqual(s.goals);
  });

  it('editing or deleting a goal that does not exist leaves the state unchanged', () => {
    const s = frozen();
    expect(reduce(s, { type: 'goal/patch', id: 'nope', patch: { name: 'x' } })).toBe(s);
    expect(reduce(s, { type: 'goal/remove', id: 'nope' })).toBe(s);
  });
});

describe('reduce · idempotence', () => {
  // A refetch can bring the state with the action already applied while it is still pending on the client.
  it('applying twice gives the same as once', () => {
    const s = frozen();
    const fixed = newFixed(s, OCT, { name: 'Spotify', amount: 6, cur: 'USD' }, 'fx-new')!;
    const transfer = newTransfer(s, OCT, { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1 }, 'tr-new')!;
    const actions: Action[] = [
      { type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 0 } } },
      { type: 'month/reopen', key: '2026-08' },
      { type: 'month/patch', key: OCT, patch: { budgets: { dr: 82000.55 } }, date: '2026-10-09' },
      { type: 'budget/add', key: OCT, row: { id: 'bg-new', date: '2026-10-09', accountId: 'us', amount: -40, kind: 'adjust', note: '' } },
      { type: 'budget/remove', key: OCT, id: s.months[OCT]!.budgetLog[1]!.id },
      { type: 'budget/leftover', key: OCT, row: leftoverEntry(s, OCT, 'local-lo', '2026-10-07')! },
      { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-06' } },
      { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } },
      { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' } },
      { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-01' },
      { type: 'account/add', row: newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')! },
      { type: 'account/patch', id: 'us', patch: { name: 'Chase', opening: 10, hidden: true } },
      { type: 'account/remove', id: 'dr' },
      { type: 'fixed/add', row: fixed },
      { type: 'fixed/patch', id: s.months[OCT]!.fixed[1]!.id, patch: { day: '3', accountId: 'us' } },
      { type: 'fixed/remove', id: s.months[OCT]!.fixed[0]!.id },
      { type: 'tx/add', row: newTx(s, OCT, { date: '2026-10-07', desc: 'X', cat: 'Food', method: 'Card', amount: 1, cur: 'DOP' }, 'tx-new')! },
      { type: 'transfer/add', row: transfer },
      { type: 'transfer/patch', id: s.months[OCT]!.transfers[0]!.id, patch: { amount: 2, via: 'Wise' } },
      { type: 'transfer/remove', id: s.months[OCT]!.transfers[0]!.id },
      { type: 'income/add', row: newIncome(s, { date: '2026-10-07', amount: 1, cur: 'USD' }, 'in-new')! },
      { type: 'income/patch', id: s.incomes[0]!.id, patch: { amount: 6000, budget: true } },
      { type: 'income/remove', id: s.incomes[0]!.id },
      { type: 'contribution/add', row: newContribution(s, { goalId: 'emergency', date: '2026-10-07', amount: 1, cur: 'DOP' }, 'ct-new')! },
      { type: 'contribution/patch', id: s.contribs[0]!.id, patch: { amount: 5, cur: 'TRY' } },
      { type: 'contribution/remove', id: s.contribs[0]!.id },
      { type: 'settings/patch', patch: { language: 'tr', theme: { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' } } },
      { type: 'settings/patch', patch: { theme: null, mainCurrency: 'USD', secondCurrency: 'DOP', defaultAccountId: null } },
      { type: 'goal/add', row: newGoal(s, { name: 'Car', cur: 'TRY', monthly: 500, start: '2026-10', end: '2027-09' }, 'g-new')! },
      { type: 'goal/patch', id: 'turkey', patch: { name: 'Istanbul', monthly: null, start: null, end: null, approxCur: 'TRY' } },
      { type: 'goal/remove', id: 'personal' },
    ];
    for (const action of actions) {
      const once = reduce(s, action);
      expect(once, action.type).not.toBe(s);
      expect(reduce(once, action), action.type).toEqual(once);
    }
    expect(removeMonth(removeMonth(s, OCT), OCT)).toEqual(removeMonth(s, OCT));
  });
});

describe('new rows: contract validation', () => {
  const s = seedState();

  it('fixed expense: item, amount > 0 and an account that exists; it goes at the end, unpaid', () => {
    expect(newFixed(s, OCT, { name: '  ', amount: 10, cur: 'DOP' }, 'x')).toBeNull();
    expect(newFixed(s, OCT, { name: 'Gym', amount: 0, cur: 'DOP' }, 'x')).toBeNull();
    expect(newFixed(s, OCT, { name: 'Gym', amount: Number.NaN, cur: 'DOP' }, 'x')).toBeNull();
    expect(newFixed(s, '2030-01', { name: 'Gym', amount: 10, cur: 'DOP' }, 'x')).toBeNull();
    expect(newFixed(s, OCT, { name: 'Gym', amount: 10, cur: 'DOP', accountId: 'gone' }, 'x')).toBeNull();
    expect(newFixed(s, OCT, { name: ' Gym ', day: ' 12 ', amount: 10, cur: 'DOP' }, 'x')).toEqual({
      id: 'x',
      monthKey: OCT,
      name: 'Gym',
      day: '12',
      amount: 10,
      cur: 'DOP',
      paid: false,
      accountId: 'dr',
      sort: 11,
    });
    expect(newFixed(s, OCT, { name: 'Claude', amount: 20, cur: 'USD', accountId: 'us' }, 'x')!.accountId).toBe('us');
  });

  it('with no account given it gets the default account of the user (shared/calc defaultAccount)', () => {
    const tx = { date: '2026-10-07', desc: 'Café', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP' as const };
    expect(newTx(s, OCT, tx, 'x')!.accountId).toBe('dr');
    // With no saved choice: the first visible one in the main currency.
    expect(newTx({ ...s, defaultAccountId: null, mainCurrency: 'USD', secondCurrency: 'DOP' }, OCT, tx, 'x')!.accountId).toBe('us');
    // The chosen one is hidden: it does not count.
    const hidden = { ...s, accounts: s.accounts.map((a) => (a.id === 'dr' ? { ...a, hidden: true } : a)) };
    expect(newTx(hidden, OCT, tx, 'x')!.accountId).toBe('us');
    expect(newIncome(hidden, { date: '2026-10-07', amount: 1, cur: 'USD' }, 'x')!.accountId).toBe('us');
    // With no account at all there is nothing to pay from.
    expect(newTx({ ...s, accounts: [] }, OCT, tx, 'x')).toBeNull();
    expect(newFixed({ ...s, accounts: [] }, OCT, { name: 'Gym', amount: 1, cur: 'DOP' }, 'x')).toBeNull();
  });

  it('transaction: description, valid date, amount > 0 and an account that exists', () => {
    const ok = { date: '2026-10-07', desc: 'Café', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP' as const };
    expect(newTx(s, OCT, ok, 'x')).not.toBeNull();
    expect(newTx(s, OCT, { ...ok, desc: ' ' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, amount: -5 }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, date: '' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, date: '2026-02-30' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, accountId: 'gone' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, cur: 'EUR' as 'USD' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, cur: 'TRY', accountId: 'us' }, 'x')).toMatchObject({ cur: 'TRY', accountId: 'us' });
    // The sheet decides: a date in another month does not change which month it belongs to.
    expect(newTx(s, OCT, { ...ok, date: '2026-11-01' }, 'x')!.monthKey).toBe(OCT);
  });

  it('transfer: via, date, amount > 0 and two different accounts that exist', () => {
    const ok = { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 58.7 };
    // Without `budget` the transfer does not move budget; without `fee`, it has no fee.
    expect(newTransfer(s, OCT, ok, 'x')).toEqual({ id: 'x', monthKey: OCT, ...ok, budget: false, fee: 0 });
    expect(newTransfer(s, OCT, { ...ok, fee: 2.99 }, 'x')).toMatchObject({ fee: 2.99 });
    expect(newTransfer(s, OCT, { ...ok, fee: -1 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, fee: Number.NaN }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, budget: true }, 'x')).toMatchObject({ budget: true });
    expect(newTransfer(s, OCT, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, rate: 0 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, rate: -1 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, date: '2026-13-01' }, 'x')).toBeNull();
    expect(newTransfer(s, '2030-01', ok, 'x')).toBeNull();
    // The same account on both sides, or one that does not exist.
    expect(newTransfer(s, OCT, { ...ok, toAccountId: 'us' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, fromAccountId: 'gone' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, toAccountId: 'gone' }, 'x')).toBeNull();
    // The other direction is valid too: from the DR account to the US account.
    expect(newTransfer(s, OCT, { ...ok, fromAccountId: 'dr', toAccountId: 'us', rate: 1 / 59 }, 'x')).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    // The via is free text: any name is valid, without extra spaces, but it cannot be missing or too long.
    expect(newTransfer(s, OCT, { ...ok, via: '  Western Union ' }, 'x')!.via).toBe('Western Union');
    expect(newTransfer(s, OCT, { ...ok, via: '   ' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, via: 'x'.repeat(61) }, 'x')).toBeNull();
  });

  it('transfer without a rate: the one in effect on its date for that pair; between accounts in the same currency, always 1', () => {
    const base = { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 500 };
    expect(newTransfer(s, OCT, base, 'x')!.rate).toBe(58.76);
    expect(newTransfer(s, OCT, { ...base, fromAccountId: 'dr', toAccountId: 'us' }, 'x')!.rate).toBeCloseTo(1 / 58.76, 12);
    // August has no typed rate, and there was none before: the one from its transfers.
    expect(newTransfer(s, '2026-08', { ...base, date: '2026-08-20' }, 'x')!.rate).toBeCloseTo(rateFor(s, '2026-08', 'USD', 'DOP').rate, 12);

    // With two typed rates in the month (58 from day 1, 60 from day 6), the transfer's date decides.
    const dated = twoRates();
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03' }, 'x')!.rate).toBe(58);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-05' }, 'x')!.rate).toBe(58);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-06' }, 'x')!.rate).toBe(60);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-28' }, 'x')!.rate).toBe(60);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03', fromAccountId: 'dr', toAccountId: 'us' }, 'x')!.rate).toBeCloseTo(1 / 58, 12);
    // The one typed by hand on the transfer wins over either of the two.
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03', rate: 57.5 }, 'x')!.rate).toBe(57.5);

    const two = { ...s, accounts: [...s.accounts, newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')!] };
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp' }, 'x')!.rate).toBe(1);
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp', rate: 58 }, 'x')!.rate).toBe(1);
  });

  it('income: valid date, amount > 0 and an account that exists; it does not belong to a month', () => {
    const ok = { date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD' as const };
    expect(newIncome(s, ok, 'x')).toEqual({ id: 'x', ...ok, budget: false, rate: null, recurring: false });
    expect(newIncome(s, { ...ok, desc: undefined }, 'x')!.desc).toBe('');
    // It raises the budget only if checked.
    expect(newIncome(s, { ...ok, budget: true }, 'x')).toEqual({ id: 'x', ...ok, budget: true, rate: null, recurring: false });
    expect(newIncome(s, { ...ok, budget: false }, 'x')!.budget).toBe(false);
    expect(newIncome(s, { ...ok, budget: undefined }, 'x')!.budget).toBe(false);
    expect(newIncome(s, { ...ok, budget: 'yes' as unknown as boolean }, 'x')!.budget).toBe(false);
    // Checked, it is also valid with a date in a closed month: it does not belong to the month.
    expect(newIncome(s, { ...ok, date: '2026-09-15', budget: true }, 'x')).toMatchObject({ date: '2026-09-15', budget: true });
    expect(newIncome(s, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, date: '2026-02-30' }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, accountId: 'gone' }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, desc: 'x'.repeat(201) }, 'x')).toBeNull();
    // It is valid with a date in a closed month and in one that does not exist.
    expect(newIncome(s, { ...ok, date: '2026-08-15' }, 'x')).not.toBeNull();
    expect(newIncome(s, { ...ok, date: '2027-03-01' }, 'x')).not.toBeNull();
  });

  it('contribution: amount > 0 and a goal that exists', () => {
    const ok = { goalId: 'turkey', date: '2026-10-07', amount: 3000, cur: 'USD' as const };
    expect(newContribution(s, ok, 'x')).toEqual({ id: 'x', ...ok, rate: null, accountId: null });
    expect(newContribution(s, { ...ok, cur: 'TRY' }, 'x')).toMatchObject({ cur: 'TRY' });
    expect(newContribution(s, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newContribution(s, { ...ok, goalId: 'marte' }, 'x')).toBeNull();
  });

  it('account: name, one of the three currencies and a finite opening balance (it can be negative)', () => {
    expect(newAccount(s, { name: 'PayPal', currency: 'USD' }, 'x')).toEqual({ id: 'x', name: 'PayPal', currency: 'USD', opening: 0, hidden: false, sort: 2 });
    expect(newAccount(s, { name: 'Card', currency: 'DOP', opening: -2500.5 }, 'x')!.opening).toBe(-2500.5);
    expect(newAccount(s, { name: '  ', currency: 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'x'.repeat(121), currency: 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'Euro', currency: 'EUR' as 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'PayPal', currency: 'USD', opening: Number.NaN }, 'x')).toBeNull();
    expect(newAccount({ ...s, accounts: [] }, { name: 'First', currency: 'TRY' }, 'x')!.sort).toBe(0);
  });
});

describe('cell edits: what the server would reject is ignored and the rest is saved', () => {
  const s = seedState();
  const transfer = s.months[OCT]!.transfers[0]!;

  it('fixed expense and transaction', () => {
    expect(fixedChange(s, { name: '', amount: 99 })).toEqual({ amount: 99 });
    expect(fixedChange(s, { name: 'Gym', amount: -1, paid: true })).toEqual({ name: 'Gym', paid: true });
    expect(fixedChange(s, { accountId: 'gone' })).toEqual({});
    expect(fixedChange(s, { accountId: 'us', amount: 0 })).toEqual({ accountId: 'us', amount: 0 });
    expect(txChange(s, { desc: '  ', notes: '' })).toEqual({ notes: '' });
    expect(txChange(s, { date: '2026-02-30', amount: Number.NaN, accountId: 'gone', cat: 'Travel' })).toEqual({ cat: 'Travel' });
    // A valid patch passes through as is (it is the same object).
    const ok = { desc: 'Uber', accountId: 'us', cur: 'TRY' as const };
    expect(txChange(s, ok)).toBe(ok);
  });

  it('income and contribution', () => {
    expect(incomeChange(s, 'seed-in-1', { amount: -5, desc: '' })).toEqual({ desc: '' });
    expect(incomeChange(s, 'seed-in-1', { accountId: 'gone', date: 'ayer', amount: 10 })).toEqual({ amount: 10 });
    // The "raises the budget" checkbox passes in both directions; anything that is not a boolean does not.
    expect(incomeChange(s, 'seed-in-1', { budget: true })).toEqual({ budget: true });
    expect(incomeChange(s, 'seed-in-1', { budget: false, amount: -1 })).toEqual({ budget: false });
    expect(incomeChange(s, 'seed-in-1', { budget: 'yes' as unknown as boolean, desc: 'Bonus' })).toEqual({ desc: 'Bonus' });
    expect(contributionChange(s, { goalId: 'marte', amount: 10 })).toEqual({ amount: 10 });
    expect(contributionChange(s, { goalId: 'personal', date: '2026-10-09', amount: -1, cur: 'DOP' })).toEqual({ goalId: 'personal', date: '2026-10-09', cur: 'DOP' });
  });

  it('transfer: via, date, amount and rate', () => {
    expect(transferChange(s, transfer.id, { via: 'Wise', amount: 1600, rate: 58.9, date: '2026-10-03' })).toEqual({
      via: 'Wise',
      amount: 1600,
      rate: 58.9,
      date: '2026-10-03',
    });
    expect(transferChange(s, transfer.id, { via: '  ', amount: -1, rate: 0, date: 'x' })).toEqual({});
    expect(transferChange(s, 'nope', { amount: 5 })).toEqual({});
  });

  it('transfer: an account change has to leave two different accounts that exist', () => {
    expect(transferChange(s, transfer.id, { toAccountId: 'us' })).toEqual({});
    expect(transferChange(s, transfer.id, { fromAccountId: 'gone' })).toEqual({});
    // The transfer is reversed in a single edit: both accounts change at once.
    expect(transferChange(s, transfer.id, { fromAccountId: 'dr', toAccountId: 'us' })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      rate: rateFor(s, OCT, 'DOP', 'USD').rate,
    });
    // The rest of the patch is saved even if the account change is not valid.
    expect(transferChange(s, transfer.id, { toAccountId: 'us', amount: 900 })).toEqual({ amount: 900 });
  });

  it('transfer: if the currencies change, the rate becomes the month rate for the new pair (1 between equal currencies)', () => {
    const more: AppState = {
      ...s,
      accounts: [...s.accounts, newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')!, { ...newAccount(s, { name: 'Popular', currency: 'DOP' }, 'bp')!, sort: 3 }],
    };
    // Same currency on both sides: 1, and a typed rate does not change it.
    expect(transferChange(more, transfer.id, { toAccountId: 'pp' })).toEqual({ toAccountId: 'pp', rate: 1 });
    expect(transferChange(more, transfer.id, { toAccountId: 'pp', rate: 58 })).toEqual({ toAccountId: 'pp', rate: 1 });
    // Another account in the same currency: the transfer's currencies do not change and the rate stays.
    expect(transferChange(more, transfer.id, { toAccountId: 'bp' })).toEqual({ toAccountId: 'bp' });
    expect(transferChange(more, transfer.id, { fromAccountId: 'pp' })).toEqual({ fromAccountId: 'pp' });
    // If a rate comes with the change, the typed one wins.
    expect(transferChange(more, transfer.id, { fromAccountId: 'dr', toAccountId: 'us', rate: 0.0171 })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      rate: 0.0171,
    });
  });

  it('transfer: the rate of the new pair is the one in effect on the transfer date (the new date, if it changes at the same time)', () => {
    // The October transfer is from day 2: between the rate of day 1 (58) and that of day 6 (60).
    const dated = twoRates();
    const flipped = transferChange(dated, transfer.id, { fromAccountId: 'dr', toAccountId: 'us' });
    expect(flipped.rate).toBeCloseTo(1 / 58, 12);
    const moved = transferChange(dated, transfer.id, { fromAccountId: 'dr', toAccountId: 'us', date: '2026-10-08' });
    expect(moved).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', date: '2026-10-08' });
    expect(moved.rate).toBeCloseTo(1 / 60, 12);
    // Changing only the date does not touch the rate: the transfer's rate is the one that was actually used.
    expect(transferChange(dated, transfer.id, { date: '2026-10-08' })).toEqual({ date: '2026-10-08' });
  });
});

describe('accounts: rules', () => {
  const s = seedState();
  const withSpare = (): AppState => ({ ...s, accounts: [...s.accounts, newAccount(s, { name: 'Spare', currency: 'TRY' }, 'spare')!] });

  it('accountName: the name is required', () => {
    expect(accountName(s, 'us', 'Chase')).toBe('Chase');
    expect(accountName(s, 'us', '   ')).toBeNull();
    expect(accountName(s, 'us', 'x'.repeat(121))).toBeNull();
    expect(accountName(s, 'gone', 'Chase')).toBeNull();
  });

  it('accountInUse / canRemoveAccount: only an account that nothing names can be deleted', () => {
    expect(accountInUse(s, 'us')).toBe(true);
    expect(accountInUse(s, 'dr')).toBe(true);
    expect(canRemoveAccount(s, 'us')).toBe(false);
    expect(canRemoveAccount(s, 'gone')).toBe(false);
    const spare = withSpare();
    expect(accountInUse(spare, 'spare')).toBe(false);
    expect(canRemoveAccount(spare, 'spare')).toBe(true);

    // Each thing that can name it, separately.
    const uses: Action[] = [
      { type: 'month/patch', key: '2026-08', patch: { budgets: { spare: 100 } } },
      { type: 'budget/add', key: OCT, row: { id: 'bg-spare', date: '2026-10-09', accountId: 'spare', amount: -5, kind: 'adjust', note: '' } },
      { type: 'fixed/patch', id: s.months[OCT]!.fixed[0]!.id, patch: { accountId: 'spare' } },
      { type: 'tx/patch', id: s.months['2026-09']!.tx[0]!.id, patch: { accountId: 'spare' } },
      { type: 'transfer/patch', id: s.months[OCT]!.transfers[0]!.id, patch: { toAccountId: 'spare' } },
      { type: 'transfer/patch', id: s.months[OCT]!.transfers[0]!.id, patch: { fromAccountId: 'spare' } },
      { type: 'income/patch', id: s.incomes[0]!.id, patch: { accountId: 'spare' } },
    ];
    for (const use of uses) expect(canRemoveAccount(reduce(spare, use), 'spare'), use.type).toBe(false);
    // What counts is the log, not the sum: a part that was set to zero still names the account.
    const zeroed = reduce(reduce(spare, uses[0]!), { type: 'month/patch', key: '2026-08', patch: { budgets: { spare: 0 } } });
    expect(zeroed.months['2026-08']!.budgets).toEqual({ dr: 70000 });
    expect(canRemoveAccount(zeroed, 'spare')).toBe(false);
    // Being the default account is a preference, not a movement.
    expect(canRemoveAccount({ ...spare, defaultAccountId: 'spare' }, 'spare')).toBe(true);
  });

  it('canHideAccount: any visible one except the last', () => {
    expect(canHideAccount(s, 'us')).toBe(true);
    expect(canHideAccount(s, 'gone')).toBe(false);
    const one = reduce(s, { type: 'account/patch', id: 'us', patch: { hidden: true } });
    expect(canHideAccount(one, 'dr')).toBe(false);
    expect(canHideAccount(one, 'us')).toBe(false);
  });

  it('openingForBalance: the opening balance that makes the account show the typed balance', () => {
    expect(latestKey(s)).toBe(OCT);
    // DR account: balance 220,641.93 with an opening of 60,000 (shared/calc.test.ts). To show 200,000 it takes 39,358.07.
    const opening = openingForBalance(s, OCT, 'dr', 200000)!;
    expect(opening).toBeCloseTo(39358.07, 6);
    const fixed = reduce(s, { type: 'account/patch', id: 'dr', patch: { opening } });
    expect(balanceOf(fixed, 'dr')).toBeCloseTo(200000, 6);
    // Correcting again starts from the already corrected balance.
    const again = openingForBalance(fixed, OCT, 'dr', 150000.5)!;
    expect(balanceOf(reduce(fixed, { type: 'account/patch', id: 'dr', patch: { opening: again } }), 'dr')).toBeCloseTo(150000.5, 6);
    // The balance can end up at zero or negative.
    expect(balanceOf(reduce(s, { type: 'account/patch', id: 'us', patch: { opening: openingForBalance(s, OCT, 'us', -250)! } }), 'us')).toBeCloseTo(-250, 8);
    // Typing the balance it already has leaves the opening where it was.
    expect(openingForBalance(s, OCT, 'us', 13482)).toBeCloseTo(2000, 8);
  });

  it('openingForBalance: only in the latest month of the user; a past balance is history', () => {
    expect(openingForBalance(s, '2026-09', 'dr', 200000)).toBeNull();
    expect(openingForBalance(s, '2026-08', 'us', 1)).toBeNull();
    expect(openingForBalance(s, OCT, 'gone', 1)).toBeNull();
    expect(openingForBalance(s, OCT, 'dr', Number.NaN)).toBeNull();
    // The latest month counts even if it is closed: accounts do not belong to a month.
    const closed = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, closed: true } } };
    expect(openingForBalance(closed, OCT, 'dr', 200000)).toBeCloseTo(39358.07, 6);
    // If October is deleted, September becomes the latest.
    const sep = removeMonth(s, OCT);
    expect(latestKey(sep)).toBe('2026-09');
    expect(openingForBalance(sep, '2026-09', 'us', 100)).not.toBeNull();
    expect(latestKey({ ...s, months: {} })).toBeNull();
  });

  it('budgetPart and monthRate: an open month, an account or a pair that exist and a valid number', () => {
    expect(budgetPart(s, OCT, 'us', 200)).toEqual({ budgets: { us: 200 } });
    expect(budgetPart(s, OCT, 'us', 0)).toEqual({ budgets: { us: 0 } });
    expect(budgetPart(s, OCT, 'us', -50)).toBeNull(); // the API only accepts parts >= 0
    expect(budgetPart(s, OCT, 'gone', 200)).toBeNull();
    expect(budgetPart(s, OCT, 'us', Number.POSITIVE_INFINITY)).toBeNull();
    expect(budgetPart(s, '2026-09', 'us', 200)).toBeNull(); // closed
    expect(budgetPart(s, '2030-01', 'us', 200)).toBeNull();

    expect(monthRate(s, OCT, 'USD', 'TRY', 40, '2026-10-07')).toEqual({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' });
    expect(monthRate(s, OCT, 'USD', 'USD', 1, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', 0, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', -3, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'EUR' as 'TRY', 1.1, '2026-10-07')).toBeNull();
    expect(monthRate(s, '2026-09', 'USD', 'TRY', 40, '2026-09-07')).toBeNull();
  });

  it('monthRate: the date has to be a real date and fall within the month', () => {
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-01')).toMatchObject({ date: '2026-10-01' });
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-31')).toMatchObject({ date: '2026-10-31' });
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-09-30')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-11-01')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-32')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, undefined as unknown as string)).toBeNull();
  });

  it('budgetPart: the amount is the part as it is shown; what gets sent is what the log must add up to', () => {
    // An income of 10,000 DOP raises the DR account's budget: it shows 80,000 (70,000 + 10,000).
    const raised = withBudgetIncome();
    expect(partOf(raised, 'dr')).toMatchObject({ amount: 80000, fromLog: 70000, fromIncomes: 10000 });
    expect(budgetPart(raised, OCT, 'dr', 85000)).toEqual({ budgets: { dr: 75000 } });
    // Typing what is already shown leaves the log where it was.
    expect(budgetPart(raised, OCT, 'dr', 80000)).toEqual({ budgets: { dr: 70000 } });
    expect(reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 80000)! })).toBe(raised);
    // Once applied, the part shows what was typed.
    const next = reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 85000)! });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
    // The income belongs to the DR account: the other account's part does not subtract it.
    expect(budgetPart(raised, OCT, 'us', 200)).toEqual({ budgets: { us: 200 } });
  });

  it('budgetPart: what a checked transfer moves is subtracted the same way as that of an income, in both of its accounts', () => {
    // Besides the 10,000 income, the October transfer (88,140 DOP received) raises the DR account's part.
    const raised = reduce(withBudgetIncome(), { type: 'transfer/patch', id: 'seed-tr-2026-10-1', patch: { budget: true } });
    expect(partOf(raised, 'dr')).toMatchObject({ amount: 168140, fromLog: 70000, fromIncomes: 10000, fromTransfers: 88140 });
    expect(budgetPart(raised, OCT, 'dr', 170000)).toEqual({ budgets: { dr: 71860 } });
    expect(budgetPart(raised, OCT, 'dr', 168140)).toEqual({ budgets: { dr: 70000 } });
    // Below what the income and the transfer already add up to, the log would end up negative: not allowed.
    expect(budgetPart(raised, OCT, 'dr', 98139)).toBeNull();
    expect(budgetPart(raised, OCT, 'dr', 98140)).toEqual({ budgets: { dr: 0 } });
    // 1,500 USD left the origin account: its part shows −1,500 and, for it to show 200, the log adds up to 1,700.
    expect(partOf(raised, 'us')).toMatchObject({ amount: -1500, fromLog: 0, fromTransfers: -1500 });
    expect(budgetPart(raised, OCT, 'us', 200)).toEqual({ budgets: { us: 1700 } });
    expect(budgetPart(raised, OCT, 'us', 0)).toEqual({ budgets: { us: 1500 } });
    expect(budgetPart(raised, OCT, 'us', -1500)).toBeNull();
    const next = reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 170000)! });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 170000, fromLog: 71860, fromTransfers: 88140 });
    const us = reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'us', 200)! });
    expect(partOf(us, 'us')).toMatchObject({ amount: 200, fromLog: 1700, fromTransfers: -1500 });
  });

  it('transferChange: the budget checkbox is sent as is, checked or unchecked', () => {
    const s = seedState();
    const id = s.months[OCT]!.transfers[0]!.id;
    expect(transferChange(s, id, { budget: true })).toEqual({ budget: true });
    expect(transferChange(s, id, { budget: false, amount: 900 })).toEqual({ budget: false, amount: 900 });
    expect(transferChange(s, id, { budget: 'yes' as unknown as boolean })).toEqual({});
    // Checking it moves budget from one account to another (with the month rate, the total does not change), not the balances.
    const on = reduce(s, { type: 'transfer/patch', id, patch: transferChange(s, id, { budget: true }) });
    expect(monthCalc(on, OCT).budget).toBeCloseTo(70000, 8);
    expect(monthCalc(on, OCT).budgetParts.map((p) => p.amount)).toEqual([-1500, 158140]);
    expect(balances(on, OCT)).toEqual(balances(s, OCT));
  });

  it('transferChange: the fee, >= 0; an invalid one is ignored', () => {
    const s = seedState();
    const id = s.months[OCT]!.transfers[0]!.id;
    expect(transferChange(s, id, { fee: 2.99 })).toEqual({ fee: 2.99 });
    expect(transferChange(s, id, { fee: 0 })).toEqual({ fee: 0 });
    expect(transferChange(s, id, { fee: -1 })).toEqual({});
    expect(transferChange(s, id, { fee: Number.POSITIVE_INFINITY })).toEqual({});
    // Once applied, it is subtracted from the origin account and counts toward the month's used amount.
    const on = reduce(s, { type: 'transfer/patch', id, patch: { fee: 2.99 } });
    expect(balances(on, OCT).accounts[0]!.balance).toBeCloseTo(balances(s, OCT).accounts[0]!.balance - 2.99, 10);
    expect(monthCalc(on, OCT).used - monthCalc(s, OCT).used).toBeCloseTo(2.99 * 58.76, 8);
  });

  it('budgetPart: below what the incomes already add up to is not allowed (the log would end up negative)', () => {
    const raised = withBudgetIncome();
    // Exactly what the incomes add: the log ends up at zero.
    expect(budgetPart(raised, OCT, 'dr', 10000)).toEqual({ budgets: { dr: 0 } });
    expect(budgetPart(raised, OCT, 'dr', 9999.99)).toBeNull();
    expect(budgetPart(raised, OCT, 'dr', 0)).toBeNull();
    // Without that income, 0 is valid.
    expect(budgetPart(s, OCT, 'dr', 0)).toEqual({ budgets: { dr: 0 } });
  });

  it('budgetPart: an income in another currency counts converted to that of the account, with the rate of its date', () => {
    // 100 USD received on day 3 in the DR account, with 58 until day 6 and 60 after: they add 5,800, not 6,000.
    const dated = twoRates();
    dated.incomes.push({ id: 'in-usd', date: '2026-10-03', desc: '', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    expect(partOf(dated, 'dr').fromIncomes).toBe(5800);
    expect(budgetPart(dated, OCT, 'dr', 80000)).toEqual({ budgets: { dr: 74200 } });
    expect(budgetPart(dated, OCT, 'dr', 5800)).toEqual({ budgets: { dr: 0 } });
    expect(budgetPart(dated, OCT, 'dr', 5799)).toBeNull();
  });

  it('budgetPart: only checked incomes dated in that month count', () => {
    expect(budgetPart(withBudgetIncome({ budget: false }), OCT, 'dr', 5000)).toEqual({ budgets: { dr: 5000 } });
    expect(budgetPart(withBudgetIncome({ date: '2026-09-28' }), OCT, 'dr', 5000)).toEqual({ budgets: { dr: 5000 } });
    expect(budgetPart(withBudgetIncome({ accountId: 'us', cur: 'USD', amount: 300 }), OCT, 'us', 500)).toEqual({ budgets: { us: 200 } });
  });

  it('typedRate: the typed rate for the pair and the date, in the direction it was stored', () => {
    expect(typedRate(s, OCT, 'USD', 'DOP', '2026-10-06')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' });
    expect(typedRate(s, OCT, 'DOP', 'USD', '2026-10-01')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' });
    // It is the one typed that day, not the one in effect that day.
    expect(typedRate(s, OCT, 'USD', 'DOP', '2026-10-03')).toBeNull();
    expect(typedRate(s, OCT, 'USD', 'TRY', '2026-10-06')).toBeNull();
    expect(typedRate(s, '2026-08', 'USD', 'DOP', '2026-08-01')).toBeNull();
    // A closed month does not let its rates be removed.
    const closed = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, closed: true } } };
    expect(typedRate(closed, OCT, 'USD', 'DOP', '2026-10-06')).toBeNull();
  });

  it('newBudgetEntry: an account that exists, an amount other than 0 and a date in the month', () => {
    const today = '2026-10-07';
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 2500 }, 'x', today)).toEqual({ id: 'x', date: today, accountId: 'dr', amount: 2500, kind: 'adjust', note: '' });
    expect(newBudgetEntry(s, OCT, { accountId: 'us', amount: -40.5, date: '2026-10-20', kind: 'initial', note: '  Trip  ' }, 'x', today)).toEqual({
      id: 'x',
      date: '2026-10-20',
      accountId: 'us',
      amount: -40.5,
      kind: 'initial',
      note: 'Trip',
    });
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 0 }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: Number.NaN }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: Number.POSITIVE_INFINITY }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'gone', amount: 1 }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1, date: '2026-11-01' }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1, date: '2026-10-32' }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1, note: 'x'.repeat(201) }, 'x', today)).toBeNull();
    expect(newBudgetEntry(s, '2026-09', { accountId: 'dr', amount: 1 }, 'x', '2026-09-07')).toBeNull(); // closed
    expect(newBudgetEntry(s, '2030-01', { accountId: 'dr', amount: 1 }, 'x', today)).toBeNull();
  });

  it('newBudgetEntry: without a date it is today, moved into the month if it falls outside', () => {
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2026-11-03')!.date).toBe('2026-10-31');
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2026-09-29')!.date).toBe('2026-10-01');
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2027-01-15')!.date).toBe('2026-10-31');
  });

  it('budgetEntry / isLocalEntry: only a movement that already has a server id, in an open month, can be removed', () => {
    expect(budgetEntry(s, OCT, 'seed-bg-2026-10-2')).toBe(s.months[OCT]!.budgetLog[1]);
    expect(budgetEntry(s, OCT, 'nope')).toBeNull();
    expect(budgetEntry(s, '2026-09', 'seed-bg-2026-09-1')).toBeNull(); // closed
    expect(budgetEntry(s, '2030-01', 'seed-bg-2026-10-2')).toBeNull();
    // The one month/patch adds here has no id yet: the server assigns it.
    const patched = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 200 } } });
    const local = patched.months[OCT]!.budgetLog.at(-1)!;
    expect(local.id.startsWith(LOCAL_ENTRY)).toBe(true);
    expect(isLocalEntry(local.id)).toBe(true);
    expect(budgetEntry(patched, OCT, local.id)).toBeNull();
    expect(isLocalEntry('seed-bg-2026-10-2')).toBe(false);
    expect(isLocalEntry('')).toBe(false);
  });

  it('leftoverEntry: what was left over from the previous month, in the default account and in its currency', () => {
    // September: budget − used, in the main currency (DOP). The default account is the DR account (DOP).
    const sep = monthCalc(s, '2026-09').avail;
    expect(sep).toBeGreaterThan(0);
    expect(leftoverEntry(s, OCT, 'local-lo', '2026-10-07')).toEqual({ id: 'local-lo', date: '2026-10-07', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    // Today outside the month: the date is moved into the month.
    expect(leftoverEntry(s, OCT, 'x', '2026-11-02')!.date).toBe('2026-10-31');
    expect(leftoverEntry(s, OCT, 'x', '2026-09-30')!.date).toBe('2026-10-01');
  });

  it('leftoverEntry: with the default account in another currency, converted with the last rate of the month', () => {
    const sep = monthCalc(s, '2026-09').avail;
    const usd = leftoverEntry({ ...s, defaultAccountId: 'us' }, OCT, 'x', '2026-10-07')!;
    expect(usd).toMatchObject({ accountId: 'us', kind: 'leftover' });
    expect(usd.amount).toBeCloseTo(sep / 58.76, 10);
    // The last one of the month (60), not the one in effect today (58): on day 3 the one from day 1 still applies.
    const dated = { ...twoRates(), defaultAccountId: 'us' };
    expect(leftoverEntry(dated, OCT, 'x', '2026-10-03')!.amount).toBeCloseTo(monthCalc(dated, '2026-09').avail / 60, 10);
    // With another main currency the leftover already comes in it: it goes into an account in that currency as is.
    const main = { ...s, mainCurrency: 'USD' as const, secondCurrency: 'DOP' as const, defaultAccountId: 'us' };
    expect(leftoverEntry(main, OCT, 'x', '2026-10-07')!.amount).toBe(monthCalc(main, '2026-09').avail);
    // With no chosen account: the automatic one (shared/calc defaultAccount).
    expect(leftoverEntry({ ...s, defaultAccountId: null }, OCT, 'x', '2026-10-07')!.accountId).toBe('dr');
  });

  it('leftoverEntry: if the previous month went over budget, the movement is negative', () => {
    const over = seedState();
    setBudgets(over.months['2026-09']!, { dr: 1000 });
    const row = leftoverEntry(over, OCT, 'x', '2026-10-07')!;
    expect(row.amount).toBe(monthCalc(over, '2026-09').avail);
    expect(row.amount).toBeLessThan(0);
    expect(monthCalc(reduce(over, { type: 'budget/leftover', key: OCT, row }), OCT).budget).toBeCloseTo(70000 + row.amount, 8);
  });

  it('leftoverEntry: null if there is nothing to add or it is not allowed', () => {
    // Closed month.
    expect(leftoverEntry(s, '2026-09', 'x', '2026-09-07')).toBeNull();
    // Month that does not exist.
    expect(leftoverEntry(s, '2026-11', 'x', '2026-11-07')).toBeNull();
    // No previous month.
    const only = { ...s, months: { [OCT]: s.months[OCT]! } };
    expect(leftoverFor(only, OCT)).toEqual({ previousKey: null, leftover: null, added: false });
    expect(leftoverEntry(only, OCT, 'x', '2026-10-07')).toBeNull();
    // Already added.
    const added = reduce(s, { type: 'budget/leftover', key: OCT, row: leftoverEntry(s, OCT, 'x', '2026-10-07')! });
    expect(leftoverEntry(added, OCT, 'y', '2026-10-08')).toBeNull();
    // With no accounts there is nowhere to put it.
    expect(leftoverEntry({ ...s, accounts: [] }, OCT, 'x', '2026-10-07')).toBeNull();
    // Nothing was left over: the previous month used exactly its budget.
    const even = seedState();
    const sep = even.months['2026-09']!;
    sep.fixed = [];
    sep.tx = [{ ...sep.tx[0]!, amount: 1000 }];
    setBudgets(sep, { dr: 1000 });
    expect(monthCalc(even, '2026-09').avail).toBe(0);
    expect(leftoverEntry(even, OCT, 'x', '2026-10-07')).toBeNull();
  });

  it('leftoverEntry: the previous month is the closest recorded one, even if it is not the calendar one', () => {
    const gap = removeMonth(s, '2026-09');
    expect(leftoverFor(gap, OCT).previousKey).toBe('2026-08');
    expect(leftoverEntry(gap, OCT, 'x', '2026-10-07')!.amount).toBe(monthCalc(gap, '2026-08').avail);
  });

  it('currencyChange: the two currencies always end up different', () => {
    const none = { ...s, secondCurrency: null };
    // Main DOP, second USD.
    expect(currencyChange(s, 'main', 'TRY')).toEqual({ mainCurrency: 'TRY' });
    expect(currencyChange(s, 'second', 'TRY')).toEqual({ secondCurrency: 'TRY' });
    // Choosing the second one as main leaves the second as none; choosing the main one as second swaps them.
    expect(currencyChange(s, 'main', 'USD')).toEqual({ mainCurrency: 'USD', secondCurrency: null });
    expect(currencyChange(s, 'second', 'DOP')).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    // Removing the second; with no second there is nothing left to remove or to swap with.
    expect(currencyChange(s, 'second', null)).toEqual({ secondCurrency: null });
    expect(currencyChange(none, 'second', null)).toEqual({});
    expect(currencyChange(none, 'second', 'DOP')).toEqual({});
    expect(currencyChange(none, 'main', 'TRY')).toEqual({ mainCurrency: 'TRY' });
    expect(currencyChange(s, 'main', null)).toBeNull();
    // The one already set changes nothing.
    expect(currencyChange(s, 'main', 'DOP')).toEqual({});
    expect(currencyChange(s, 'second', 'USD')).toEqual({});
    expect(currencyChange(s, 'main', 'EUR' as 'USD')).toBeNull();
  });
});

describe('goals: the plan rule', () => {
  const s = seedState();
  const plan = { monthly: 500, start: '2026-10', end: '2027-09' };

  it('normalizeGoalPlan: no plan or all three values together', () => {
    const none = { monthly: null, start: null, end: null };
    expect(normalizeGoalPlan({})).toEqual(none);
    expect(normalizeGoalPlan(none)).toEqual(none);
    expect(normalizeGoalPlan(plan)).toEqual(plan);
    // A single month: start = end.
    expect(normalizeGoalPlan({ monthly: 0.01, start: '2026-10', end: '2026-10' })).toEqual({ monthly: 0.01, start: '2026-10', end: '2026-10' });
  });

  it('normalizeGoalPlan: a partial or impossible plan is not valid', () => {
    for (const bad of [
      { monthly: 500 },
      { start: '2026-10', end: '2027-09' },
      { ...plan, end: null },
      { ...plan, start: null },
      { ...plan, monthly: null },
      { ...plan, monthly: 0 },
      { ...plan, monthly: -5 },
      { ...plan, monthly: Number.NaN },
      { ...plan, monthly: Number.POSITIVE_INFINITY },
      { ...plan, start: '2027-10' },
      { ...plan, start: '2026-13' },
      { ...plan, end: '2027-9' },
      { ...plan, end: 'October 2027' },
      { monthly: 0, start: null, end: null },
    ]) {
      expect(normalizeGoalPlan(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('newGoal: required name, valid plan and a currency (the main one by default)', () => {
    expect(newGoal(s, { name: 'Car' }, 'x')).toEqual({ id: 'x', name: 'Car', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 3 });
    expect(newGoal(s, { name: 'Car', cur: 'TRY', ...plan }, 'x')).toMatchObject({ cur: 'TRY', ...plan });
    expect(newGoal({ ...s, mainCurrency: 'USD', secondCurrency: 'DOP' }, { name: 'Car' }, 'x')!.cur).toBe('USD');
    expect(newGoal(s, { name: '   ' }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'x'.repeat(121) }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', monthly: 500 }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', ...plan, start: '2028-01' }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', cur: 'EUR' as 'USD' }, 'x')).toBeNull();
    // With no goals, the first one gets sort 0.
    expect(newGoal({ ...s, goals: [] }, { name: 'Car' }, 'x')!.sort).toBe(0);
  });

  it('newGoal: the currency of the "≈" line is optional; null or not given, the main one of the user', () => {
    expect(newGoal(s, { name: 'Car' }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', approxCur: null }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', approxCur: undefined }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', cur: 'USD', approxCur: 'TRY', ...plan }, 'x')).toMatchObject({ cur: 'USD', approxCur: 'TRY', ...plan });
    // It can be any of the three, including the goal's own or the main one.
    expect(newGoal(s, { name: 'Car', cur: 'USD', approxCur: 'USD' }, 'x')!.approxCur).toBe('USD');
    expect(newGoal(s, { name: 'Car', approxCur: 'DOP' }, 'x')!.approxCur).toBe('DOP');
    expect(newGoal(s, { name: 'Car', approxCur: 'EUR' as 'USD' }, 'x')).toBeNull();
  });

  it('goalChange: the currency of the "≈" line, with null as one more value', () => {
    expect(goalChange(s, 'turkey', { approxCur: 'TRY' })).toEqual({ approxCur: 'TRY' });
    // It was already null: there is nothing to send.
    expect(goalChange(s, 'turkey', { approxCur: null })).toEqual({});
    expect(goalChange(s, 'turkey', { approxCur: undefined })).toEqual({});
    expect(goalChange(s, 'turkey', { approxCur: 'EUR' as 'USD' })).toBeNull();
    const lira = reduce(s, { type: 'goal/patch', id: 'turkey', patch: { approxCur: 'TRY' } });
    expect(goalChange(lira, 'turkey', { approxCur: 'TRY' })).toEqual({});
    expect(goalChange(lira, 'turkey', { approxCur: 'USD' })).toEqual({ approxCur: 'USD' });
    // Going back to the main currency means sending null, not leaving it out.
    expect(goalChange(lira, 'turkey', { approxCur: null })).toEqual({ approxCur: null });
    // It travels with the rest of the dialog, without dragging the plan along if it did not change.
    expect(goalChange(lira, 'turkey', { name: 'Istanbul', approxCur: null, monthly: 3000 })).toEqual({ name: 'Istanbul', approxCur: null });
  });

  it('goalChange: only what changes; the plan, always the three fields together', () => {
    // 'turkey' has a plan: 3,000 USD from 2026-08 to 2027-10.
    expect(goalChange(s, 'turkey', { name: ' Istanbul ' })).toEqual({ name: 'Istanbul' });
    expect(goalChange(s, 'turkey', { monthly: 2500 })).toEqual({ monthly: 2500, start: '2026-08', end: '2027-10' });
    expect(goalChange(s, 'turkey', { end: '2027-12' })).toEqual({ monthly: 3000, start: '2026-08', end: '2027-12' });
    expect(goalChange(s, 'turkey', { monthly: null, start: null, end: null })).toEqual({ monthly: null, start: null, end: null });
    expect(goalChange(s, 'turkey', { cur: 'TRY' })).toEqual({ cur: 'TRY' });
    expect(goalChange(s, 'personal', plan)).toEqual(plan);
    expect(goalChange(s, 'personal', { sort: 5 })).toEqual({ sort: 5 });
  });

  it('goalChange: a patch with no changes gives {}', () => {
    expect(goalChange(s, 'turkey', {})).toEqual({});
    expect(goalChange(s, 'turkey', { name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10', approxCur: null, sort: 2 })).toEqual({});
    expect(goalChange(s, 'personal', { monthly: null })).toEqual({});
  });

  it('goalChange: null if the goal does not exist or would end up invalid', () => {
    expect(goalChange(s, 'nope', { name: 'x' })).toBeNull();
    expect(goalChange(s, 'turkey', { name: '  ' })).toBeNull();
    expect(goalChange(s, 'turkey', { cur: 'EUR' as 'USD' })).toBeNull();
    // Removing only part of the plan is not valid: all three have to be sent as null.
    expect(goalChange(s, 'turkey', { monthly: null })).toBeNull();
    expect(goalChange(s, 'turkey', { end: null })).toBeNull();
    expect(goalChange(s, 'turkey', { end: '2026-07' })).toBeNull();
    expect(goalChange(s, 'turkey', { monthly: 0 })).toBeNull();
    // Nor is giving only part of one to a goal without a plan.
    expect(goalChange(s, 'personal', { monthly: 500 })).toBeNull();
    expect(goalChange(s, 'personal', { start: '2026-10', end: '2027-09' })).toBeNull();
    expect(goalChange(s, 'personal', { sort: Number.NaN })).toBeNull();
  });

  it('canRemoveGoal: only a goal that exists and has no contributions', () => {
    expect(canRemoveGoal(s, 'turkey')).toBe(false);
    expect(canRemoveGoal(s, 'nope')).toBe(false);
    const withNew = reduce(s, { type: 'goal/add', row: newGoal(s, { name: 'Car' }, 'g-new')! });
    expect(canRemoveGoal(withNew, 'g-new')).toBe(true);
    const emptied = { ...s, contribs: s.contribs.filter((c) => c.goalId !== 'personal') };
    expect(canRemoveGoal(emptied, 'personal')).toBe(true);
  });
});

describe('deleting a month', () => {
  it('removeMonth: the month goes away with everything in it; incomes and contributions stay', () => {
    const s = frozen();
    const next = removeMonth(s, '2026-09');
    expect(Object.keys(next.months).sort()).toEqual(['2026-08', OCT]);
    expect(next.months[OCT]).toBe(s.months[OCT]);
    expect(next.incomes).toBe(s.incomes);
    expect(next.contribs).toBe(s.contribs);
    expect(next.accounts).toBe(s.accounts);
  });

  it('the balances change accordingly: the movements of that month stop counting', () => {
    const s = frozen();
    const next = removeMonth(s, '2026-09');
    // September: 2,300 in transfers and 106 for Claude left the US account; 134,721 went into the DR account
    // and 24,555 in transactions and 35,872.66 in fixed expenses left it. The September salary is an income: it stays.
    expect(balanceOf(next, 'us')).toBeCloseTo(13482 + 2300 + 106, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(220641.93 - 134721 + 24555 + 35872.66, 6);
  });

  it('a month that does not exist leaves the state unchanged', () => {
    const s = frozen();
    expect(removeMonth(s, '2030-01')).toBe(s);
  });
});

describe('helpers', () => {
  it('isPatch: cell edits and settings (the ones that are grouped and wait)', () => {
    const s = seedState();
    const patches: Action[] = [
      { type: 'settings/patch', patch: {} },
      { type: 'account/patch', id: 'us', patch: {} },
      { type: 'month/patch', key: OCT, patch: {} },
      { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 1, date: '2026-10-07' } },
      { type: 'fixed/patch', id: 'x', patch: {} },
      { type: 'tx/patch', id: 'x', patch: {} },
      { type: 'transfer/patch', id: 'x', patch: {} },
      { type: 'income/patch', id: 'x', patch: {} },
      { type: 'contribution/patch', id: 'x', patch: {} },
    ];
    for (const action of patches) expect(isPatch(action), action.type).toBe(true);
    const direct: Action[] = [
      { type: 'goal/patch', id: 'turkey', patch: {} },
      { type: 'account/add', row: s.accounts[0]! },
      { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-07' },
      // The budget log is not cells: each movement goes out right away.
      { type: 'budget/add', key: OCT, row: s.months[OCT]!.budgetLog[0]! },
      { type: 'budget/remove', key: OCT, id: 'x' },
      { type: 'budget/leftover', key: OCT, row: s.months[OCT]!.budgetLog[0]! },
      { type: 'month/reopen', key: OCT },
      { type: 'income/remove', id: 'x' },
    ];
    for (const action of direct) expect(isPatch(action), action.type).toBe(false);
  });

  it('mergePatch: the most recent value of each field wins', () => {
    expect(
      mergePatch({ type: 'tx/patch', id: 'a', patch: { desc: 'U', amount: 1 } }, { type: 'tx/patch', id: 'a', patch: { desc: 'Uber' } }),
    ).toEqual({ type: 'tx/patch', id: 'a', patch: { desc: 'Uber', amount: 1 } });
    expect(
      mergePatch({ type: 'account/patch', id: 'us', patch: { name: 'Chase' } }, { type: 'account/patch', id: 'us', patch: { opening: 5 } }),
    ).toEqual({ type: 'account/patch', id: 'us', patch: { name: 'Chase', opening: 5 } });
  });

  it('mergePatch: budget parts are merged by account, and a rate replaces the previous one', () => {
    expect(
      mergePatch(
        { type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 60000 } } },
        { type: 'month/patch', key: OCT, patch: { budgets: { dr: 65000 } } },
      ),
    ).toEqual({ type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 65000 } } });
    const later: Action = { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-07' } };
    expect(mergePatch({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } }, later as never)).toBe(later);
  });

  it('mergePatch: merging two budget parts keeps the date of the most recent one', () => {
    expect(
      mergePatch(
        { type: 'month/patch', key: OCT, patch: { budgets: { us: 100 } }, date: '2026-10-07' },
        { type: 'month/patch', key: OCT, patch: { budgets: { dr: 65000 } }, date: '2026-10-08' },
      ),
    ).toEqual({ type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 65000 } }, date: '2026-10-08' });
  });

  it('fieldsOf: each field, each budget account and the rate carry their own delay', () => {
    expect(fieldsOf({ type: 'tx/patch', id: 'a', patch: { desc: 'U', amount: 1 } })).toEqual(['desc', 'amount']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: { budgets: { us: 1, dr: 2 } } })).toEqual(['budgets.us', 'budgets.dr']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: {} })).toEqual([]);
    expect(fieldsOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } })).toEqual(['rate']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: { budgets: { us: 1 } }, date: '2026-10-07' })).toEqual(['budgets.us']);
    expect(fieldsOf({ type: 'income/patch', id: 'i1', patch: { budget: true } })).toEqual(['budget']);
    expect(fieldsOf({ type: 'settings/patch', patch: {} })).toEqual([]);
  });

  it('targetOf: the same key for adding, editing and removing a row', () => {
    const s = seedState();
    const row = s.months[OCT]!.tx[0]!;
    expect(targetOf({ type: 'tx/add', row })).toBe(`tx:${row.id}`);
    expect(targetOf({ type: 'tx/patch', id: row.id, patch: {} })).toBe(`tx:${row.id}`);
    expect(targetOf({ type: 'tx/remove', id: row.id })).toBe(`tx:${row.id}`);
    expect(targetOf({ type: 'month/patch', key: OCT, patch: {} })).toBe(`month:${OCT}`);
    expect(targetOf({ type: 'fixed/remove', id: row.id })).not.toBe(targetOf({ type: 'tx/remove', id: row.id }));
    expect(targetOf({ type: 'settings/patch', patch: { language: 'es' } })).toBe('settings');
    const goal = s.goals[0]!;
    expect(targetOf({ type: 'goal/add', row: goal })).toBe(`goal:${goal.id}`);
    expect(targetOf({ type: 'goal/patch', id: goal.id, patch: {} })).toBe(`goal:${goal.id}`);
    expect(targetOf({ type: 'goal/remove', id: goal.id })).toBe(`goal:${goal.id}`);
    const account = s.accounts[0]!;
    expect(targetOf({ type: 'account/add', row: account })).toBe('account:us');
    expect(targetOf({ type: 'account/patch', id: 'us', patch: {} })).toBe('account:us');
    expect(targetOf({ type: 'account/remove', id: 'us' })).toBe('account:us');
    expect(targetOf({ type: 'income/patch', id: 'i1', patch: {} })).toBe('income:i1');
    expect(targetOf({ type: 'transfer/patch', id: 't1', patch: {} })).toBe(targetOf({ type: 'transfer/remove', id: 't1' }));
    expect(targetOf({ type: 'contribution/patch', id: 'c1', patch: {} })).toBe(targetOf({ type: 'contribution/remove', id: 'c1' }));
  });

  it('targetOf: a rate is named by its month, its pair (in either direction) and its date', () => {
    const set = targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } });
    expect(set).toBe(`rate:${OCT}:DOP-USD:2026-10-07`);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-07' } })).toBe(set);
    expect(targetOf({ type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD', date: '2026-10-07' })).toBe(set);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' } })).not.toBe(set);
    expect(targetOf({ type: 'rate/set', key: '2026-09', rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } })).not.toBe(set);
    // Each date is its own row: another day's rate is neither merged with this one nor dropped when this one is removed.
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-08' } })).toBe(`rate:${OCT}:DOP-USD:2026-10-08`);
    expect(targetOf({ type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-08' })).not.toBe(set);
    // And it is not confused with the month's budget.
    expect(set).not.toBe(targetOf({ type: 'month/patch', key: OCT, patch: {} }));
  });

  it('targetOf: each budget log movement is its own row, separate from the month parts', () => {
    const row: BudgetEntry = { id: 'b1', date: '2026-10-09', accountId: 'dr', amount: 500, kind: 'adjust', note: '' };
    expect(targetOf({ type: 'budget/add', key: OCT, row })).toBe('budget:b1');
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b1' })).toBe('budget:b1');
    expect(targetOf({ type: 'budget/leftover', key: OCT, row: { ...row, id: 'local-lo', kind: 'leftover' } })).toBe('budget:local-lo');
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b2' })).not.toBe('budget:b1');
    // Removing a movement does not drop the month part that was waiting out its delay (store.ts: queue.drop by key).
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b1' })).not.toBe(targetOf({ type: 'month/patch', key: OCT, patch: {} }));
    expect(targetOf({ type: 'month/patch', key: OCT, patch: {}, date: '2026-10-09' })).toBe(`month:${OCT}`);
  });

  it('putMonths: replaces and adds months (close-month response)', () => {
    const s = frozen();
    const closed: Month = { ...s.months[OCT]!, closed: true, closedAt: '2026-11-01T00:00:00Z' };
    const next: Month = { ...s.months[OCT]!, key: '2026-11', tx: [], transfers: [] };
    const out = putMonths(s, closed, next);
    expect(Object.keys(out.months).sort()).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(out.months[OCT]!.closed).toBe(true);
    expect(out.months['2026-08']).toBe(s.months['2026-08']);
  });
});
