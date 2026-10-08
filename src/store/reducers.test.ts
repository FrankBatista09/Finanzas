import { describe, expect, it } from 'vitest';
import { balances, monthCalc, rateFor } from '../../shared/calc';
import { f2 } from '../../shared/format';
import { seedState } from '../../shared/seed';
import type { AppState, Month } from '../../shared/types';
import {
  accountInUse,
  accountName,
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
  isPatch,
  latestKey,
  mergePatch,
  monthRate,
  newAccount,
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

  it('reabre un mes cerrado', () => {
    const s = frozen();
    const next = reduce(s, { type: 'month/reopen', key: '2026-09' });
    expect(next.months['2026-09']!.closed).toBe(false);
    expect(next.months['2026-09']!.closedAt).toBeNull();
    // Reabrir uno abierto no cambia nada.
    expect(reduce(s, { type: 'month/reopen', key: OCT })).toBe(s);
  });
});

describe('reduce · tasas del mes', () => {
  it('la tasa escrita manda sobre los envíos del mes', () => {
    const s = frozen();
    // Agosto no tiene tasa escrita: sale de sus envíos.
    expect(rateFor(s, '2026-08', 'USD', 'DOP').source).toBe('transfers');
    const next = reduce(s, { type: 'rate/set', key: '2026-08', rate: { from: 'USD', to: 'DOP', rate: 60 } });
    expect(next.months['2026-08']!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 60 }]);
    expect(monthCalc(next, '2026-08').rate).toEqual({ rate: 60, source: 'month', monthKey: '2026-08' });
    expect(next.months[OCT]).toBe(s.months[OCT]);
  });

  it('hay una sola por par: la nueva sustituye a la que hubiera, en el sentido que fuera, y en su sitio', () => {
    let s = reduce(frozen(), { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40 } });
    expect(s.months[OCT]!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76 },
      { from: 'USD', to: 'TRY', rate: 40 },
    ]);
    s = reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.0165 } });
    expect(s.months[OCT]!.rates).toEqual([
      { from: 'DOP', to: 'USD', rate: 0.0165 },
      { from: 'USD', to: 'TRY', rate: 40 },
    ]);
    expect(rateFor(s, OCT, 'USD', 'DOP').rate).toBeCloseTo(1 / 0.0165, 10);
  });

  it('escribir la misma tasa otra vez no cambia nada', () => {
    const s = frozen();
    expect(reduce(s, { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 58.76 } })).toBe(s);
    expect(reduce(s, { type: 'rate/set', key: '2030-01', rate: { from: 'USD', to: 'DOP', rate: 1 } })).toBe(s);
  });

  it('quitar la tasa escrita devuelve el par a lo que resuelva shared/calc', () => {
    const s = frozen();
    // Se quita aunque se pida en el otro sentido.
    const next = reduce(s, { type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD' });
    expect(next.months[OCT]!.rates).toEqual([]);
    expect(monthCalc(next, OCT).rate).toEqual({ rate: 58.76, source: 'transfers', monthKey: OCT });
    expect(reduce(s, { type: 'rate/remove', key: OCT, from: 'USD', to: 'TRY' })).toBe(s);
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
    const s = frozen(reduce(seedState(), { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP' }));
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
    expect(row).toEqual({ id: 'in-new', date: '2026-10-15', desc: 'Bonus', accountId: 'us', amount: 1000, cur: 'USD' });

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
    expect(row).toEqual({ id: 'g-new', name: 'Car', cur: 'DOP', monthly: 500, start: '2026-10', end: '2027-09', sort: 3 });

    let next = reduce(s, { type: 'goal/add', row });
    expect(next.goals.map((g) => g.id)).toEqual(['emergency', 'personal', 'turkey', 'g-new']);
    expect(next.contribs).toBe(s.contribs);
    expect(next.months).toBe(s.months);

    next = reduce(next, { type: 'goal/patch', id: 'g-new', patch: { name: 'New car', monthly: 600, cur: 'USD' } });
    expect(next.goals.at(-1)).toEqual({ ...row, name: 'New car', monthly: 600, cur: 'USD' });
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
      { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017 } },
      { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40 } },
      { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP' },
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
      { type: 'income/patch', id: s.incomes[0]!.id, patch: { amount: 6000 } },
      { type: 'income/remove', id: s.incomes[0]!.id },
      { type: 'contribution/add', row: newContribution(s, { goalId: 'emergency', date: '2026-10-07', amount: 1, cur: 'DOP' }, 'ct-new')! },
      { type: 'contribution/patch', id: s.contribs[0]!.id, patch: { amount: 5, cur: 'TRY' } },
      { type: 'contribution/remove', id: s.contribs[0]!.id },
      { type: 'settings/patch', patch: { language: 'tr', theme: { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' } } },
      { type: 'settings/patch', patch: { theme: null, mainCurrency: 'USD', secondCurrency: 'DOP', defaultAccountId: null } },
      { type: 'goal/add', row: newGoal(s, { name: 'Car', cur: 'TRY', monthly: 500, start: '2026-10', end: '2027-09' }, 'g-new')! },
      { type: 'goal/patch', id: 'turkey', patch: { name: 'Istanbul', monthly: null, start: null, end: null } },
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
    expect(newTransfer(s, OCT, ok, 'x')).toEqual({ id: 'x', monthKey: OCT, ...ok });
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

  it('envío sin tasa: la del mes para ese par; entre cuentas de la misma moneda, siempre 1', () => {
    const base = { date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 500 };
    expect(newTransfer(s, OCT, base, 'x')!.rate).toBe(58.76);
    expect(newTransfer(s, OCT, { ...base, fromAccountId: 'dr', toAccountId: 'us' }, 'x')!.rate).toBeCloseTo(1 / 58.76, 12);
    expect(newTransfer(s, '2026-08', base, 'x')!.rate).toBeCloseTo(rateFor(s, '2026-08', 'USD', 'DOP').rate, 12);

    const two = { ...s, accounts: [...s.accounts, newAccount(s, { name: 'PayPal', currency: 'USD' }, 'pp')!] };
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp' }, 'x')!.rate).toBe(1);
    expect(newTransfer(two, OCT, { ...base, toAccountId: 'pp', rate: 58 }, 'x')!.rate).toBe(1);
  });

  it('ingreso: fecha válida, monto > 0 y una cuenta que exista; no pertenece a un mes', () => {
    const ok = { date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD' as const };
    expect(newIncome(s, ok, 'x')).toEqual({ id: 'x', ...ok });
    expect(newIncome(s, { ...ok, desc: undefined }, 'x')!.desc).toBe('');
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
      { type: 'fixed/patch', id: s.months[OCT]!.fixed[0]!.id, patch: { accountId: 'spare' } },
      { type: 'tx/patch', id: s.months['2026-09']!.tx[0]!.id, patch: { accountId: 'spare' } },
      { type: 'transfer/patch', id: s.months[OCT]!.transfers[0]!.id, patch: { toAccountId: 'spare' } },
      { type: 'transfer/patch', id: s.months[OCT]!.transfers[0]!.id, patch: { fromAccountId: 'spare' } },
      { type: 'income/patch', id: s.incomes[0]!.id, patch: { accountId: 'spare' } },
    ];
    for (const use of uses) expect(canRemoveAccount(reduce(spare, use), 'spare'), use.type).toBe(false);
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

    expect(monthRate(s, OCT, 'USD', 'TRY', 40)).toEqual({ from: 'USD', to: 'TRY', rate: 40 });
    expect(monthRate(s, OCT, 'USD', 'USD', 1)).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', 0)).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'TRY', -3)).toBeNull();
    expect(monthRate(s, OCT, 'USD', 'EUR' as 'TRY', 1.1)).toBeNull();
    expect(monthRate(s, '2026-09', 'USD', 'TRY', 40)).toBeNull();
  });

  it('typedRate: la tasa escrita del par, en el sentido en que se guardó', () => {
    expect(typedRate(s, OCT, 'USD', 'DOP')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76 });
    expect(typedRate(s, OCT, 'DOP', 'USD')).toEqual({ from: 'USD', to: 'DOP', rate: 58.76 });
    expect(typedRate(s, OCT, 'USD', 'TRY')).toBeNull();
    expect(typedRate(s, '2026-08', 'USD', 'DOP')).toBeNull();
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
    expect(newGoal(s, { name: 'Car' }, 'x')).toEqual({ id: 'x', name: 'Car', cur: 'DOP', monthly: null, start: null, end: null, sort: 3 });
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
    expect(goalChange(s, 'turkey', { name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10', sort: 2 })).toEqual({});
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
      { type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 1 } },
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
      { type: 'rate/remove', key: OCT, from: 'USD', to: 'DOP' },
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
    const later: Action = { type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017 } };
    expect(mergePatch({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59 } }, later as never)).toBe(later);
  });

  it('fieldsOf: cada campo, cada cuenta del presupuesto y la tasa llevan su propio retraso', () => {
    expect(fieldsOf({ type: 'tx/patch', id: 'a', patch: { desc: 'U', amount: 1 } })).toEqual(['desc', 'amount']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: { budgets: { us: 1, dr: 2 } } })).toEqual(['budgets.us', 'budgets.dr']);
    expect(fieldsOf({ type: 'month/patch', key: OCT, patch: {} })).toEqual([]);
    expect(fieldsOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59 } })).toEqual(['rate']);
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

  it('targetOf: una tasa se nombra por su mes y su par, en cualquiera de los dos sentidos', () => {
    const set = targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'DOP', rate: 59 } });
    expect(set).toBe(`rate:${OCT}:DOP-USD`);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'DOP', to: 'USD', rate: 0.017 } })).toBe(set);
    expect(targetOf({ type: 'rate/remove', key: OCT, from: 'DOP', to: 'USD' })).toBe(set);
    expect(targetOf({ type: 'rate/set', key: OCT, rate: { from: 'USD', to: 'TRY', rate: 40 } })).not.toBe(set);
    expect(targetOf({ type: 'rate/set', key: '2026-09', rate: { from: 'USD', to: 'DOP', rate: 59 } })).not.toBe(set);
    // Y no se confunde con el presupuesto del mes.
    expect(set).not.toBe(targetOf({ type: 'month/patch', key: OCT, patch: {} }));
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
