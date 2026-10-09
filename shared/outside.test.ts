// Gastos fuera de presupuesto (Month.outside) y partes del presupuesto pasadas: lo que cuentan y lo que no.

import { describe, expect, it } from 'vitest';
import { balances, budgetOverruns, monthCalc, outsideOf, outsideSummary, rateFor } from './calc';
import { seedState } from './seed';
import type { AppState, OutsideExpense } from './types';

const KEY = '2026-10';

const row = (patch: Partial<OutsideExpense>): OutsideExpense => ({
  id: 'o1',
  monthKey: KEY,
  date: '2026-10-07',
  name: 'Car repair',
  desc: '',
  accountId: 'dr',
  amount: 1000,
  cur: 'DOP',
  ...patch,
});

function withOutside(...rows: OutsideExpense[]): AppState {
  const state = seedState();
  return { ...state, months: { ...state.months, [KEY]: { ...state.months[KEY]!, outside: rows } } };
}

const balanceOf = (state: AppState, id: string) => balances(state, KEY).accounts.find((a) => a.account.id === id)!.balance;

describe('gastos fuera de presupuesto', () => {
  it('restan del saldo de su cuenta, en su moneda', () => {
    const base = seedState();
    const state = withOutside(row({ amount: 1000 }));
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 1000, 8);
    expect(balanceOf(state, 'us')).toBe(balanceOf(base, 'us'));
  });

  it('en otra moneda restan convertidos con la tasa vigente en su fecha, no con la última del mes', () => {
    // Una tasa posterior (día 20) no puede cambiar un gasto del día 7.
    const later = (s: AppState): AppState => ({
      ...s,
      months: { ...s.months, [KEY]: { ...s.months[KEY]!, rates: [...s.months[KEY]!.rates, { from: 'USD', to: 'DOP', rate: 70, date: '2026-10-20' }] } },
    });
    const base = later(seedState());
    // 100 USD pagados desde la cuenta en DOP: la tasa del 7 de octubre, no otra.
    const state = later(withOutside(row({ amount: 100, cur: 'USD', date: '2026-10-07' })));
    const rate = rateFor(state, KEY, 'USD', 'DOP', '2026-10-07').rate;
    expect(rate).not.toBe(70);
    expect(balanceOf(state, 'dr')).toBeCloseTo(balanceOf(base, 'dr') - 100 * rate, 6);
    // Y 5,876 DOP desde la cuenta en USD.
    const back = later(withOutside(row({ amount: 5876, cur: 'DOP', accountId: 'us' })));
    expect(balanceOf(back, 'us')).toBeCloseTo(balanceOf(base, 'us') - 5876 * rateFor(back, KEY, 'DOP', 'USD', '2026-10-07').rate, 6);
  });

  it('bajan el dinero total, pero no son parte del presupuesto: ni usado, ni disponible, ni categorías, ni conteo', () => {
    const base = seedState();
    const state = withOutside(row({ amount: 5000 }), row({ id: 'o2', amount: 20, cur: 'USD', accountId: 'us' }));
    const [a, b] = [monthCalc(base, KEY), monthCalc(state, KEY)];
    expect(b.used).toBe(a.used);
    expect(b.avail).toBe(a.avail);
    expect(b.after).toBe(a.after);
    expect(b.varSpent).toBe(a.varSpent);
    expect(b.txCount).toBe(a.txCount);
    expect(b.categories).toEqual(a.categories);
    expect(b.budget).toBe(a.budget);
    expect(balances(state, KEY).totalMain).toBeLessThan(balances(base, KEY).totalMain);
  });

  it('un mes posterior ve el gasto de uno anterior en sus saldos; uno anterior no ve el de uno posterior', () => {
    const state = withOutside(row({ amount: 1000 }));
    const base = seedState();
    expect(balances(state, '2026-09').accounts.map((x) => x.balance)).toEqual(balances(base, '2026-09').accounts.map((x) => x.balance));
  });

  it('outsideSummary cuenta y suma en la moneda principal, cada uno con la tasa de su fecha', () => {
    const state = withOutside(row({ amount: 1000 }), row({ id: 'o2', amount: 10, cur: 'USD', accountId: 'us' }));
    const rate = rateFor(state, KEY, 'USD', 'DOP', '2026-10-07').rate;
    const s = outsideSummary(state, KEY);
    expect(s.count).toBe(2);
    expect(s.total).toBeCloseTo(1000 + 10 * rate, 8);
    expect(outsideSummary(seedState(), KEY)).toEqual({ count: 0, total: 0 });
    expect(outsideSummary(seedState(), '2099-01')).toEqual({ count: 0, total: 0 });
    expect(outsideOf(seedState().months[KEY]!)).toEqual([]);
  });
});

describe('budgetOverruns', () => {
  it('solo las partes en negativo, con lo que se pasan', () => {
    const state = seedState();
    const month = state.months[KEY]!;
    // Un envío que mueve más presupuesto del que tiene la cuenta de origen la deja en negativo.
    const withTransfer: AppState = {
      ...state,
      months: {
        ...state.months,
        [KEY]: { ...month, transfers: [...month.transfers, { id: 'big', monthKey: KEY, date: '2026-10-05', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 800, rate: 58, budget: true, fee: 0 }] },
      },
    };
    const parts = monthCalc(withTransfer, KEY).budgetParts;
    const us = parts.find((p) => p.account.id === 'us')!;
    expect(us.amount).toBeLessThan(0);
    const over = budgetOverruns(parts);
    expect(over.map((o) => [o.account.id, o.over])).toEqual([['us', -us.amount]]);
  });

  it('ninguna si ninguna parte es negativa', () => {
    expect(budgetOverruns(monthCalc(seedState(), KEY).budgetParts)).toEqual([]);
  });
});
