import { describe, expect, it } from 'vitest';
import { budgetHistory, budgetSummary, incomeBudgetUse, monthCalc } from './calc';
import { seedState } from './seed';

// seedState: income seed-in-3 is 5,800 USD in the 'us' account (USD), dated 2026-10-01, without "Adds to budget".
describe('incomeBudgetUse', () => {
  it('available = income - positive entries linked to it, over every month; negatives and other incomes are ignored', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push(
      { id: 'a', date: '2026-10-08', accountId: 'us', amount: 1000, kind: 'adjust', note: '', incomeId: 'seed-in-3' },
      { id: 'b', date: '2026-10-09', accountId: 'us', amount: -300, kind: 'adjust', note: '', incomeId: 'seed-in-3' },
      { id: 'c', date: '2026-10-09', accountId: 'us', amount: 77, kind: 'adjust', note: '', incomeId: 'seed-in-2' },
    );
    s.months['2026-09']!.budgetLog.push({ id: 'd', date: '2026-09-08', accountId: 'us', amount: 500, kind: 'adjust', note: '', incomeId: 'seed-in-3' });
    const use = incomeBudgetUse(s, s.incomes.find((i) => i.id === 'seed-in-3')!)!;
    expect(use).toEqual({ amount: 5800, whole: false, taken: 1500, available: 4300 });
  });

  it('an income that already adds to the budget has nothing available; gold has no use', () => {
    const s = seedState();
    s.incomes[2]!.budget = true;
    expect(incomeBudgetUse(s, s.incomes[2]!)).toMatchObject({ whole: true, available: 0 });
  });

  it('never goes below 0 when more was taken than the income', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'a', date: '2026-10-08', accountId: 'us', amount: 9000, kind: 'adjust', note: '', incomeId: 'seed-in-3' });
    expect(incomeBudgetUse(s, s.incomes.find((i) => i.id === 'seed-in-3')!)!.available).toBe(0);
  });
});

describe('a budget entry linked to an income', () => {
  it('names the income in the history and in the summary additions, and the total stays the same', () => {
    const s = seedState();
    const plain = monthCalc(s, '2026-10').budget;
    s.months['2026-10']!.budgetLog.push({ id: 'x', date: '2026-10-08', accountId: 'us', amount: 100, kind: 'adjust', note: 'Trip', incomeId: 'seed-in-3' });
    const row = budgetHistory(s, '2026-10').find((r) => r.id === 'x')!;
    expect([row.incomeId, row.incomeName]).toEqual(['seed-in-3', 'Salary']);
    const line = budgetSummary(s, '2026-10').additions.find((l) => l.id === 'x')!;
    expect([line.incomeId, line.incomeName]).toEqual(['seed-in-3', 'Salary']);
    expect(budgetSummary(s, '2026-10').total).toBe(monthCalc(s, '2026-10').budget);
    // 100 USD at the month rate, exactly as an unlinked extra would add.
    expect(monthCalc(s, '2026-10').budget).toBeCloseTo(plain + 100 * 58.76, 6);
    expect(budgetHistory(s, '2026-10').find((r) => r.id === 'seed-bg-2026-10-1')!.incomeId).toBeNull();
  });
});
