import { describe, expect, it } from 'vitest';
import { balances, budgetSummary } from '../../shared/calc';
import { seedState } from '../../shared/seed';
import {
  accountAvailable,
  budgetHistoryRows,
  extraDefaultAmount,
  extraIncomeOptions,
  extraInput,
  extraWarnings,
  incomeBudgetShortfall,
  incomeShortfalls,
  newExtraForm,
  summaryRows,
} from './budgetModel';

describe('extra budget from an income', () => {
  it('offers only the incomes of the viewed month that are in the chosen account, with what is available', () => {
    const s = seedState();
    expect(extraIncomeOptions(s, '2026-10', 'us')).toEqual([
      { id: 'seed-in-3', desc: 'Salary', date: '2026-10-01', amount: '5,800.00', currency: 'USD', available: 5800, whole: false },
    ]);
    expect(extraIncomeOptions(s, '2026-10', 'dr')).toEqual([]);
    s.incomes[2]!.budget = true;
    expect(extraIncomeOptions(s, '2026-10', 'us')[0]).toMatchObject({ available: 0, whole: true });
  });

  it('proposes what is left of the income capped by what the account holds', () => {
    expect(extraDefaultAmount(4300, 10000)).toBe(4300);
    expect(extraDefaultAmount(4300, 1200.456)).toBe(1200.46);
    expect(extraDefaultAmount(4300, 0)).toBeNull();
    expect(extraDefaultAmount(0, 500)).toBeNull();
    expect(extraDefaultAmount(null, 500)).toBeNull();
    expect(extraDefaultAmount(4300, null)).toBe(4300);
  });

  it('warns softly when the amount is more than the income has left or the account holds', () => {
    expect(extraWarnings(1000, 800, 5000)).toEqual({ income: 800, account: null });
    expect(extraWarnings(1000, 5000, 600)).toEqual({ income: null, account: 600 });
    expect(extraWarnings(800, 800, 800)).toEqual({ income: null, account: null });
    expect(extraWarnings(null, 0, 0)).toEqual({ income: null, account: null });
    expect(extraWarnings(10, null, null)).toEqual({ income: null, account: null });
  });

  it('the account availability comes from the computed balance and is never negative', () => {
    const s = seedState();
    const b = balances(s, '2026-10');
    const us = b.accounts.find((a) => a.account.id === 'us')!.balance;
    expect(accountAvailable(b, 'us')).toBe(Math.max(0, us));
    expect(accountAvailable({ ...b, accounts: b.accounts.map((a) => ({ ...a, balance: -50 })) }, 'us')).toBe(0);
    expect(accountAvailable(b, 'nope')).toBeNull();
  });

  it('extraInput sends the income, or null without one', () => {
    const base = { ...newExtraForm('2026-10', '2026-10-09', [], [{ id: 'us' }]), amount: '100' };
    expect(extraInput(base, '2026-10')!.incomeId).toBeNull();
    expect(extraInput({ ...base, incomeId: 'seed-in-3' }, '2026-10')!.incomeId).toBe('seed-in-3');
  });

  it('the history row and the summary row carry the income name', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'x', date: '2026-10-08', accountId: 'us', amount: 100, kind: 'adjust', note: 'Trip', incomeId: 'seed-in-3' });
    const history = budgetHistoryRows(s, '2026-10').find((r) => r.id === 'x')!;
    expect([history.kindKey, history.incomeName, history.note]).toEqual(['budgetKindExtra', 'Salary', 'Trip']);
    expect(budgetHistoryRows(s, '2026-10')[0]!.incomeName).toBeUndefined();
    const row = summaryRows(budgetSummary(s, '2026-10')).find((r) => r.key === 'addition:x')!;
    expect([row.income, row.note]).toEqual(['Salary', 'Trip']);
  });
});

describe('incomeBudgetShortfall', () => {
  it('flags an "Adds to budget" income that is more than its account holds, and only then', () => {
    const s = seedState();
    const income = s.incomes[2]!;
    const b = balances(s, '2026-10');
    expect(incomeBudgetShortfall(s, b, income)).toBeNull(); // no "Adds to budget"
    income.budget = true;
    const emptied = { ...b, accounts: b.accounts.map((a) => (a.account.id === 'us' ? { ...a, balance: 1200 } : a)) };
    expect(incomeBudgetShortfall(s, emptied, income)).toEqual({ available: 1200, currency: 'USD' });
    const rich = { ...b, accounts: b.accounts.map((a) => (a.account.id === 'us' ? { ...a, balance: 9000 } : a)) };
    expect(incomeBudgetShortfall(s, rich, income)).toBeNull();
    const negative = { ...b, accounts: b.accounts.map((a) => (a.account.id === 'us' ? { ...a, balance: -20 } : a)) };
    expect(incomeBudgetShortfall(s, negative, income)).toEqual({ available: 0, currency: 'USD' });
  });
});

describe('incomeShortfalls', () => {
  const withBalance = (s: ReturnType<typeof seedState>, id: string, balance: number) => {
    const b = balances(s, '2026-10');
    return { ...b, accounts: b.accounts.map((a) => (a.account.id === id ? { ...a, balance } : a)) };
  };

  it('lists an "Adds to budget" income whose account is empty, with 0 available', () => {
    const s = seedState();
    const income = s.incomes[2]!;
    income.budget = true;
    const list = incomeShortfalls(s, withBalance(s, 'us', 0), [income]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: income.id, desc: income.desc, available: 0, amount: 5800, currency: 'USD' });
    expect(list[0]!.accountName).toBeTruthy();
  });

  it('keeps what is left when the account holds some but not enough', () => {
    const s = seedState();
    s.incomes[2]!.budget = true;
    expect(incomeShortfalls(s, withBalance(s, 'us', 1200), [s.incomes[2]!])[0]).toMatchObject({ available: 1200, amount: 5800 });
  });

  it('skips unticked incomes and accounts that hold enough', () => {
    const s = seedState();
    const income = s.incomes[2]!;
    expect(incomeShortfalls(s, withBalance(s, 'us', 0), [income])).toEqual([]);
    income.budget = true;
    expect(incomeShortfalls(s, withBalance(s, 'us', 9000), [income])).toEqual([]);
  });

  it('ignores gold accounts', () => {
    const s = seedState();
    const gold = s.accounts.find((a) => a.currency === 'XAU');
    if (!gold) return;
    const income = { ...s.incomes[2]!, accountId: gold.id, budget: true };
    expect(incomeShortfalls(s, withBalance(s, gold.id, 0), [income])).toEqual([]);
  });
});
