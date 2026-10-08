// Lo que el panel del presupuesto y el diálogo de cierre deciden enseñar y mandar: el sobrante del mes anterior, la
// historia del presupuesto y las partes con las que arranca el mes siguiente. Sin React: los números salen de
// shared/calc.ts con los datos de ejemplo (ago y sep cerrados, oct abierto con 65,000 + 5,000 de presupuesto).
//
// shared/calc.ts memoriza las tasas por objeto de estado: cada prueba arma el suyo y no lo toca después de calcular.

import { describe, expect, it } from 'vitest';
import { leftoverFor, monthCalc } from '../../shared/calc';
import type { Leftover } from '../../shared/calc';
import { f2 } from '../../shared/format';
import { seedState, setBudgets } from '../../shared/seed';
import type { AppState, BudgetEntry, Income } from '../../shared/types';
import { createI18n } from '../i18n';
import { BUDGET_KIND, budgetHistoryRows, closeBudgetForm, closeFieldInvalid, closeRequest, leftoverView } from './budgetModel';
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

/** Los datos de ejemplo con lo que `change` les haga, antes de calcular nada. */
function stateWith(change: (state: AppState) => void): AppState {
  const state = seedState();
  change(state);
  return state;
}

describe('leftoverView: la línea "Leftover from last month"', () => {
  it('sin mes anterior no se enseña nada', () => {
    const state = seedState();
    expect(leftoverFor(state, '2026-08')).toEqual({ previousKey: null, leftover: null, added: false });
    expect(leftoverView(leftoverFor(state, '2026-08'), false)).toBeNull();
    expect(leftoverView(leftoverFor(state, '2026-08'), true)).toBeNull();
  });

  it('offer: mes abierto, sobró algo y aún no se sumó', () => {
    const state = seedState();
    const view = leftoverView(leftoverFor(state, '2026-10'), false);
    // Septiembre: 70,000 de presupuesto − 66,636.54 usados.
    expect(view).toEqual({ amount: monthCalc(state, '2026-09').avail, from: '2026-09', status: 'offer' });
    expect(f2(view!.amount)).toBe('3,363.46');
  });

  it('offer también con un sobrante negativo: el mes anterior se pasó y se puede restar', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-09']!, { dr: 60000 }));
    const view = leftoverView(leftoverFor(state, '2026-10'), false);
    expect(view).toMatchObject({ from: '2026-09', status: 'offer' });
    expect(f2(view!.amount)).toBe('-6,636.54');
  });

  it('added: el mes ya tiene su movimiento de sobrante', () => {
    const state = stateWith((s) => s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' })));
    const leftover = leftoverFor(state, '2026-10');
    expect(leftover.added).toBe(true);
    expect(leftoverView(leftover, false)).toMatchObject({ from: '2026-09', status: 'added' });
    // Sumado se queda aunque el mes se cierre después.
    expect(leftoverView(leftover, true)!.status).toBe('added');
  });

  it('plain: en un mes cerrado, solo la cifra', () => {
    const state = seedState();
    // Septiembre (cerrado) enseña lo que sobró de agosto, sin botón.
    const view = leftoverView(leftoverFor(state, '2026-09'), true);
    expect(view).toEqual({ amount: monthCalc(state, '2026-08').avail, from: '2026-08', status: 'plain' });
  });

  it('plain: si sobró 0 (o algo que con dos decimales es 0.00) no hay nada que sumar', () => {
    const of = (leftover: number): Leftover => ({ previousKey: '2026-09', leftover, added: false });
    expect(leftoverView(of(0), false)!.status).toBe('plain');
    expect(leftoverView(of(0.004), false)!.status).toBe('plain');
    expect(leftoverView(of(-0.004), false)!.status).toBe('plain');
    // Un centavo ya es algo.
    expect(leftoverView(of(0.01), false)!.status).toBe('offer');
    expect(leftoverView(of(-0.01), false)!.status).toBe('offer');
  });

  it('el mes anterior es el registrado más cercano, aunque no sea el del calendario', () => {
    const state = stateWith((s) => delete s.months['2026-09']);
    expect(leftoverView(leftoverFor(state, '2026-10'), false)).toMatchObject({ from: '2026-08', status: 'offer' });
  });
});

describe('budgetHistoryRows: la historia del presupuesto', () => {
  it('datos de ejemplo: el inicial y el ajuste de octubre, con el total acumulado', () => {
    const state = seedState();
    expect(budgetHistoryRows(state, '2026-10')).toEqual([
      {
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
        id: 'seed-bg-2026-10-2',
        date: '2026-10-05',
        kind: 'adjust',
        kindKey: 'budgetKindAdjust',
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

  it('cada clase de movimiento tiene su texto, y son los cuatro del diccionario', () => {
    expect(BUDGET_KIND).toEqual({
      initial: 'budgetKindInitial',
      adjust: 'budgetKindAdjust',
      leftover: 'budgetKindLeftover',
      income: 'budgetKindIncome',
    });
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', amount: 3363.46, kind: 'leftover' }));
      s.incomes.push(income({ id: 'in-b', amount: 1000, date: '2026-10-09' }));
    });
    const rows = budgetHistoryRows(state, '2026-10');
    expect(rows.map((r) => [r.kind, r.kindKey])).toEqual([
      ['initial', 'budgetKindInitial'],
      ['adjust', 'budgetKindAdjust'],
      ['leftover', 'budgetKindLeftover'],
      ['income', 'budgetKindIncome'],
    ]);
    const { t } = createI18n('es');
    expect(rows.map((r) => t(r.kindKey))).toEqual(['Inicial', 'Ajuste', 'Sobrante', 'Ingreso']);
  });

  it('los importes van en la moneda de su cuenta; el total, en la principal, y el de la última fila es el presupuesto del mes', () => {
    const state = stateWith((s) => {
      const month = s.months['2026-10']!;
      month.rates = [
        { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
        { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
      ];
      // Una parte en dólares, de la US account.
      month.budgetLog.push(entry({ id: 'bg-us', accountId: 'us', amount: 200, kind: 'initial', date: '2026-10-02' }));
      // Un ingreso en dólares que entra a la DR account: sube su parte en pesos, a la tasa de su fecha (58).
      s.incomes.push(income({ id: 'in-usd', amount: 100, cur: 'USD', date: '2026-10-03', desc: 'Freelance' }));
      // Y otro en pesos que entra a la US account, ya con la tasa nueva (60).
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
    // Lo que está en dólares suma al total con la última tasa del mes (60): 200 USD = 12,000 y 50 USD = 3,000.
    expect(rows.map((r) => r.total)).toEqual(['65,000.00', '77,000.00', '82,800.00', '87,800.00', '90,800.00']);
    expect(rows.at(-1)!.total).toBe(f2(monthCalc(state, '2026-10').budget));
  });

  it('el total de la última fila es el presupuesto del mes, también en los meses de ejemplo y con otra moneda principal', () => {
    for (const key of ['2026-08', '2026-09', '2026-10']) {
      const state = seedState();
      expect(budgetHistoryRows(state, key).at(-1)!.total, key).toBe(f2(monthCalc(state, key).budget));
    }
    const usd = stateWith((s) => {
      s.mainCurrency = 'USD';
      s.secondCurrency = 'DOP';
    });
    const rows = budgetHistoryRows(usd, '2026-10');
    // Los importes siguen en pesos (la cuenta); el total, en dólares: 70,000 / 58.76.
    expect(rows.map((r) => `${r.amount} ${r.currency}`)).toEqual(['65,000.00 DOP', '5,000.00 DOP']);
    expect(rows.at(-1)!.total).toBe('1,191.29');
    expect(rows.at(-1)!.total).toBe(f2(monthCalc(usd, '2026-10').budget));
  });

  it('un movimiento que resta va con su signo y marcado como negativo', () => {
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

  it('con la misma fecha van primero los movimientos del registro, en su orden, y después los ingresos', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-first', amount: 1000, date: '2026-10-01' }));
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-same', amount: 10, kind: 'adjust', date: '2026-10-01' }));
    });
    expect(budgetHistoryRows(state, '2026-10').map((r) => r.id)).toEqual(['seed-bg-2026-10-1', 'bg-same', 'in-first', 'seed-bg-2026-10-2']);
  });

  it('se quita con × un movimiento del registro de un mes abierto; un ingreso, nunca (se quita o se desmarca como ingreso)', () => {
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

  it('un movimiento recién añadido, aún sin id del servidor (local-…), no se puede quitar todavía', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(
        entry({ id: 'local-1', amount: 500, kind: 'adjust' }),
        // Solo cuenta el prefijo: un id del servidor que lleve "local" en medio sí se quita.
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

  it('en un mes cerrado no se quita nada', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-sep', amount: 1000, date: '2026-09-10' }));
    });
    const rows = budgetHistoryRows(state, '2026-09');
    expect(rows.map((r) => [r.kind, r.amount, r.deletable])).toEqual([
      ['initial', '70,000.00', false],
      ['income', '1,000.00', false],
    ]);
    // El mismo mes, reabierto: el del registro vuelve a poder quitarse.
    const reopened = stateWith((s) => {
      s.months['2026-09']!.closed = false;
    });
    expect(budgetHistoryRows(reopened, '2026-09').map((r) => r.deletable)).toEqual([true]);
  });

  it('un ingreso sin la casilla, o de otro mes, no es parte de la historia', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-plain', amount: 1000, budget: false }), income({ id: 'in-nov', amount: 1000, date: '2026-11-02' }));
    });
    // Los sueldos de ejemplo tampoco suben el presupuesto.
    expect(budgetHistoryRows(state, '2026-10').map((r) => r.kind)).toEqual(['initial', 'adjust']);
  });

  it('un mes sin registro, o que no existe, da una lista vacía', () => {
    const empty = stateWith((s) => setBudgets(s.months['2026-10']!, {}));
    expect(budgetHistoryRows(empty, '2026-10')).toEqual([]);
    expect(budgetHistoryRows(seedState(), '2027-01')).toEqual([]);
  });
});

describe('closeBudgetForm: lo que pregunta el diálogo de cierre', () => {
  it('octubre (noviembre aún no existe): un campo por cuenta con parte, con la de este mes, y el sobrante', () => {
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

  it('si el mes siguiente ya existe no se pregunta nada: el cierre no lo toca', () => {
    expect(closeBudgetForm(seedState(), '2026-09')).toEqual({ next: '2026-10', nextExists: true, fields: [], leftover: null });
    expect(closeBudgetForm(seedState(), '2026-08')).toMatchObject({ next: '2026-09', nextExists: true });
  });

  it('un mes que no existe: sin campos y sin sobrante', () => {
    expect(closeBudgetForm(seedState(), '2027-03')).toEqual({ next: '2027-04', nextExists: false, fields: [], leftover: null });
  });

  it('varias cuentas con parte: un campo por cada una, en el orden de las cuentas y en su moneda', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: 58248, us: 200 }));
    expect(closeBudgetForm(state, '2026-10').fields).toEqual([
      { accountId: 'us', name: 'US account', currency: 'USD', amount: '200', exact: 200 },
      { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '58248', exact: 58248 },
    ]);
  });

  it('los ingresos que subieron el presupuesto no se heredan: el campo trae solo lo del registro', () => {
    const state = stateWith((s) => {
      s.incomes.push(income({ id: 'in-dr', amount: 4000 }), income({ id: 'in-us', amount: 50, cur: 'USD', accountId: 'us' }));
    });
    const calc = monthCalc(state, '2026-10');
    expect(calc.budgetParts.map((p) => [p.account.id, p.amount, p.fromLog, p.fromIncomes])).toEqual([
      ['us', 50, 0, 50],
      ['dr', 74000, 70000, 4000],
    ]);
    // La US account solo tiene lo del ingreso: sin campo. La DR account, sus 70,000 del registro.
    expect(closeBudgetForm(state, '2026-10').fields).toEqual([{ accountId: 'dr', name: 'DR account', currency: 'DOP', amount: '70000', exact: 70000 }]);
  });

  it('el campo enseña dos decimales y guarda la parte exacta', () => {
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

  it('una parte en negativo (un sobrante negativo sin nada más) arranca en 0', () => {
    const state = stateWith((s) => {
      s.months['2026-10']!.budgetLog.push(entry({ id: 'bg-left', accountId: 'us', amount: -120, kind: 'leftover' }));
    });
    expect(closeBudgetForm(state, '2026-10').fields[0]).toMatchObject({ accountId: 'us', amount: '0', exact: 0 });
  });

  it('una cuenta oculta que aún tiene parte también lleva campo', () => {
    const state = stateWith((s) => {
      setBudgets(s.months['2026-10']!, { dr: 58248, us: 200 });
      s.accounts.find((a) => a.id === 'us')!.hidden = true;
    });
    expect(closeBudgetForm(state, '2026-10').fields.map((f) => f.accountId)).toEqual(['us', 'dr']);
  });

  it('si no sobra nada no hay nada que ofrecer; si el mes se pasó, el sobrante es negativo', () => {
    const used = monthCalc(seedState(), '2026-10').used;
    const exact = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: used }));
    expect(closeBudgetForm(exact, '2026-10').leftover).toBeNull();
    const cents = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: used + 0.004 }));
    expect(closeBudgetForm(cents, '2026-10').leftover).toBeNull();
    const over = stateWith((s) => setBudgets(s.months['2026-10']!, { dr: 40000 }));
    expect(f2(closeBudgetForm(over, '2026-10').leftover!)).toBe('-9,149.71');
  });

  it('sin registro del presupuesto: sin campos, pero el sobrante (negativo) se sigue ofreciendo', () => {
    const state = stateWith((s) => setBudgets(s.months['2026-10']!, {}));
    const form = closeBudgetForm(state, '2026-10');
    expect(form.fields).toEqual([]);
    expect(f2(form.leftover!)).toBe('-49,149.71');
  });
});

describe('closeFieldInvalid', () => {
  it('vacío cuenta como 0; un número >= 0 vale', () => {
    for (const text of ['', '   ', '0', '0.00', '70000', '1234.56', ' 50 ', '1e3']) expect(closeFieldInvalid(text), `"${text}"`).toBe(false);
  });

  it('un negativo o algo que no es un número, no', () => {
    for (const text of ['-1', '-0.01', 'abc', '1,5', '12x', 'Infinity', 'NaN']) expect(closeFieldInvalid(text), `"${text}"`).toBe(true);
  });
});

describe('closeRequest: lo que se manda al cerrar', () => {
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

  it('sin tocar nada: las partes de este mes y el sobrante sin sumar', () => {
    const f = closeBudgetForm(seedState(), '2026-10');
    expect(closeRequest(f, f.fields, false)).toEqual({ budgets: { dr: 70000 }, addLeftover: false });
  });

  it('con la casilla marcada se suma el sobrante', () => {
    const f = closeBudgetForm(seedState(), '2026-10');
    expect(closeRequest(f, f.fields, true)).toEqual({ budgets: { dr: 70000 }, addLeftover: true });
  });

  it('la casilla no cuenta si no había sobrante que ofrecer', () => {
    const f = form({ leftover: null });
    expect(closeRequest(f, f.fields, true)).toEqual({ budgets: { dr: 70000 }, addLeftover: false });
  });

  it('un campo sin tocar manda la parte exacta, no la redondeada que enseña', () => {
    const us = field({ accountId: 'us', currency: 'USD', amount: '57.24', exact: 57.244044 });
    expect(closeRequest(form({ fields: [us] }), [us], false)).toEqual({ budgets: { us: 57.244044 }, addLeftover: false });
  });

  it('un campo editado manda el número escrito', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    const typed = [
      { ...f.fields[0]!, amount: '65000.5' },
      { ...f.fields[1]!, amount: '57.2' },
    ];
    expect(closeRequest(f, typed, false)).toEqual({ budgets: { dr: 65000.5, us: 57.2 }, addLeftover: false });
  });

  it('vacío o en 0 deja a esa cuenta sin parte: se manda 0, no se omite', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    const typed = [
      { ...f.fields[0]!, amount: '' },
      { ...f.fields[1]!, amount: '0' },
    ];
    expect(closeRequest(f, typed, true)).toEqual({ budgets: { dr: 0, us: 0 }, addLeftover: true });
    expect(closeRequest(f, [{ ...f.fields[0]!, amount: '  ' }, f.fields[1]!], false)).toEqual({ budgets: { dr: 0, us: 200 }, addLeftover: false });
  });

  it('sin cuentas con parte se manda un reparto vacío', () => {
    expect(closeRequest(form({ fields: [] }), [], true)).toEqual({ budgets: {}, addLeftover: true });
  });

  it('si el mes siguiente ya existe no se manda nada (undefined): el servidor no lo tocaría', () => {
    const f = closeBudgetForm(seedState(), '2026-09');
    expect(closeRequest(f, f.fields, false)).toBeUndefined();
    expect(closeRequest(f, f.fields, true)).toBeUndefined();
    // Aunque quedaran campos, o alguno no valiera.
    expect(closeRequest(form({ nextExists: true }), [field({ amount: '-5' })], true)).toBeUndefined();
  });

  it('si algún campo no vale, null: no se puede cerrar hasta corregirlo', () => {
    const f = form({ fields: [field(), field({ accountId: 'us', currency: 'USD', amount: '200', exact: 200 })] });
    expect(closeRequest(f, [f.fields[0]!, { ...f.fields[1]!, amount: '-5' }], false)).toBeNull();
    expect(closeRequest(f, [{ ...f.fields[0]!, amount: 'abc' }, f.fields[1]!], true)).toBeNull();
  });
});
