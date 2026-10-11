import { describe, expect, it } from 'vitest';
import { incomeBudgetUse } from './calc';
import { seedState } from './seed';

// seedState: income seed-in-3 is 5,800 USD in the 'us' account (USD); the main currency is DOP and October's rate is 58.76.
const salary = (s: ReturnType<typeof seedState>) => s.incomes.find((i) => i.id === 'seed-in-3')!;

describe('incomeBudgetUse with contributions to goals', () => {
  it('subtracts the linked contributions, converted into the currency of the income account', () => {
    const s = seedState();
    s.contribs.push(
      { id: 'a', goalId: 'turkey', date: '2026-10-05', amount: 1000, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-3' },
      // 5,876 DOP at the month rate is 100 USD.
      { id: 'b', goalId: 'emergency', date: '2026-10-05', amount: 5876, cur: 'DOP', rate: null, accountId: 'us', incomeId: 'seed-in-3' },
      // Not linked, and linked to another income: ignored.
      { id: 'c', goalId: 'turkey', date: '2026-10-05', amount: 999, cur: 'USD', rate: null, accountId: 'us' },
      { id: 'd', goalId: 'turkey', date: '2026-10-05', amount: 777, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-2' },
    );
    const use = incomeBudgetUse(s, salary(s))!;
    expect(use.contributed).toBeCloseTo(1100, 6);
    expect(use.taken).toBe(0);
    expect(use.available).toBeCloseTo(4700, 6);
    expect(use.left).toBeCloseTo(4700, 6);
  });

  it('keeps budget entries and contributions apart, and both reduce what is available', () => {
    const s = seedState();
    s.months['2026-10']!.budgetLog.push({ id: 'x', date: '2026-10-08', accountId: 'us', amount: 800, kind: 'adjust', note: '', incomeId: 'seed-in-3' });
    s.contribs.push({ id: 'a', goalId: 'turkey', date: '2026-10-05', amount: 2250, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-3' });
    expect(incomeBudgetUse(s, salary(s))).toMatchObject({ taken: 800, contributed: 2250, available: 2750, left: 2750 });
  });

  it('an income that adds to the budget has nothing available but still reports what went to goals', () => {
    const s = seedState();
    salary(s).budget = true;
    s.contribs.push({ id: 'a', goalId: 'turkey', date: '2026-10-05', amount: 5800, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-3' });
    expect(incomeBudgetUse(s, salary(s))).toMatchObject({ whole: true, contributed: 5800, available: 0, left: 0 });
  });

  it('never goes below 0 when more went to goals than the income', () => {
    const s = seedState();
    s.contribs.push({ id: 'a', goalId: 'turkey', date: '2026-10-05', amount: 9000, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-3' });
    expect(incomeBudgetUse(s, salary(s))).toMatchObject({ contributed: 9000, available: 0, left: 0 });
  });
});
