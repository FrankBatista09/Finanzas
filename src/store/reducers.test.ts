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

/** Congela todo el árbol: si un reductor mutara el estado, la prueba revienta. */
function frozen(base: AppState = seedState()): AppState {
  const freeze = (v: unknown): void => {
    if (typeof v !== 'object' || v === null || Object.isFrozen(v)) return;
    Object.freeze(v);
    Object.values(v).forEach(freeze);
  };
  freeze(base);
  return base;
}

/** Saldo de una cuenta al final de octubre, en su moneda. */
const balanceOf = (state: AppState, id: string, asOf = OCT) => balances(state, asOf).accounts.find((a) => a.account.id === id)!.balance;

/** Los datos de ejemplo con dos tasas USD → DOP de fechas distintas en octubre: 58 desde el día 1 y 60 desde el día 6. */
function twoRates(): AppState {
  const s = seedState();
  s.months[OCT]!.rates = [
    { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
    { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' },
  ];
  return s;
}

/** Los datos de ejemplo más un ingreso de octubre que sube el presupuesto (Income.budget). */
function withBudgetIncome(income: Partial<Income> = {}): AppState {
  const s = seedState();
  s.incomes.push({ id: 'in-budget', date: '2026-10-10', desc: 'Freelance', accountId: 'dr', amount: 10000, cur: 'DOP', budget: true, ...income });
  return s;
}

/** La parte del presupuesto de una cuenta tal como se ve (registro + ingresos que lo suben). */
const partOf = (state: AppState, id: string, key = OCT) => monthCalc(state, key).budgetParts.find((p) => p.account.id === id)!;

describe('reduce · mes', () => {
  it('edita la parte del presupuesto de una cuenta sin tocar las demás ni lo demás', () => {
    const s = frozen();
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 200 } } });
    const m = next.months[OCT]!;
    expect(m.budgets).toEqual({ dr: 70000, us: 200 });
    // Lo que no cambia conserva su identidad (las filas memorizadas no se vuelven a pintar).
    expect(m.fixed).toBe(s.months[OCT]!.fixed);
    expect(m.rates).toBe(s.months[OCT]!.rates);
    expect(next.months['2026-09']).toBe(s.months['2026-09']);
    expect(next.contribs).toBe(s.contribs);
    expect(next.accounts).toBe(s.accounts);
  });

  it('el presupuesto nuevo llega a los cálculos, cada parte convertida con la tasa del mes', () => {
    const next = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { dr: 50000 } } });
    expect(f2(monthCalc(next, OCT).avail)).toBe('850.29'); // 50,000 − 49,149.71
    const split = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { us: 200, dr: 58248 } } });
    expect(monthCalc(split, OCT).budget).toBeCloseTo(200 * 58.76 + 58248, 8);
  });

  it('0 quita la parte, como en el servidor', () => {
    const next = reduce(frozen(), { type: 'month/patch', key: OCT, patch: { budgets: { dr: 0 } } });
    expect(next.months[OCT]!.budgets).toEqual({});
    expect(monthCalc(next, OCT).budget).toBe(0);
  });

  it('ignora un mes que no existe, y un patch que no cambia nada devuelve el mismo estado', () => {
    const s = frozen();
    expect(reduce(s, { type: 'month/patch', key: '2030-01', patch: { budgets: { dr: 1 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 70000 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 0 } } })).toBe(s);
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: {} })).toBe(s);
  });

  it('no sobrescribe el presupuesto: añade al registro un movimiento con la diferencia de cada cuenta', () => {
    const s = frozen();
    // Octubre arranca con 65,000 ('initial') + 5,000 ('adjust') en la DR account; la US account no tiene parte.
    const before = s.months[OCT]!.budgetLog;
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000, us: 200 } }, date: '2026-10-09' });
    const log = next.months[OCT]!.budgetLog;
    expect(log).toHaveLength(4);
    // Lo que ya estaba en el registro sigue ahí, tal cual.
    expect(log[0]).toBe(before[0]);
    expect(log[1]).toBe(before[1]);
    // 'adjust' si la cuenta ya tenía movimientos en el mes; 'initial' si es el primero.
    expect(log[2]).toEqual({ id: expect.stringMatching(/^local-/) as string, date: '2026-10-09', accountId: 'dr', amount: 10000, kind: 'adjust', note: '' });
    expect(log[3]).toEqual({ id: expect.stringMatching(/^local-/) as string, date: '2026-10-09', accountId: 'us', amount: 200, kind: 'initial', note: '' });
    expect(new Set(log.map((e) => e.id)).size).toBe(4);
    expect(log.slice(2).every((e) => isLocalEntry(e.id))).toBe(true);
    // Month.budgets es la suma del registro, ya hecha.
    expect(next.months[OCT]!.budgets).toEqual({ dr: 80000, us: 200 });
    expect(next.months[OCT]!.budgets).toEqual(budgetsFromLog(log));
    expect(monthCalc(next, OCT).budget).toBeCloseTo(80000 + 200 * 58.76, 8);
  });

  it('bajar una parte añade un movimiento negativo; dejarla en 0, uno que la anula', () => {
    const s = frozen();
    const lower = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 50000 } }, date: '2026-10-09' });
    expect(lower.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: -20000, kind: 'adjust' });
    expect(lower.months[OCT]!.budgets).toEqual({ dr: 50000 });

    const zero = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 0 } }, date: '2026-10-09' });
    expect(zero.months[OCT]!.budgetLog).toHaveLength(3);
    expect(zero.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: -70000, kind: 'adjust' });
    // La historia se conserva aunque la suma quede en cero.
    expect(budgetHistory(zero, OCT).map((r) => r.total)).toEqual([65000, 70000, 0]);
  });

  it('el movimiento lleva la fecha de la acción o, sin ella, el primer día del mes', () => {
    const s = frozen();
    const dated = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 50 } }, date: '2026-10-21' });
    expect(dated.months[OCT]!.budgetLog.at(-1)!.date).toBe('2026-10-21');
    const plain = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 50 } } });
    expect(plain.months[OCT]!.budgetLog.at(-1)!.date).toBe('2026-10-01');
  });

  it('es idempotente: repetir la acción no añade otro movimiento, y un segundo cambio parte de la suma nueva', () => {
    const s = frozen();
    const action: Action = { type: 'month/patch', key: OCT, patch: { budgets: { dr: 80000, us: 200 } }, date: '2026-10-09' };
    const once = reduce(s, action);
    expect(reduce(once, action)).toBe(once);
    // Otro monto para la misma cuenta: solo la diferencia con lo que ya suma su registro.
    const twice = reduce(once, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 81500.5 } }, date: '2026-10-12' });
    expect(twice.months[OCT]!.budgetLog).toHaveLength(5);
    expect(twice.months[OCT]!.budgetLog.at(-1)).toMatchObject({ accountId: 'dr', amount: 1500.5, kind: 'adjust', date: '2026-10-12' });
    expect(twice.months[OCT]!.budgets).toEqual({ dr: 81500.5, us: 200 });
    expect(new Set(twice.months[OCT]!.budgetLog.map((e) => e.id)).size).toBe(5);
  });

  it('el ruido de la coma flotante no es una diferencia', () => {
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

  it('los ingresos que suben el presupuesto no están en el registro: el patch fija solo lo que suma el registro', () => {
    const s = frozen(withBudgetIncome());
    // La parte se ve en 80,000 (70,000 del registro + 10,000 del ingreso); el registro ya suma 70,000.
    expect(reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 70000 } } })).toBe(s);
    const next = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { dr: 75000 } } });
    expect(next.months[OCT]!.budgetLog.at(-1)).toMatchObject({ amount: 5000, kind: 'adjust' });
    expect(next.months[OCT]!.budgets).toEqual({ dr: 75000 });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
  });

  it('reabre un mes cerrado', () => {
    const s = frozen();
    const next = reduce(s, { type: 'month/reopen', key: '2026-09' });
    expect(next.months['2026-09']!.closed).toBe(false);
    expect(next.months['2026-09']!.closedAt).toBeNull();
    // Reabrir uno abierto no cambia nada.
    expect(reduce(s, { type: 'month/reopen', key: OCT })).toBe(s);
  });
});

describe('reduce · registro del presupuesto', () => {
  const entry = (over: Partial<BudgetEntry> = {}): BudgetEntry => ({ id: 'bg-new', date: '2026-10-09', accountId: 'dr', amount: 2500, kind: 'adjust', note: 'Gift', ...over });

  it('budget/add añade un movimiento y recalcula las partes; repetirlo no lo duplica', () => {
    const s = frozen();
    const next = reduce(s, { type: 'budget/add', key: OCT, row: entry() });
    expect(next.months[OCT]!.budgetLog).toHaveLength(3);
    expect(next.months[OCT]!.budgetLog.at(-1)).toEqual(entry());
    expect(next.months[OCT]!.budgets).toEqual({ dr: 72500 });
    expect(monthCalc(next, OCT).budget).toBe(72500);
    // Lo demás del mes conserva su identidad.
    expect(next.months[OCT]!.tx).toBe(s.months[OCT]!.tx);
    expect(next.months[OCT]!.budgetLog[0]).toBe(s.months[OCT]!.budgetLog[0]);
    expect(next.months['2026-09']).toBe(s.months['2026-09']);
    // Con el mismo id sustituye al que hubiera (un refetch puede traerlo ya aplicado).
    const again = reduce(next, { type: 'budget/add', key: OCT, row: entry() });
    expect(again).toEqual(next);
    expect(again.months[OCT]!.budgetLog).toHaveLength(3);
  });

  it('budget/add: un movimiento negativo recorta la parte, y otra cuenta estrena la suya', () => {
    const s = frozen();
    const cut = reduce(s, { type: 'budget/add', key: OCT, row: entry({ amount: -70000 }) });
    // La cuenta que suma 0 deja de aparecer en las partes, pero su registro sigue.
    expect(cut.months[OCT]!.budgets).toEqual({});
    expect(cut.months[OCT]!.budgetLog).toHaveLength(3);
    const other = reduce(s, { type: 'budget/add', key: OCT, row: entry({ accountId: 'us', amount: 150, kind: 'initial' }) });
    expect(other.months[OCT]!.budgets).toEqual({ dr: 70000, us: 150 });
    expect(monthCalc(other, OCT).budget).toBeCloseTo(70000 + 150 * 58.76, 8);
  });

  it('budget/remove quita ese movimiento y recalcula; uno que no está, o un mes que no existe, no cambia nada', () => {
    const s = frozen();
    // El ajuste del día 5 (5,000, "Car repair").
    const next = reduce(s, { type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-2' });
    expect(next.months[OCT]!.budgetLog.map((e) => e.id)).toEqual(['seed-bg-2026-10-1']);
    expect(next.months[OCT]!.budgets).toEqual({ dr: 65000 });
    expect(monthCalc(next, OCT).budget).toBe(65000);
    expect(reduce(next, { type: 'budget/remove', key: OCT, id: 'seed-bg-2026-10-2' })).toBe(next);
    expect(reduce(s, { type: 'budget/remove', key: OCT, id: 'nope' })).toBe(s);
    // El id es de octubre: en otro mes no está.
    expect(reduce(s, { type: 'budget/remove', key: '2026-09', id: 'seed-bg-2026-10-2' })).toBe(s);
    expect(reduce(s, { type: 'budget/remove', key: '2030-01', id: 'seed-bg-2026-10-2' })).toBe(s);
    expect(reduce(s, { type: 'budget/add', key: '2030-01', row: entry() })).toBe(s);
  });

  it('budget/leftover suma el sobrante una sola vez por mes', () => {
    const s = frozen();
    const row = leftoverEntry(s, OCT, 'local-lo', '2026-10-07')!;
    const next = reduce(s, { type: 'budget/leftover', key: OCT, row });
    expect(next.months[OCT]!.budgetLog.at(-1)).toBe(row);
    expect(next.months[OCT]!.budgets.dr).toBeCloseTo(70000 + row.amount, 8);
    expect(monthCalc(next, OCT).budget).toBeCloseTo(70000 + monthCalc(s, '2026-09').avail, 8);
    expect(leftoverFor(next, OCT).added).toBe(true);
    // La misma acción otra vez, u otra con otro id (el servidor ya lo escribió con el suyo): no se repite.
    expect(reduce(next, { type: 'budget/leftover', key: OCT, row })).toBe(next);
    expect(reduce(next, { type: 'budget/leftover', key: OCT, row: { ...row, id: 'server-id', amount: 1 } })).toBe(next);
    expect(reduce(s, { type: 'budget/leftover', key: '2030-01', row })).toBe(s);
  });

  it('budget/leftover: quitado el movimiento, se puede volver a sumar', () => {
    const s = frozen();
    const row = { ...leftoverEntry(s, OCT, 'lo-1', '2026-10-07')! };
    const added = reduce(s, { type: 'budget/leftover', key: OCT, row });
    const removed = reduce(added, { type: 'budget/remove', key: OCT, id: 'lo-1' });
    expect(removed.months[OCT]!.budgetLog).toEqual(s.months[OCT]!.budgetLog);
    expect(leftoverFor(removed, OCT).added).toBe(false);
    expect(reduce(removed, { type: 'budget/leftover', key: OCT, row }).months[OCT]!.budgetLog).toHaveLength(3);
  });
});

describe('reduce · tasas del mes', () => {
  it('la tasa escrita manda sobre los envíos del mes', () => {
    const s = frozen();
    // Agosto no tiene tasa escrita: sale de sus envíos.
    expect(rateFor(s, '2026-08', 'USD', 'DOP').source).toBe('transfers');
    const next = reduce(s, { type: 'rate/set', key: '2026-08', rate: { from: 'USD', to: 'DOP', rate: 60, date: '2026-08-10' } });
    expect(next.months['2026-08']!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 60, date: '2026-08-10' }]);
    expect(monthCalc(next, '2026-08').rate).toEqual({ rate: 60, source: 'month', monthKey: '2026-08', date: '2026-08-10' });
    expect(next.months[OCT]).toBe(s.months[OCT]);
  });

  it('hay una por par y fecha: la nueva sustituye a la de esa fecha, en el sentido que fuera, y en su sitio', () => {
    // Octubre trae USD → DOP escrita dos veces: el día 1 y el día 6.
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
    // La de otra fecha ni se toca: sigue valiendo para lo registrado antes del día 6.
    expect(s.months[OCT]!.rates[0]).toBe(first);
    expect(rateFor(s, OCT, 'USD', 'DOP').rate).toBeCloseTo(1 / 0.0165, 10);
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-05').rate).toBe(58.76);
  });

  it('varias tasas del mismo par, cada una con su fecha: cada fila se convierte con la vigente en la suya', () => {
    let s = frozen();
    for (const [rate, date] of [[59, '2026-10-10'], [60, '2026-10-20'], [59.5, '2026-10-15']] as const) {
      s = reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate, date } });
    }
    // Se guardan en el orden en que se escribieron; shared/calc.ts las ordena por fecha.
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
    expect(monthCalc(s, OCT).rate.rate).toBe(60);
    // Lo ya registrado no cambia: las siete transacciones de octubre son de los días 1 a 7.
    expect(monthCalc(s, OCT).varSpent).toBe(monthCalc(seedState(), OCT).varSpent);
  });

  it('escribir la misma tasa otra vez no cambia nada', () => {
    const s = frozen();
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' } })).toBe(s);
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' } })).toBe(s);
    expect(reduce(s, { type: 'rate/set', key: '2030-01', rate: { from: 'USD', to: 'DOP', rate: 1, date: '2030-01-01' } })).toBe(s);
    // El mismo número en otra fecha sí es otra tasa.
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-07' } }).months[OCT]!.rates).toHaveLength(3);
  });

  it('quitar una tasa quita solo la de esa fecha; sin ninguna, el par vuelve a lo que resuelva shared/calc', () => {
    const s = frozen();
    // Se quita aunque se pida en el otro sentido.
    const one = reduce(s, { type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD', date: '2026-10-06' });
    expect(one.months[OCT]!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    expect(one.months[OCT]!.rates[0]).toBe(s.months[OCT]!.rates[0]);
    expect(monthCalc(one, OCT).rate).toEqual({ rate: 58.76, source: 'month', monthKey: OCT, date: '2026-10-01' });
    const none = reduce(one, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-01' });
    expect(none.months[OCT]!.rates).toEqual([]);
    expect(monthCalc(none, OCT).rate).toEqual({ rate: 58.76, source: 'transfers', monthKey: OCT, date: null });
    // Otro par, otra fecha u otro mes: nada que quitar.
    expect(reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'TRY', date: '2026-10-06' })).toBe(s);
    expect(reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-02' })).toBe(s);
    expect(reduce(s, { type: 'rate/remove', key: '2026-09', from: 'USD', to: 'DOP', date: '2026-10-06' })).toBe(s);
  });

  it('quitar la tasa de una fecha devuelve sus filas a la anterior', () => {
    const s = frozen(twoRates());
    expect(rateFor(s, OCT, 'USD', 'DOP', '2026-10-07').rate).toBe(60);
    const next = reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-06' });
    expect(rateFor(next, OCT, 'USD', 'DOP', '2026-10-07').rate).toBe(58);
    expect(rateFor(next, OCT, 'USD', 'DOP').rate).toBe(58);
  });
});

describe('reduce · filas del mes', () => {
  it('marca un gasto fijo como pagado: sube lo usado y baja el saldo de su cuenta', () => {
    const s = frozen();
    const before = monthCalc(s, OCT);
    const netflix = s.months[OCT]!.fixed.find((f) => f.name === 'Netflix')!;
    const next = reduce(s, { type: 'fixed/patch', id: netflix.id, patch: { paid: true } });
    const after = monthCalc(next, OCT);
    expect(after.paidCount).toBe(before.paidCount + 1);
    expect(after.used).toBeCloseTo(before.used + 1137.3, 6);
    expect(after.pending).toBeCloseTo(before.pending - 1137.3, 6);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') - 1137.3, 6);
    // Solo cambia esa fila.
    const rows = next.months[OCT]!.fixed;
    expect(rows.filter((r, i) => r !== s.months[OCT]!.fixed[i])).toHaveLength(1);
  });

  it('agrega, edita y elimina una transacción', () => {
    const s = frozen();
    const row = newTx(s, OCT, { date: '2026-10-07', desc: ' Uber ', cat: 'Transport', method: 'Card', amount: 850, cur: 'DOP' }, 'tx-new')!;
    expect(row).toMatchObject({ id: 'tx-new', monthKey: OCT, desc: 'Uber', place: '', notes: '', accountId: 'dr', source: 'web', createdAt: null });

    let next = reduce(s, { type: 'tx/add', row });
    expect(next.months[OCT]!.tx).toHaveLength(8);
    expect(monthCalc(next, OCT).varSpent).toBe(10845 + 850);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') - 850, 6);

    next = reduce(next, { type: 'tx/patch', id: 'tx-new', patch: { amount: 10, cur: 'USD' } });
    expect(monthCalc(next, OCT).varSpent).toBeCloseTo(10845 + 10 * 58.76, 6);

    // Pagada desde otra cuenta: el gasto del mes es el mismo, pero sale de la US account.
    next = reduce(next, { type: 'tx/patch', id: 'tx-new', patch: { accountId: 'us' } });
    expect(monthCalc(next, OCT).varSpent).toBeCloseTo(10845 + 10 * 58.76, 6);
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') - 10, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr'), 6);

    next = reduce(next, { type: 'tx/remove', id: 'tx-new' });
    expect(next.months[OCT]!.tx).toEqual(s.months[OCT]!.tx);
  });

  it('encuentra la fila en el mes que sea (el id basta)', () => {
    const s = frozen();
    const id = s.months['2026-08']!.tx[0]!.id;
    const next = reduce(s, { type: 'tx/patch', id, patch: { notes: 'revisado' } });
    expect(next.months['2026-08']!.tx[0]!.notes).toBe('revisado');
    expect(next.months[OCT]).toBe(s.months[OCT]);
  });

  it('un envío mueve las dos cuentas: sale el monto de una y entra monto × tasa en la otra', () => {
    const s = frozen();
    const row = newTransfer(s, OCT, { date: '2026-10-08', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 57 }, 'tr-new')!;
    let next = reduce(s, { type: 'transfer/add', row });
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') - 500, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 500 * 57, 6);

    // Se edita, no hace falta borrarlo y volver a cargarlo.
    next = reduce(next, { type: 'transfer/patch', id: 'tr-new', patch: { amount: 600, rate: 58 } });
    expect(next.months[OCT]!.transfers.at(-1)).toMatchObject({ id: 'tr-new', amount: 600, rate: 58, via: 'PayPal' });
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 600 * 58, 6);

    expect(reduce(next, { type: 'transfer/remove', id: 'tr-new' }).months[OCT]!.transfers).toEqual(s.months[OCT]!.transfers);
  });

  it('sin tasa escrita, un envío nuevo cambia la tasa del mes (promedio ponderado)', () => {
    const s = frozen({ ...seedState(), months: { ...seedState().months, [OCT]: { ...seedState().months[OCT]!, rates: [] } } });
    const row = newTransfer(s, OCT, { date: '2026-10-08', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 57 }, 'tr-new')!;
    const next = reduce(s, { type: 'transfer/add', row });
    expect(monthCalc(next, OCT).rate.rate).toBeCloseTo((1500 * 58.76 + 500 * 57) / 2000, 10);
  });

  it('editar o eliminar una fila que no existe deja el estado igual', () => {
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

describe('reduce · cuentas', () => {
  it('agrega una cuenta al final, la renombra, la oculta y la elimina', () => {
    const s = frozen();
    const row = newAccount(s, { name: ' TR account ', currency: 'TRY', opening: 1500 }, 'tr')!;
    expect(row).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 1500, hidden: false, sort: 2 });

    let next = reduce(s, { type: 'account/add', row });
    expect(next.accounts.map((a) => a.id)).toEqual(['us', 'dr', 'tr']);
    expect(next.months).toBe(s.months);
    expect(balanceOf(next, 'tr')).toBe(1500);

    next = reduce(next, { type: 'account/patch', id: 'tr', patch: { name: 'Garanti' } });
    expect(next.accounts.at(-1)).toEqual({ ...row, name: 'Garanti' });
    // Las demás cuentas conservan su identidad.
    expect(next.accounts[0]).toBe(s.accounts[0]);

    // Oculta no suma al dinero total, pero su saldo se sigue calculando.
    const total = balances(next, OCT).totalMain;
    next = reduce(next, { type: 'account/patch', id: 'tr', patch: { hidden: true } });
    expect(balances(next, OCT).totalMain).toBeLessThan(total);
    expect(balances(next, OCT).totalMain).toBeCloseTo(balances(s, OCT).totalMain, 6);
    expect(balanceOf(next, 'tr')).toBe(1500);

    next = reduce(next, { type: 'account/remove', id: 'tr' });
    expect(next.accounts).toEqual(s.accounts);
  });

  it('corregir un saldo es cambiar el saldo inicial: los movimientos no se tocan', () => {
    const s = frozen();
    const opening = openingForBalance(s, OCT, 'dr', 200000)!;
    const next = reduce(s, { type: 'account/patch', id: 'dr', patch: { opening } });
    expect(balanceOf(next, 'dr')).toBeCloseTo(200000, 6);
    expect(next.months).toBe(s.months);
    expect(next.incomes).toBe(s.incomes);
  });

  it('si se elimina la cuenta por defecto, la elección vuelve a la automática', () => {
    const s = frozen({ ...seedState(), defaultAccountId: 'spare', accounts: [...seedState().accounts, newAccount(seedState(), { name: 'Spare', currency: 'USD' }, 'spare')!] });
    const next = reduce(s, { type: 'account/remove', id: 'spare' });
    expect(next.defaultAccountId).toBeNull();
    expect(reduce(s, { type: 'account/remove', id: 'us' }).defaultAccountId).toBe('spare');
  });
});

describe('reduce · ingresos', () => {
  it('agrega, edita y elimina: el ingreso del mes es la suma de los suyos y entra a su cuenta', () => {
    const s = frozen();
    const row = newIncome(s, { date: '2026-10-15', desc: ' Bonus ', accountId: 'us', amount: 1000, cur: 'USD' }, 'in-new')!;
    expect(row).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD', budget: false });

    let next = reduce(s, { type: 'income/add', row });
    expect(next.incomes).toHaveLength(4);
    expect(next.months).toBe(s.months);
    expect(monthCalc(next, OCT).income).toBeCloseTo(6800 * 58.76, 6);
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us') + 1000, 8);

    // Cobrado en otra moneda y en otra cuenta: entra convertido con la tasa del mes de su fecha.
    next = reduce(next, { type: 'income/patch', id: 'in-new', patch: { accountId: 'dr', amount: 100 } });
    expect(balanceOf(next, 'us')).toBeCloseTo(balanceOf(s, 'us'), 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(balanceOf(s, 'dr') + 100 * 58.76, 6);

    // Con fecha de otro mes deja de contar en este.
    next = reduce(next, { type: 'income/patch', id: 'in-new', patch: { date: '2026-09-15' } });
    expect(monthCalc(next, OCT).income).toBeCloseTo(5800 * 58.76, 6);

    expect(reduce(next, { type: 'income/remove', id: 'in-new' }).incomes).toEqual(s.incomes);
  });

  it('un ingreso marcado para el presupuesto sube la parte de su cuenta sin tocar el registro del mes', () => {
    const s = frozen();
    const row = newIncome(s, { date: '2026-10-15', desc: 'Bonus', accountId: 'dr', amount: 100, cur: 'USD', budget: true }, 'in-new')!;
    expect(row.budget).toBe(true);
    const next = reduce(s, { type: 'income/add', row });
    // Ningún BudgetEntry: lo suma shared/calc.ts.
    expect(next.months).toBe(s.months);
    expect(monthCalc(next, OCT).budget).toBeCloseTo(70000 + 100 * 58.76, 8);
    expect(partOf(next, 'dr')).toMatchObject({ fromLog: 70000 });
    expect(partOf(next, 'dr').fromIncomes).toBeCloseTo(5876, 8);
    expect(budgetHistory(next, OCT).at(-1)).toMatchObject({ kind: 'income', id: 'in-new', note: 'Bonus' });

    // Desmarcarlo lo devuelve a un ingreso corriente: entra a la cuenta, pero no al presupuesto.
    const off = reduce(next, { type: 'income/patch', id: 'in-new', patch: { budget: false } });
    expect(monthCalc(off, OCT).budget).toBe(70000);
    expect(balanceOf(off, 'dr')).toBe(balanceOf(next, 'dr'));
    // Y marcar uno que ya existía, también.
    const on = reduce(s, { type: 'income/patch', id: 'seed-in-3', patch: { budget: true } });
    expect(partOf(on, 'us')).toMatchObject({ amount: 5800, fromLog: 0, fromIncomes: 5800 });
    expect(monthCalc(on, OCT).budget).toBeCloseTo(70000 + 5800 * 58.76, 6);
  });
});

describe('reduce · aportes', () => {
  it('agrega, edita y elimina; no mueven el saldo de ninguna cuenta', () => {
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

describe('reduce · ajustes', () => {
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('cambia el idioma sin tocar los colores, y al revés', () => {
    const s = frozen();
    const tr = reduce(s, { type: 'settings/patch', patch: { language: 'tr' } });
    expect(tr.language).toBe('tr');
    expect(tr.theme).toBeNull();
    expect(tr.months).toBe(s.months);

    const themed = reduce(tr, { type: 'settings/patch', patch: { theme: ocean } });
    expect(themed.theme).toEqual(ocean);
    expect(themed.language).toBe('tr');
  });

  it('theme: null vuelve a la paleta original', () => {
    const themed = reduce(frozen(), { type: 'settings/patch', patch: { theme: ocean } });
    expect(reduce(themed, { type: 'settings/patch', patch: { theme: null } }).theme).toBeNull();
  });

  it('monedas y cuenta por defecto: solo cambia lo que venga, y todo se recalcula en la moneda nueva', () => {
    const s = frozen();
    const tr = reduce(s, { type: 'settings/patch', patch: { secondCurrency: 'TRY' } });
    expect([tr.mainCurrency, tr.secondCurrency, tr.defaultAccountId, tr.language]).toEqual(['DOP', 'TRY', 'dr', 'en']);

    const swapped = reduce(s, { type: 'settings/patch', patch: { mainCurrency: 'USD', secondCurrency: 'DOP' } });
    expect([swapped.mainCurrency, swapped.secondCurrency]).toEqual(['USD', 'DOP']);
    expect(monthCalc(swapped, OCT).budget).toBeCloseTo(70000 / 58.76, 8);
    expect(monthCalc(swapped, OCT).budgetSecond).toBeCloseTo(70000, 8);
    // Lo guardado no cambia: nada convertido se persiste.
    expect(swapped.months).toBe(s.months);

    expect(reduce(s, { type: 'settings/patch', patch: { defaultAccountId: null } }).defaultAccountId).toBeNull();
    expect(reduce(s, { type: 'settings/patch', patch: { defaultAccountId: 'us' } }).defaultAccountId).toBe('us');
  });

  it('un patch que no cambia nada devuelve el mismo estado', () => {
    const s = frozen();
    expect(reduce(s, { type: 'settings/patch', patch: {} })).toBe(s);
    expect(reduce(s, { type: 'settings/patch', patch: { language: 'en', theme: null, mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: 'dr' } })).toBe(s);
  });
});

describe('reduce · metas', () => {
  it('agrega una meta al final, la edita y la elimina', () => {
    const s = frozen();
    const row = newGoal(s, { name: ' Car ', monthly: 500, start: '2026-10', end: '2027-09' }, 'g-new')!;
    // Sin moneda indicada, la principal del usuario.
    expect(row).toEqual({ id: 'g-new', name: 'Car', cur: 'DOP', monthly: 500, start: '2026-10', end: '2027-09', approxCur: null, sort: 3 });

    let next = reduce(s, { type: 'goal/add', row });
    expect(next.goals.map((g) => g.id)).toEqual(['emergency', 'personal', 'turkey', 'g-new']);
    expect(next.contribs).toBe(s.contribs);
    expect(next.months).toBe(s.months);

    next = reduce(next, { type: 'goal/patch', id: 'g-new', patch: { name: 'New car', monthly: 600, cur: 'USD', approxCur: 'TRY' } });
    expect(next.goals.at(-1)).toEqual({ ...row, name: 'New car', monthly: 600, cur: 'USD', approxCur: 'TRY' });
    // null es un valor: vuelve a la moneda principal del usuario.
    expect(reduce(next, { type: 'goal/patch', id: 'g-new', patch: { approxCur: null } }).goals.at(-1)!.approxCur).toBeNull();
    // Las demás metas conservan su identidad.
    expect(next.goals[0]).toBe(s.goals[0]);

    next = reduce(next, { type: 'goal/remove', id: 'g-new' });
    expect(next.goals).toEqual(s.goals);
  });

  it('editar o eliminar una meta que no existe deja el estado igual', () => {
    const s = frozen();
    expect(reduce(s, { type: 'goal/patch', id: 'nope', patch: { name: 'x' } })).toBe(s);
    expect(reduce(s, { type: 'goal/remove', id: 'nope' })).toBe(s);
  });
});

describe('reduce · idempotencia', () => {
  // Un refetch puede traer el estado con la acción ya aplicada mientras sigue pendiente en el cliente.
  it('aplicar dos veces da lo mismo que una', () => {
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

describe('filas nuevas: validación del contrato', () => {
  const s = seedState();

  it('gasto fijo: concepto, monto > 0 y una cuenta que exista; queda al final y sin pagar', () => {
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

  it('sin cuenta indicada sale la cuenta por defecto del usuario (shared/calc defaultAccount)', () => {
    const tx = { date: '2026-10-07', desc: 'Café', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP' as const };
    expect(newTx(s, OCT, tx, 'x')!.accountId).toBe('dr');
    // Sin elección guardada: la primera visible en la moneda principal.
    expect(newTx({ ...s, defaultAccountId: null, mainCurrency: 'USD', secondCurrency: 'DOP' }, OCT, tx, 'x')!.accountId).toBe('us');
    // La elegida está oculta: no cuenta.
    const hidden = { ...s, accounts: s.accounts.map((a) => (a.id === 'dr' ? { ...a, hidden: true } : a)) };
    expect(newTx(hidden, OCT, tx, 'x')!.accountId).toBe('us');
    expect(newIncome(hidden, { date: '2026-10-07', amount: 1, cur: 'USD' }, 'x')!.accountId).toBe('us');
    // Sin ninguna cuenta no hay de dónde pagar.
    expect(newTx({ ...s, accounts: [] }, OCT, tx, 'x')).toBeNull();
    expect(newFixed({ ...s, accounts: [] }, OCT, { name: 'Gym', amount: 1, cur: 'DOP' }, 'x')).toBeNull();
  });

  it('transacción: descripción, fecha válida, monto > 0 y una cuenta que exista', () => {
    const ok = { date: '2026-10-07', desc: 'Café', cat: 'Food', method: 'Card', amount: 385, cur: 'DOP' as const };
    expect(newTx(s, OCT, ok, 'x')).not.toBeNull();
    expect(newTx(s, OCT, { ...ok, desc: ' ' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, amount: -5 }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, date: '' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, date: '2026-02-30' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, accountId: 'gone' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, cur: 'EUR' as 'USD' }, 'x')).toBeNull();
    expect(newTx(s, OCT, { ...ok, cur: 'TRY', accountId: 'us' }, 'x')).toMatchObject({ cur: 'TRY', accountId: 'us' });
    // La hoja manda: una fecha de otro mes no cambia a qué mes pertenece.
    expect(newTx(s, OCT, { ...ok, date: '2026-11-01' }, 'x')!.monthKey).toBe(OCT);
  });

  it('envío: vía, fecha, monto > 0 y dos cuentas distintas que existan', () => {
    const ok = { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 58.7 };
    // Sin `budget` el envío no sube el presupuesto.
    expect(newTransfer(s, OCT, ok, 'x')).toEqual({ id: 'x', monthKey: OCT, ...ok, budget: false });
    expect(newTransfer(s, OCT, { ...ok, budget: true }, 'x')).toMatchObject({ budget: true });
    expect(newTransfer(s, OCT, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, rate: 0 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, rate: -1 }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, date: '2026-13-01' }, 'x')).toBeNull();
    expect(newTransfer(s, '2030-01', ok, 'x')).toBeNull();
    // La misma cuenta en los dos lados, o una que no existe.
    expect(newTransfer(s, OCT, { ...ok, toAccountId: 'us' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, fromAccountId: 'gone' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, toAccountId: 'gone' }, 'x')).toBeNull();
    // En el otro sentido también vale: de la DR account a la US account.
    expect(newTransfer(s, OCT, { ...ok, fromAccountId: 'dr', toAccountId: 'us', rate: 1 / 59 }, 'x')).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    // La vía es texto libre: vale cualquier nombre, sin espacios sobrantes, pero no puede faltar ni pasarse de largo.
    expect(newTransfer(s, OCT, { ...ok, via: '  Western Union ' }, 'x')!.via).toBe('Western Union');
    expect(newTransfer(s, OCT, { ...ok, via: '   ' }, 'x')).toBeNull();
    expect(newTransfer(s, OCT, { ...ok, via: 'x'.repeat(61) }, 'x')).toBeNull();
  });

  it('envío sin tasa: la vigente en su fecha para ese par; entre cuentas de la misma moneda, siempre 1', () => {
    const base = { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 500 };
    expect(newTransfer(s, OCT, base, 'x')!.rate).toBe(58.76);
    expect(newTransfer(s, OCT, { ...base, fromAccountId: 'dr', toAccountId: 'us' }, 'x')!.rate).toBeCloseTo(1 / 58.76, 12);
    // Agosto no tiene tasa escrita, ni la había antes: la de sus envíos.
    expect(newTransfer(s, '2026-08', { ...base, date: '2026-08-20' }, 'x')!.rate).toBeCloseTo(rateFor(s, '2026-08', 'USD', 'DOP').rate, 12);

    // Con dos tasas escritas en el mes (58 desde el día 1, 60 desde el día 6), manda la fecha del envío.
    const dated = twoRates();
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03' }, 'x')!.rate).toBe(58);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-05' }, 'x')!.rate).toBe(58);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-06' }, 'x')!.rate).toBe(60);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-28' }, 'x')!.rate).toBe(60);
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03', fromAccountId: 'dr', toAccountId: 'us' }, 'x')!.rate).toBeCloseTo(1 / 58, 12);
    // La escrita a mano en el envío manda sobre cualquiera de las dos.
    expect(newTransfer(dated, OCT, { ...base, date: '2026-10-03', rate: 57.5 }, 'x')!.rate).toBe(57.5);

    const two = { ...s, accounts: [...s.accounts, newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')!] };
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp' }, 'x')!.rate).toBe(1);
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp', rate: 58 }, 'x')!.rate).toBe(1);
  });

  it('ingreso: fecha válida, monto > 0 y una cuenta que exista; no pertenece a un mes', () => {
    const ok = { date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD' as const };
    expect(newIncome(s, ok, 'x')).toEqual({ id: 'x', ...ok, budget: false });
    expect(newIncome(s, { ...ok, desc: undefined }, 'x')!.desc).toBe('');
    // Sube el presupuesto solo si se marca.
    expect(newIncome(s, { ...ok, budget: true }, 'x')).toEqual({ id: 'x', ...ok, budget: true });
    expect(newIncome(s, { ...ok, budget: false }, 'x')!.budget).toBe(false);
    expect(newIncome(s, { ...ok, budget: undefined }, 'x')!.budget).toBe(false);
    expect(newIncome(s, { ...ok, budget: 'yes' as unknown as boolean }, 'x')!.budget).toBe(false);
    // Marcado vale también con fecha de un mes cerrado: no pertenece al mes.
    expect(newIncome(s, { ...ok, date: '2026-09-15', budget: true }, 'x')).toMatchObject({ date: '2026-09-15', budget: true });
    expect(newIncome(s, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, date: '2026-02-30' }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, accountId: 'gone' }, 'x')).toBeNull();
    expect(newIncome(s, { ...ok, desc: 'x'.repeat(201) }, 'x')).toBeNull();
    // Vale con fecha de un mes cerrado y de uno que no existe.
    expect(newIncome(s, { ...ok, date: '2026-08-15' }, 'x')).not.toBeNull();
    expect(newIncome(s, { ...ok, date: '2027-03-01' }, 'x')).not.toBeNull();
  });

  it('aporte: monto > 0 y una meta que exista', () => {
    const ok = { goalId: 'turkey', date: '2026-10-07', amount: 3000, cur: 'USD' as const };
    expect(newContribution(s, ok, 'x')).toEqual({ id: 'x', ...ok });
    expect(newContribution(s, { ...ok, cur: 'TRY' }, 'x')).toMatchObject({ cur: 'TRY' });
    expect(newContribution(s, { ...ok, amount: 0 }, 'x')).toBeNull();
    expect(newContribution(s, { ...ok, goalId: 'marte' }, 'x')).toBeNull();
  });

  it('cuenta: nombre, una de las tres monedas y un saldo inicial finito (puede ser negativo)', () => {
    expect(newAccount(s, { name: 'PayPal', currency: 'USD' }, 'x')).toEqual({ id: 'x', name: 'PayPal', currency: 'USD', opening: 0, hidden: false, sort: 2 });
    expect(newAccount(s, { name: 'Card', currency: 'DOP', opening: -2500.5 }, 'x')!.opening).toBe(-2500.5);
    expect(newAccount(s, { name: '  ', currency: 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'x'.repeat(121), currency: 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'Euro', currency: 'EUR' as 'USD' }, 'x')).toBeNull();
    expect(newAccount(s, { name: 'PayPal', currency: 'USD', opening: Number.NaN }, 'x')).toBeNull();
    expect(newAccount({ ...s, accounts: [] }, { name: 'First', currency: 'TRY' }, 'x')!.sort).toBe(0);
  });
});

describe('ediciones de celda: lo que el servidor rechazaría se ignora y el resto se guarda', () => {
  const s = seedState();
  const transfer = s.months[OCT]!.transfers[0]!;

  it('gasto fijo y transacción', () => {
    expect(fixedChange(s, { name: '', amount: 99 })).toEqual({ amount: 99 });
    expect(fixedChange(s, { name: 'Gym', amount: -1, paid: true })).toEqual({ name: 'Gym', paid: true });
    expect(fixedChange(s, { accountId: 'gone' })).toEqual({});
    expect(fixedChange(s, { accountId: 'us', amount: 0 })).toEqual({ accountId: 'us', amount: 0 });
    expect(txChange(s, { desc: '  ', notes: '' })).toEqual({ notes: '' });
    expect(txChange(s, { date: '2026-02-30', amount: Number.NaN, accountId: 'gone', cat: 'Travel' })).toEqual({ cat: 'Travel' });
    // Un patch válido pasa tal cual (es el mismo objeto).
    const ok = { desc: 'Uber', accountId: 'us', cur: 'TRY' as const };
    expect(txChange(s, ok)).toBe(ok);
  });

  it('ingreso y aporte', () => {
    expect(incomeChange(s, { amount: -5, desc: '' })).toEqual({ desc: '' });
    expect(incomeChange(s, { accountId: 'gone', date: 'ayer', amount: 10 })).toEqual({ amount: 10 });
    // La casilla "sube el presupuesto" pasa en los dos sentidos; lo que no sea un booleano, no.
    expect(incomeChange(s, { budget: true })).toEqual({ budget: true });
    expect(incomeChange(s, { budget: false, amount: -1 })).toEqual({ budget: false });
    expect(incomeChange(s, { budget: 'yes' as unknown as boolean, desc: 'Bonus' })).toEqual({ desc: 'Bonus' });
    expect(contributionChange(s, { goalId: 'marte', amount: 10 })).toEqual({ amount: 10 });
    expect(contributionChange(s, { goalId: 'personal', date: '2026-10-09', amount: -1, cur: 'DOP' })).toEqual({ goalId: 'personal', date: '2026-10-09', cur: 'DOP' });
  });

  it('envío: vía, fecha, monto y tasa', () => {
    expect(transferChange(s, transfer.id, { via: 'Wise', amount: 1600, rate: 58.9, date: '2026-10-03' })).toEqual({
      via: 'Wise',
      amount: 1600,
      rate: 58.9,
      date: '2026-10-03',
    });
    expect(transferChange(s, transfer.id, { via: '  ', amount: -1, rate: 0, date: 'x' })).toEqual({});
    expect(transferChange(s, 'nope', { amount: 5 })).toEqual({});
  });

  it('envío: un cambio de cuenta tiene que dejar dos cuentas distintas que existan', () => {
    expect(transferChange(s, transfer.id, { toAccountId: 'us' })).toEqual({});
    expect(transferChange(s, transfer.id, { fromAccountId: 'gone' })).toEqual({});
    // Se invierte el envío en una sola edición: las dos cuentas cambian a la vez.
    expect(transferChange(s, transfer.id, { fromAccountId: 'dr', toAccountId: 'us' })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      rate: rateFor(s, OCT, 'DOP', 'USD').rate,
    });
    // El resto del patch se guarda aunque el cambio de cuenta no valga.
    expect(transferChange(s, transfer.id, { toAccountId: 'us', amount: 900 })).toEqual({ amount: 900 });
  });

  it('envío: si cambian las monedas, la tasa pasa a ser la del mes para el par nuevo (1 entre monedas iguales)', () => {
    const more: AppState = {
      ...s,
      accounts: [...s.accounts, newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')!, { ...newAccount(s, { name: 'Popular', currency: 'DOP' }, 'bp')!, sort: 3 }],
    };
    // Misma moneda en los dos lados: 1, y una tasa escrita no la cambia.
    expect(transferChange(more, transfer.id, { toAccountId: 'pp' })).toEqual({ toAccountId: 'pp', rate: 1 });
    expect(transferChange(more, transfer.id, { toAccountId: 'pp', rate: 58 })).toEqual({ toAccountId: 'pp', rate: 1 });
    // Otra cuenta de la misma moneda: las monedas del envío no cambian y la tasa se queda.
    expect(transferChange(more, transfer.id, { toAccountId: 'bp' })).toEqual({ toAccountId: 'bp' });
    expect(transferChange(more, transfer.id, { fromAccountId: 'pp' })).toEqual({ fromAccountId: 'pp' });
    // Si viene una tasa con el cambio, manda la escrita.
    expect(transferChange(more, transfer.id, { fromAccountId: 'dr', toAccountId: 'us', rate: 0.0171 })).toEqual({
      fromAccountId: 'dr',
      toAccountId: 'us',
      rate: 0.0171,
    });
  });

  it('envío: la tasa del par nuevo es la vigente en la fecha del envío (la nueva, si la fecha cambia a la vez)', () => {
    // El envío de octubre es del día 2: entre la tasa del día 1 (58) y la del día 6 (60).
    const dated = twoRates();
    const flipped = transferChange(dated, transfer.id, { fromAccountId: 'dr', toAccountId: 'us' });
    expect(flipped.rate).toBeCloseTo(1 / 58, 12);
    const moved = transferChange(dated, transfer.id, { fromAccountId: 'dr', toAccountId: 'us', date: '2026-10-08' });
    expect(moved).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', date: '2026-10-08' });
    expect(moved.rate).toBeCloseTo(1 / 60, 12);
    // Cambiar solo la fecha no toca la tasa: la del envío es la que se usó de verdad.
    expect(transferChange(dated, transfer.id, { date: '2026-10-08' })).toEqual({ date: '2026-10-08' });
  });
});

describe('cuentas: reglas', () => {
  const s = seedState();
  const withSpare = (): AppState => ({ ...s, accounts: [...s.accounts, newAccount(s, { name: 'Spare', currency: 'TRY' }, 'spare')!] });

  it('accountName: el nombre es obligatorio', () => {
    expect(accountName(s, 'us', 'Chase')).toBe('Chase');
    expect(accountName(s, 'us', '   ')).toBeNull();
    expect(accountName(s, 'us', 'x'.repeat(121))).toBeNull();
    expect(accountName(s, 'gone', 'Chase')).toBeNull();
  });

  it('accountInUse / canRemoveAccount: solo se elimina una cuenta que nada nombra', () => {
    expect(accountInUse(s, 'us')).toBe(true);
    expect(accountInUse(s, 'dr')).toBe(true);
    expect(canRemoveAccount(s, 'us')).toBe(false);
    expect(canRemoveAccount(s, 'gone')).toBe(false);
    const spare = withSpare();
    expect(accountInUse(spare, 'spare')).toBe(false);
    expect(canRemoveAccount(spare, 'spare')).toBe(true);

    // Cada cosa que puede nombrarla, por separado.
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
    // Lo que cuenta es el registro, no la suma: una parte que se dejó en cero sigue nombrando la cuenta.
    const zeroed = reduce(reduce(spare, uses[0]!), { type: 'month/patch', key: '2026-08', patch: { budgets: { spare: 0 } } });
    expect(zeroed.months['2026-08']!.budgets).toEqual({ dr: 70000 });
    expect(canRemoveAccount(zeroed, 'spare')).toBe(false);
    // Ser la cuenta por defecto es una preferencia, no un movimiento.
    expect(canRemoveAccount({ ...spare, defaultAccountId: 'spare' }, 'spare')).toBe(true);
  });

  it('canHideAccount: cualquiera visible menos la última', () => {
    expect(canHideAccount(s, 'us')).toBe(true);
    expect(canHideAccount(s, 'gone')).toBe(false);
    const one = reduce(s, { type: 'account/patch', id: 'us', patch: { hidden: true } });
    expect(canHideAccount(one, 'dr')).toBe(false);
    expect(canHideAccount(one, 'us')).toBe(false);
  });

  it('openingForBalance: el saldo inicial que hace que la cuenta muestre el saldo escrito', () => {
    expect(latestKey(s)).toBe(OCT);
    // DR account: saldo 220,641.93 con un inicial de 60,000 (shared/calc.test.ts). Para ver 200,000 hacen falta 39,358.07.
    const opening = openingForBalance(s, OCT, 'dr', 200000)!;
    expect(opening).toBeCloseTo(39358.07, 6);
    const fixed = reduce(s, { type: 'account/patch', id: 'dr', patch: { opening } });
    expect(balanceOf(fixed, 'dr')).toBeCloseTo(200000, 6);
    // Corregir otra vez parte del saldo ya corregido.
    const again = openingForBalance(fixed, OCT, 'dr', 150000.5)!;
    expect(balanceOf(reduce(fixed, { type: 'account/patch', id: 'dr', patch: { opening: again } }), 'dr')).toBeCloseTo(150000.5, 6);
    // El saldo puede quedar en cero o en negativo.
    expect(balanceOf(reduce(s, { type: 'account/patch', id: 'us', patch: { opening: openingForBalance(s, OCT, 'us', -250)! } }), 'us')).toBeCloseTo(-250, 8);
    // Escribir el saldo que ya tiene deja el inicial donde estaba.
    expect(openingForBalance(s, OCT, 'us', 13482)).toBeCloseTo(2000, 8);
  });

  it('openingForBalance: solo en el último mes del usuario; un saldo pasado es historia', () => {
    expect(openingForBalance(s, '2026-09', 'dr', 200000)).toBeNull();
    expect(openingForBalance(s, '2026-08', 'us', 1)).toBeNull();
    expect(openingForBalance(s, OCT, 'gone', 1)).toBeNull();
    expect(openingForBalance(s, OCT, 'dr', Number.NaN)).toBeNull();
    // El último mes cuenta aunque esté cerrado: las cuentas no pertenecen a un mes.
    const closed = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, closed: true } } };
    expect(openingForBalance(closed, OCT, 'dr', 200000)).toBeCloseTo(39358.07, 6);
    // Si se borra octubre, el último pasa a ser septiembre.
    const sep = removeMonth(s, OCT);
    expect(latestKey(sep)).toBe('2026-09');
    expect(openingForBalance(sep, '2026-09', 'us', 100)).not.toBeNull();
    expect(latestKey({ ...s, months: {} })).toBeNull();
  });

  it('budgetPart y monthRate: un mes abierto, una cuenta o un par que existan y un número que valga', () => {
    expect(budgetPart(s, OCT, 'us', 200)).toEqual({ budgets: { us: 200 } });
    expect(budgetPart(s, OCT, 'us', 0)).toEqual({ budgets: { us: 0 } });
    expect(budgetPart(s, OCT, 'us', -50)).toBeNull(); // la API solo acepta partes >= 0
    expect(budgetPart(s, OCT, 'gone', 200)).toBeNull();
    expect(budgetPart(s, OCT, 'us', Number.POSITIVE_INFINITY)).toBeNull();
    expect(budgetPart(s, '2026-09', 'us', 200)).toBeNull(); // cerrado
    expect(budgetPart(s, '2030-01', 'us', 200)).toBeNull();

    expect(monthRate(s, OCT, 'USD', 'TRY', 40, '2026-10-07')).toEqual({ from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' });
    expect(monthRate(s, OCT, 'USD', 'USD', 1, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', 0, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', -3, '2026-10-07')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'EUR' as 'TRY', 1.1, '2026-10-07')).toBeNull();
    expect(monthRate(s, '2026-09', 'USD', 'TRY', 40, '2026-09-07')).toBeNull();
  });

  it('monthRate: la fecha tiene que ser una fecha de verdad y caer dentro del mes', () => {
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-01')).toMatchObject({ date: '2026-10-01' });
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-31')).toMatchObject({ date: '2026-10-31' });
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-09-30')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-11-01')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10-32')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '2026-10')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, '')).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'DOP', 59, undefined as unknown as string)).toBeNull();
  });

  it('budgetPart: el monto es la parte tal como se ve; lo que se manda es lo que debe sumar el registro', () => {
    // Un ingreso de 10,000 DOP sube el presupuesto de la DR account: se ve en 80,000 (70,000 + 10,000).
    const raised = withBudgetIncome();
    expect(partOf(raised, 'dr')).toMatchObject({ amount: 80000, fromLog: 70000, fromIncomes: 10000 });
    expect(budgetPart(raised, OCT, 'dr', 85000)).toEqual({ budgets: { dr: 75000 } });
    // Escribir lo que ya se ve deja el registro donde estaba.
    expect(budgetPart(raised, OCT, 'dr', 80000)).toEqual({ budgets: { dr: 70000 } });
    expect(reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 80000)! })).toBe(raised);
    // Aplicado, la parte se ve en lo que se escribió.
    const next = reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 85000)! });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 85000, fromLog: 75000, fromIncomes: 10000 });
    // El ingreso es de la DR account: la parte de la otra cuenta no lo descuenta.
    expect(budgetPart(raised, OCT, 'us', 200)).toEqual({ budgets: { us: 200 } });
  });

  it('budgetPart: lo que suma un envío marcado se descuenta igual que lo de un ingreso', () => {
    // Además del ingreso de 10,000, el envío de octubre (88,140 DOP recibidos) sube la parte de la DR account.
    const raised = reduce(withBudgetIncome(), { type: 'transfer/patch', id: 'seed-tr-2026-10-1', patch: { budget: true } });
    expect(partOf(raised, 'dr')).toMatchObject({ amount: 168140, fromLog: 70000, fromIncomes: 10000, fromTransfers: 88140 });
    expect(budgetPart(raised, OCT, 'dr', 170000)).toEqual({ budgets: { dr: 71860 } });
    expect(budgetPart(raised, OCT, 'dr', 168140)).toEqual({ budgets: { dr: 70000 } });
    // Por debajo de lo que ya suman el ingreso y el envío el registro quedaría en negativo: no se puede.
    expect(budgetPart(raised, OCT, 'dr', 98139)).toBeNull();
    expect(budgetPart(raised, OCT, 'dr', 98140)).toEqual({ budgets: { dr: 0 } });
    // La cuenta de origen no descuenta nada.
    expect(budgetPart(raised, OCT, 'us', 200)).toEqual({ budgets: { us: 200 } });
    const next = reduce(raised, { type: 'month/patch', key: OCT, patch: budgetPart(raised, OCT, 'dr', 170000)! });
    expect(partOf(next, 'dr')).toMatchObject({ amount: 170000, fromLog: 71860, fromTransfers: 88140 });
  });

  it('transferChange: la casilla del presupuesto se manda tal cual, marcada o desmarcada', () => {
    const s = seedState();
    const id = s.months[OCT]!.transfers[0]!.id;
    expect(transferChange(s, id, { budget: true })).toEqual({ budget: true });
    expect(transferChange(s, id, { budget: false, amount: 900 })).toEqual({ budget: false, amount: 900 });
    expect(transferChange(s, id, { budget: 'yes' as unknown as boolean })).toEqual({});
    // Marcarla sube el presupuesto y no mueve los saldos.
    const on = reduce(s, { type: 'transfer/patch', id, patch: transferChange(s, id, { budget: true }) });
    expect(monthCalc(on, OCT).budget).toBe(158140);
    expect(balances(on, OCT)).toEqual(balances(s, OCT));
  });

  it('budgetPart: por debajo de lo que ya suman los ingresos no se puede (el registro quedaría en negativo)', () => {
    const raised = withBudgetIncome();
    // Justo lo de los ingresos: el registro queda en cero.
    expect(budgetPart(raised, OCT, 'dr', 10000)).toEqual({ budgets: { dr: 0 } });
    expect(budgetPart(raised, OCT, 'dr', 9999.99)).toBeNull();
    expect(budgetPart(raised, OCT, 'dr', 0)).toBeNull();
    // Sin ese ingreso, 0 vale.
    expect(budgetPart(s, OCT, 'dr', 0)).toEqual({ budgets: { dr: 0 } });
  });

  it('budgetPart: un ingreso en otra moneda cuenta convertido a la de la cuenta, con la tasa de su fecha', () => {
    // 100 USD cobrados el día 3 en la DR account, con 58 hasta el día 6 y 60 después: suman 5,800, no 6,000.
    const dated = twoRates();
    dated.incomes.push({ id: 'in-usd', date: '2026-10-03', desc: '', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    expect(partOf(dated, 'dr').fromIncomes).toBe(5800);
    expect(budgetPart(dated, OCT, 'dr', 80000)).toEqual({ budgets: { dr: 74200 } });
    expect(budgetPart(dated, OCT, 'dr', 5800)).toEqual({ budgets: { dr: 0 } });
    expect(budgetPart(dated, OCT, 'dr', 5799)).toBeNull();
  });

  it('budgetPart: solo cuentan los ingresos marcados y con fecha en ese mes', () => {
    expect(budgetPart(withBudgetIncome({ budget: false }), OCT, 'dr', 5000)).toEqual({ budgets: { dr: 5000 } });
    expect(budgetPart(withBudgetIncome({ date: '2026-09-28' }), OCT, 'dr', 5000)).toEqual({ budgets: { dr: 5000 } });
    expect(budgetPart(withBudgetIncome({ accountId: 'us', cur: 'USD', amount: 300 }), OCT, 'us', 500)).toEqual({ budgets: { us: 200 } });
  });

  it('typedRate: la tasa escrita del par y la fecha, en el sentido en que se guardó', () => {
    expect(typedRate(s, OCT, 'USD', 'DOP', '2026-10-06')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' });
    expect(typedRate(s, OCT, 'DOP', 'USD', '2026-10-01')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' });
    // Es la escrita ese día, no la vigente ese día.
    expect(typedRate(s, OCT, 'USD', 'DOP', '2026-10-03')).toBeNull();
    expect(typedRate(s, OCT, 'USD', 'TRY', '2026-10-06')).toBeNull();
    expect(typedRate(s, '2026-08', 'USD', 'DOP', '2026-08-01')).toBeNull();
    // Un mes cerrado no deja quitar sus tasas.
    const closed = { ...s, months: { ...s.months, [OCT]: { ...s.months[OCT]!, closed: true } } };
    expect(typedRate(closed, OCT, 'USD', 'DOP', '2026-10-06')).toBeNull();
  });

  it('newBudgetEntry: una cuenta que exista, un monto distinto de 0 y una fecha del mes', () => {
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
    expect(newBudgetEntry(s, '2026-09', { accountId: 'dr', amount: 1 }, 'x', '2026-09-07')).toBeNull(); // cerrado
    expect(newBudgetEntry(s, '2030-01', { accountId: 'dr', amount: 1 }, 'x', today)).toBeNull();
  });

  it('newBudgetEntry: sin fecha es hoy, llevado al mes si cae fuera', () => {
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2026-11-03')!.date).toBe('2026-10-31');
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2026-09-29')!.date).toBe('2026-10-01');
    expect(newBudgetEntry(s, OCT, { accountId: 'dr', amount: 1 }, 'x', '2027-01-15')!.date).toBe('2026-10-31');
  });

  it('budgetEntry / isLocalEntry: solo se puede quitar un movimiento que ya tiene id del servidor, de un mes abierto', () => {
    expect(budgetEntry(s, OCT, 'seed-bg-2026-10-2')).toBe(s.months[OCT]!.budgetLog[1]);
    expect(budgetEntry(s, OCT, 'nope')).toBeNull();
    expect(budgetEntry(s, '2026-09', 'seed-bg-2026-09-1')).toBeNull(); // cerrado
    expect(budgetEntry(s, '2030-01', 'seed-bg-2026-10-2')).toBeNull();
    // El que añade month/patch aquí todavía no tiene id: lo pone el servidor.
    const patched = reduce(s, { type: 'month/patch', key: OCT, patch: { budgets: { us: 200 } } });
    const local = patched.months[OCT]!.budgetLog.at(-1)!;
    expect(local.id.startsWith(LOCAL_ENTRY)).toBe(true);
    expect(isLocalEntry(local.id)).toBe(true);
    expect(budgetEntry(patched, OCT, local.id)).toBeNull();
    expect(isLocalEntry('seed-bg-2026-10-2')).toBe(false);
    expect(isLocalEntry('')).toBe(false);
  });

  it('leftoverEntry: lo que sobró del mes anterior, en la cuenta por defecto y en su moneda', () => {
    // Septiembre: presupuesto − usado, en la moneda principal (DOP). La cuenta por defecto es la DR account (DOP).
    const sep = monthCalc(s, '2026-09').avail;
    expect(sep).toBeGreaterThan(0);
    expect(leftoverEntry(s, OCT, 'local-lo', '2026-10-07')).toEqual({ id: 'local-lo', date: '2026-10-07', accountId: 'dr', amount: sep, kind: 'leftover', note: '' });
    // Hoy fuera del mes: la fecha se lleva al mes.
    expect(leftoverEntry(s, OCT, 'x', '2026-11-02')!.date).toBe('2026-10-31');
    expect(leftoverEntry(s, OCT, 'x', '2026-09-30')!.date).toBe('2026-10-01');
  });

  it('leftoverEntry: con la cuenta por defecto en otra moneda, convertido con la última tasa del mes', () => {
    const sep = monthCalc(s, '2026-09').avail;
    const usd = leftoverEntry({ ...s, defaultAccountId: 'us' }, OCT, 'x', '2026-10-07')!;
    expect(usd).toMatchObject({ accountId: 'us', kind: 'leftover' });
    expect(usd.amount).toBeCloseTo(sep / 58.76, 10);
    // La última del mes (60), no la vigente hoy (58): el día 3 todavía vale la del día 1.
    const dated = { ...twoRates(), defaultAccountId: 'us' };
    expect(leftoverEntry(dated, OCT, 'x', '2026-10-03')!.amount).toBeCloseTo(monthCalc(dated, '2026-09').avail / 60, 10);
    // Con otra moneda principal el sobrante ya viene en ella: a una cuenta en esa moneda entra tal cual.
    const main = { ...s, mainCurrency: 'USD' as const, secondCurrency: 'DOP' as const, defaultAccountId: 'us' };
    expect(leftoverEntry(main, OCT, 'x', '2026-10-07')!.amount).toBe(monthCalc(main, '2026-09').avail);
    // Sin cuenta elegida: la automática (shared/calc defaultAccount).
    expect(leftoverEntry({ ...s, defaultAccountId: null }, OCT, 'x', '2026-10-07')!.accountId).toBe('dr');
  });

  it('leftoverEntry: si el mes anterior se pasó del presupuesto, el movimiento es negativo', () => {
    const over = seedState();
    setBudgets(over.months['2026-09']!, { dr: 1000 });
    const row = leftoverEntry(over, OCT, 'x', '2026-10-07')!;
    expect(row.amount).toBe(monthCalc(over, '2026-09').avail);
    expect(row.amount).toBeLessThan(0);
    expect(monthCalc(reduce(over, { type: 'budget/leftover', key: OCT, row }), OCT).budget).toBeCloseTo(70000 + row.amount, 8);
  });

  it('leftoverEntry: null si no hay nada que sumar o no se puede', () => {
    // Mes cerrado.
    expect(leftoverEntry(s, '2026-09', 'x', '2026-09-07')).toBeNull();
    // Mes que no existe.
    expect(leftoverEntry(s, '2026-11', 'x', '2026-11-07')).toBeNull();
    // Sin mes anterior.
    const only = { ...s, months: { [OCT]: s.months[OCT]! } };
    expect(leftoverFor(only, OCT)).toEqual({ previousKey: null, leftover: null, added: false });
    expect(leftoverEntry(only, OCT, 'x', '2026-10-07')).toBeNull();
    // Ya sumado.
    const added = reduce(s, { type: 'budget/leftover', key: OCT, row: leftoverEntry(s, OCT, 'x', '2026-10-07')! });
    expect(leftoverEntry(added, OCT, 'y', '2026-10-08')).toBeNull();
    // Sin cuentas no hay dónde ponerlo.
    expect(leftoverEntry({ ...s, accounts: [] }, OCT, 'x', '2026-10-07')).toBeNull();
    // No sobró nada: el mes anterior usó justo su presupuesto.
    const even = seedState();
    const sep = even.months['2026-09']!;
    sep.fixed = [];
    sep.tx = [{ ...sep.tx[0]!, amount: 1000 }];
    setBudgets(sep, { dr: 1000 });
    expect(monthCalc(even, '2026-09').avail).toBe(0);
    expect(leftoverEntry(even, OCT, 'x', '2026-10-07')).toBeNull();
  });

  it('leftoverEntry: el mes anterior es el registrado más cercano, aunque no sea el del calendario', () => {
    const gap = removeMonth(s, '2026-09');
    expect(leftoverFor(gap, OCT).previousKey).toBe('2026-08');
    expect(leftoverEntry(gap, OCT, 'x', '2026-10-07')!.amount).toBe(monthCalc(gap, '2026-08').avail);
  });

  it('currencyChange: las dos monedas quedan siempre distintas', () => {
    // Principal DOP, segunda USD.
    expect(currencyChange(s, 'main', 'TRY')).toEqual({ mainCurrency: 'TRY' });
    expect(currencyChange(s, 'second', 'TRY')).toEqual({ secondCurrency: 'TRY' });
    // Elegir la que ocupa el otro puesto las intercambia: van las dos.
    expect(currencyChange(s, 'main', 'USD')).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    expect(currencyChange(s, 'second', 'DOP')).toEqual({ mainCurrency: 'USD', secondCurrency: 'DOP' });
    // La que ya está no cambia nada.
    expect(currencyChange(s, 'main', 'DOP')).toEqual({});
    expect(currencyChange(s, 'second', 'USD')).toEqual({});
    expect(currencyChange(s, 'main', 'EUR' as 'USD')).toBeNull();
  });
});

describe('metas: la regla del plan', () => {
  const s = seedState();
  const plan = { monthly: 500, start: '2026-10', end: '2027-09' };

  it('normalizeGoalPlan: sin plan o con los tres valores juntos', () => {
    const none = { monthly: null, start: null, end: null };
    expect(normalizeGoalPlan({})).toEqual(none);
    expect(normalizeGoalPlan(none)).toEqual(none);
    expect(normalizeGoalPlan(plan)).toEqual(plan);
    // Un solo mes: start = end.
    expect(normalizeGoalPlan({ monthly: 0.01, start: '2026-10', end: '2026-10' })).toEqual({ monthly: 0.01, start: '2026-10', end: '2026-10' });
  });

  it('normalizeGoalPlan: un plan a medias o imposible no vale', () => {
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

  it('newGoal: nombre obligatorio, plan válido y una moneda (por defecto, la principal)', () => {
    expect(newGoal(s, { name: 'Car' }, 'x')).toEqual({ id: 'x', name: 'Car', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 3 });
    expect(newGoal(s, { name: 'Car', cur: 'TRY', ...plan }, 'x')).toMatchObject({ cur: 'TRY', ...plan });
    expect(newGoal({ ...s, mainCurrency: 'USD', secondCurrency: 'DOP' }, { name: 'Car' }, 'x')!.cur).toBe('USD');
    expect(newGoal(s, { name: '   ' }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'x'.repeat(121) }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', monthly: 500 }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', ...plan, start: '2028-01' }, 'x')).toBeNull();
    expect(newGoal(s, { name: 'Car', cur: 'EUR' as 'USD' }, 'x')).toBeNull();
    // Sin metas, la primera lleva sort 0.
    expect(newGoal({ ...s, goals: [] }, { name: 'Car' }, 'x')!.sort).toBe(0);
  });

  it('newGoal: la moneda de la línea "≈" es opcional; null o sin indicar, la principal del usuario', () => {
    expect(newGoal(s, { name: 'Car' }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', approxCur: null }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', approxCur: undefined }, 'x')!.approxCur).toBeNull();
    expect(newGoal(s, { name: 'Car', cur: 'USD', approxCur: 'TRY', ...plan }, 'x')).toMatchObject({ cur: 'USD', approxCur: 'TRY', ...plan });
    // Puede ser cualquiera de las tres, también la de la propia meta o la principal.
    expect(newGoal(s, { name: 'Car', cur: 'USD', approxCur: 'USD' }, 'x')!.approxCur).toBe('USD');
    expect(newGoal(s, { name: 'Car', approxCur: 'DOP' }, 'x')!.approxCur).toBe('DOP');
    expect(newGoal(s, { name: 'Car', approxCur: 'EUR' as 'USD' }, 'x')).toBeNull();
  });

  it('goalChange: la moneda de la línea "≈", con null como un valor más', () => {
    expect(goalChange(s, 'turkey', { approxCur: 'TRY' })).toEqual({ approxCur: 'TRY' });
    // Ya era null: no hay nada que mandar.
    expect(goalChange(s, 'turkey', { approxCur: null })).toEqual({});
    expect(goalChange(s, 'turkey', { approxCur: undefined })).toEqual({});
    expect(goalChange(s, 'turkey', { approxCur: 'EUR' as 'USD' })).toBeNull();
    const lira = reduce(s, { type: 'goal/patch', id: 'turkey', patch: { approxCur: 'TRY' } });
    expect(goalChange(lira, 'turkey', { approxCur: 'TRY' })).toEqual({});
    expect(goalChange(lira, 'turkey', { approxCur: 'USD' })).toEqual({ approxCur: 'USD' });
    // Volver a la moneda principal es mandar null, no dejar de mandarlo.
    expect(goalChange(lira, 'turkey', { approxCur: null })).toEqual({ approxCur: null });
    // Viaja con lo demás del diálogo, sin arrastrar el plan si no cambió.
    expect(goalChange(lira, 'turkey', { name: 'Istanbul', approxCur: null, monthly: 3000 })).toEqual({ name: 'Istanbul', approxCur: null });
  });

  it('goalChange: solo lo que cambia; el plan, siempre los tres campos juntos', () => {
    // 'turkey' tiene plan: 3,000 USD de 2026-08 a 2027-10.
    expect(goalChange(s, 'turkey', { name: ' Istanbul ' })).toEqual({ name: 'Istanbul' });
    expect(goalChange(s, 'turkey', { monthly: 2500 })).toEqual({ monthly: 2500, start: '2026-08', end: '2027-10' });
    expect(goalChange(s, 'turkey', { end: '2027-12' })).toEqual({ monthly: 3000, start: '2026-08', end: '2027-12' });
    expect(goalChange(s, 'turkey', { monthly: null, start: null, end: null })).toEqual({ monthly: null, start: null, end: null });
    expect(goalChange(s, 'turkey', { cur: 'TRY' })).toEqual({ cur: 'TRY' });
    expect(goalChange(s, 'personal', plan)).toEqual(plan);
    expect(goalChange(s, 'personal', { sort: 5 })).toEqual({ sort: 5 });
  });

  it('goalChange: un patch sin cambios da {}', () => {
    expect(goalChange(s, 'turkey', {})).toEqual({});
    expect(goalChange(s, 'turkey', { name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10', approxCur: null, sort: 2 })).toEqual({});
    expect(goalChange(s, 'personal', { monthly: null })).toEqual({});
  });

  it('goalChange: null si la meta no existe o quedaría inválida', () => {
    expect(goalChange(s, 'nope', { name: 'x' })).toBeNull();
    expect(goalChange(s, 'turkey', { name: '  ' })).toBeNull();
    expect(goalChange(s, 'turkey', { cur: 'EUR' as 'USD' })).toBeNull();
    // Quitar solo una parte del plan no vale: hay que mandar los tres en null.
    expect(goalChange(s, 'turkey', { monthly: null })).toBeNull();
    expect(goalChange(s, 'turkey', { end: null })).toBeNull();
    expect(goalChange(s, 'turkey', { end: '2026-07' })).toBeNull();
    expect(goalChange(s, 'turkey', { monthly: 0 })).toBeNull();
    // Ni ponerle solo una parte a una meta sin plan.
    expect(goalChange(s, 'personal', { monthly: 500 })).toBeNull();
    expect(goalChange(s, 'personal', { start: '2026-10', end: '2027-09' })).toBeNull();
    expect(goalChange(s, 'personal', { sort: Number.NaN })).toBeNull();
  });

  it('canRemoveGoal: solo una meta que exista y no tenga aportes', () => {
    expect(canRemoveGoal(s, 'turkey')).toBe(false);
    expect(canRemoveGoal(s, 'nope')).toBe(false);
    const withNew = reduce(s, { type: 'goal/add', row: newGoal(s, { name: 'Car' }, 'g-new')! });
    expect(canRemoveGoal(withNew, 'g-new')).toBe(true);
    const emptied = { ...s, contribs: s.contribs.filter((c) => c.goalId !== 'personal') };
    expect(canRemoveGoal(emptied, 'personal')).toBe(true);
  });
});

describe('borrar un mes', () => {
  it('removeMonth: se va el mes con todo lo suyo; los ingresos y los aportes se quedan', () => {
    const s = frozen();
    const next = removeMonth(s, '2026-09');
    expect(Object.keys(next.months).sort()).toEqual(['2026-08', OCT]);
    expect(next.months[OCT]).toBe(s.months[OCT]);
    expect(next.incomes).toBe(s.incomes);
    expect(next.contribs).toBe(s.contribs);
    expect(next.accounts).toBe(s.accounts);
  });

  it('los saldos cambian en consecuencia: dejan de contar los movimientos de ese mes', () => {
    const s = frozen();
    const next = removeMonth(s, '2026-09');
    // Septiembre: de la US account salieron 2,300 en envíos y 106 de Claude; a la DR account entraron 134,721
    // y salieron 24,555 en transacciones y 35,872.66 en fijos. El sueldo de septiembre es un ingreso: se queda.
    expect(balanceOf(next, 'us')).toBeCloseTo(13482 + 2300 + 106, 8);
    expect(balanceOf(next, 'dr')).toBeCloseTo(220641.93 - 134721 + 24555 + 35872.66, 6);
  });

  it('un mes que no existe deja el estado igual', () => {
    const s = frozen();
    expect(removeMonth(s, '2030-01')).toBe(s);
  });
});

describe('auxiliares', () => {
  it('isPatch: las ediciones de celda y los ajustes (las que se agrupan y esperan)', () => {
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
      // El registro del presupuesto no son celdas: cada movimiento sale de una vez.
      { type: 'budget/add', key: OCT, row: s.months[OCT]!.budgetLog[0]! },
      { type: 'budget/remove', key: OCT, id: 'x' },
      { type: 'budget/leftover', key: OCT, row: s.months[OCT]!.budgetLog[0]! },
      { type: 'month/reopen', key: OCT },
      { type: 'income/remove', id: 'x' },
    ];
    for (const action of direct) expect(isPatch(action), action.type).toBe(false);
  });

  it('mergePatch: gana el valor más reciente de cada campo', () => {
    expect(
      mergePatch({ type: 'tx/patch', id: 'a', patch: { desc: 'U', amount: 1 } }, { type: 'tx/patch', id: 'a', patch: { desc: 'Uber' } }),
    ).toEqual({ type: 'tx/patch', id: 'a', patch: { desc: 'Uber', amount: 1 } });
    expect(
      mergePatch({ type: 'account/patch', id: 'us', patch: { name: 'Chase' } }, { type: 'account/patch', id: 'us', patch: { opening: 5 } }),
    ).toEqual({ type: 'account/patch', id: 'us', patch: { name: 'Chase', opening: 5 } });
  });

  it('mergePatch: las partes del presupuesto se funden por cuenta, y una tasa sustituye a la anterior', () => {
    expect(
      mergePatch(
        { type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 60000 } } },
        { type: 'month/patch', key: OCT, patch: { budgets: { dr: 65000 } } },
      ),
    ).toEqual({ type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 65000 } } });
    const later: Action = { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-07' } };
    expect(mergePatch({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } }, later as never)).toBe(later);
  });

  it('mergePatch: al fundir dos partes del presupuesto queda la fecha de la más reciente', () => {
    expect(
      mergePatch(
        { type: 'month/patch', key: OCT, patch: { budgets: { us: 100 } }, date: '2026-10-07' },
        { type: 'month/patch', key: OCT, patch: { budgets: { dr: 65000 } }, date: '2026-10-08' },
      ),
    ).toEqual({ type: 'month/patch', key: OCT, patch: { budgets: { us: 100, dr: 65000 } }, date: '2026-10-08' });
  });

  it('fieldsOf: cada campo, cada cuenta del presupuesto y la tasa llevan su propio retraso', () => {
    expect(fieldsOf({ type: 'tx/patch', id: 'a', patch: { desc: 'U', amount: 1 } })).toEqual(['desc', 'amount']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: { budgets: { us: 1, dr: 2 } } })).toEqual(['budgets.us', 'budgets.dr']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: {} })).toEqual([]);
    expect(fieldsOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } })).toEqual(['rate']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: { budgets: { us: 1 } }, date: '2026-10-07' })).toEqual(['budgets.us']);
    expect(fieldsOf({ type: 'income/patch', id: 'i1', patch: { budget: true } })).toEqual(['budget']);
    expect(fieldsOf({ type: 'settings/patch', patch: {} })).toEqual([]);
  });

  it('targetOf: la misma clave para alta, edición y baja de una fila', () => {
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

  it('targetOf: una tasa se nombra por su mes, su par (en cualquiera de los dos sentidos) y su fecha', () => {
    const set = targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } });
    expect(set).toBe(`rate:${OCT}:DOP-USD:2026-10-07`);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017, date: '2026-10-07' } })).toBe(set);
    expect(targetOf({ type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD', date: '2026-10-07' })).toBe(set);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-07' } })).not.toBe(set);
    expect(targetOf({ type: 'rate/set', key: '2026-09', rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' } })).not.toBe(set);
    // Cada fecha es su propia fila: la tasa de otro día ni se funde con esta ni se descarta al quitarla.
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-08' } })).toBe(`rate:${OCT}:DOP-USD:2026-10-08`);
    expect(targetOf({ type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP', date: '2026-10-08' })).not.toBe(set);
    // Y no se confunde con el presupuesto del mes.
    expect(set).not.toBe(targetOf({ type: 'month/patch', key: OCT, patch: {} }));
  });

  it('targetOf: cada movimiento del registro del presupuesto es su propia fila, aparte de las partes del mes', () => {
    const row: BudgetEntry = { id: 'b1', date: '2026-10-09', accountId: 'dr', amount: 500, kind: 'adjust', note: '' };
    expect(targetOf({ type: 'budget/add', key: OCT, row })).toBe('budget:b1');
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b1' })).toBe('budget:b1');
    expect(targetOf({ type: 'budget/leftover', key: OCT, row: { ...row, id: 'local-lo', kind: 'leftover' } })).toBe('budget:local-lo');
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b2' })).not.toBe('budget:b1');
    // Quitar un movimiento no descarta la parte del mes que esperaba su retraso (store.ts: queue.drop por clave).
    expect(targetOf({ type: 'budget/remove', key: OCT, id: 'b1' })).not.toBe(targetOf({ type: 'month/patch', key: OCT, patch: {} }));
    expect(targetOf({ type: 'month/patch', key: OCT, patch: {}, date: '2026-10-09' })).toBe(`month:${OCT}`);
  });

  it('putMonths: reemplaza y agrega meses (respuesta de cerrar mes)', () => {
    const s = frozen();
    const closed: Month = { ...s.months[OCT]!, closed: true, closedAt: '2026-11-01T00:00:00Z' };
    const next: Month = { ...s.months[OCT]!, key: '2026-11', tx: [], transfers: [] };
    const out = putMonths(s, closed, next);
    expect(Object.keys(out.months).sort()).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(out.months[OCT]!.closed).toBe(true);
    expect(out.months['2026-08']).toBe(s.months['2026-08']);
  });
});
