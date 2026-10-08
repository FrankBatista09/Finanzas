// El presupuesto como registro con fecha, el sobrante del mes anterior, el cierre con cuerpo, los ingresos que
// suben el presupuesto y la moneda "≈" de las metas: por la API (lo que usa la web) y por el repositorio (donde
// hace falta fijar el reloj). Las cifras están calculadas a mano sobre los datos de ejemplo (shared/seed.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloseResponse, StateResponse } from '../shared/api';
import { budgetHistory, goalsProgress, leftoverFor, monthCalc } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { AppState, Goal, Income, Month } from '../shared/types';
import { addBudgetEntry, addLeftover, closeMonth, createIncome, deleteBudgetEntry, ensureMonth, getMonth, loadState, replaceAll, reopenMonth, updateSettings } from './db';
import { client, count, EDA, FRANK, makeEnv } from './test-util';
import type { Client } from './test-util';

const F = FRANK.id;
const E = EDA.id;

/** "Hoy" de todas las pruebas: 8 de octubre de 2026 en Santo Domingo. */
const TODAY = new Date('2026-10-08T15:00:00.000Z');

// Septiembre: presupuesto 70,000; usado = fijos en DOP 35,872.66 + Claude 106 USD × (134,721 ÷ 2,300) + transacciones 24,555.
const SEP_LEFT = 70000 - (35872.66 + (106 * 134721) / 2300 + 24555);
// Octubre: 70,000 − 49,149.71 usados.
const OCT_LEFT = 20850.29;

const closed = { code: 'month_closed', message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' };

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

const stateOf = async (api: Client): Promise<AppState> => (await api.get<StateResponse>('/api/state')).body.state;
const log = (m: Month) => m.budgetLog.map((e) => [e.date, e.accountId, e.amount, e.kind, e.note]);

beforeEach(() => {
  // Solo el reloj: las fechas que pone el servidor salen de "hoy".
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/months/:key/budget-log', () => {
  it('añade un movimiento a la parte de una cuenta: por defecto un ajuste con fecha de hoy', async () => {
    const { api, sqlite } = await seeded();
    const r = await api.post<Month>('/api/months/2026-10/budget-log', { accountId: 'dr', amount: 2500, note: '  Bonus ' });
    expect(r.status).toBe(201);
    expect(r.body.key).toBe('2026-10');
    expect(log(r.body)).toEqual([
      ['2026-10-01', 'dr', 65000, 'initial', ''],
      ['2026-10-05', 'dr', 5000, 'adjust', 'Car repair'],
      ['2026-10-08', 'dr', 2500, 'adjust', 'Bonus'],
    ]);
    expect(r.body.budgetLog.at(-1)!.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(r.body.budgets).toEqual({ dr: 72500 });
    expect(count(sqlite, 'month_budget_log', F)).toBe(5);

    // Con todo dicho: id, fecha, tipo. Y en negativo, en otra cuenta (en su moneda).
    const cut = await api.post<Month>('/api/months/2026-10/budget-log', { id: 'cut-1', date: '2026-10-03', accountId: 'us', amount: -50, kind: 'initial' });
    expect(cut.status).toBe(201);
    // Se leen por fecha: el del día 3 queda entre los de ejemplo.
    expect(log(cut.body)[1]).toEqual(['2026-10-03', 'us', -50, 'initial', '']);
    expect(cut.body.budgets).toEqual({ dr: 72500, us: -50 });
    // 72,500 DOP − 50 USD × 58.76.
    const c = monthCalc(await stateOf(api), '2026-10');
    expect(c.budget).toBeCloseTo(72500 - 2938, 8);
    expect(c.avail).toBeCloseTo(72500 - 2938 - 49149.71, 6);
    expect(budgetHistory(await stateOf(api), '2026-10').map((h) => [h.date, h.kind, h.total])).toEqual([
      ['2026-10-01', 'initial', 65000],
      ['2026-10-03', 'initial', 65000 - 2938],
      ['2026-10-05', 'adjust', 70000 - 2938],
      ['2026-10-08', 'adjust', 72500 - 2938],
    ]);
  });

  it('valida el cuerpo, la fecha dentro del mes y la cuenta; el id repetido es un 409', async () => {
    const { api, eda, db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    const bad: [unknown, string][] = [
      [{ accountId: 'dr', amount: 0 }, 'Invalid data: amount: cannot be 0'],
      [{ accountId: 'dr' }, 'Invalid data: amount: is required'],
      [{ amount: 5 }, 'Invalid data: accountId: is required'],
      [{ accountId: 'dr', amount: 5, kind: 'leftover' }, 'Invalid data: kind: must be initial or adjust'],
      [{ accountId: 'dr', amount: 5, date: '2026-09-30' }, 'Invalid data: date: must be a date in 2026-10'],
      [{ accountId: 'dr', amount: 5, date: '2026-11-01' }, 'Invalid data: date: must be a date in 2026-10'],
      [{ accountId: 'dr', amount: 5, date: '2026-10-32' }, 'Invalid data: date: is not a valid date (YYYY-MM-DD)'],
      [{ accountId: 'nope', amount: 5 }, 'Unknown account "nope".'],
    ];
    for (const [body, message] of bad) {
      const r = await api.post('/api/months/2026-10/budget-log', body);
      expect([r.status, r.error], JSON.stringify(body)).toEqual([400, { code: 'validation', message }]);
    }
    // La cuenta de otro usuario es como una que no existe.
    await eda.post('/api/accounts', { id: 'wise', name: 'Wise', currency: 'USD' });
    expect((await api.post('/api/months/2026-10/budget-log', { accountId: 'wise', amount: 5 })).error).toEqual({ code: 'validation', message: 'Unknown account "wise".' });
    expect(await getMonth(db, F, '2026-10')).toEqual(before);

    expect((await api.post('/api/months/2026-10/budget-log', { id: 'seed-bg-2026-10-1', accountId: 'dr', amount: 5 })).error).toEqual({
      code: 'conflict',
      message: 'A record with that id already exists.',
    });
    expect((await api.post('/api/months/2031-01/budget-log', { accountId: 'dr', amount: 5 })).error).toEqual({ code: 'not_found', message: 'Month 2031-01 does not exist.' });
    expect((await api.post('/api/months/2026-08/budget-log', { accountId: 'dr', amount: 5 })).error).toEqual(closed);
    expect(await getMonth(db, F, '2026-10')).toEqual(before);
  });

  it('en un mes que no es el de hoy, la fecha por defecto se lleva al mes', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    await ensureMonth(db, F, '2026-12');
    expect(log(await addBudgetEntry(db, F, '2026-08', { accountId: 'dr', amount: 1 }, TODAY)).at(-1)).toEqual(['2026-08-31', 'dr', 1, 'adjust', '']);
    expect(log(await addBudgetEntry(db, F, '2026-12', { accountId: 'dr', amount: 1 }, TODAY)).at(-1)).toEqual(['2026-12-01', 'dr', 1, 'adjust', '']);
  });
});

describe('DELETE /api/months/:key/budget-log/:id', () => {
  it('quita ese movimiento y el presupuesto baja con él', async () => {
    const { api } = await seeded();
    const r = await api.del<Month>('/api/months/2026-10/budget-log/seed-bg-2026-10-2');
    expect(r.status).toBe(200);
    expect(log(r.body)).toEqual([['2026-10-01', 'dr', 65000, 'initial', '']]);
    expect(r.body.budgets).toEqual({ dr: 65000 });
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBe(65000);
    // Ya no está: 404.
    expect((await api.del('/api/months/2026-10/budget-log/seed-bg-2026-10-2')).error).toEqual({ code: 'not_found', message: 'Budget entry not found.' });
  });

  it('404 si el movimiento no es de ese mes; 409 si el mes está cerrado', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    // Existe, pero en septiembre.
    expect((await api.del('/api/months/2026-10/budget-log/seed-bg-2026-09-1')).status).toBe(404);
    expect((await api.del('/api/months/2026-10/budget-log/nope')).status).toBe(404);
    expect((await api.del('/api/months/2031-01/budget-log/seed-bg-2026-10-1')).error?.message).toBe('Month 2031-01 does not exist.');
    expect((await api.del('/api/months/2026-08/budget-log/seed-bg-2026-08-1')).error).toEqual(closed);
    expect(await loadState(db, F)).toEqual(before);
  });
});

describe('POST /api/months/:key/leftover', () => {
  it('suma al mes lo que sobró del anterior, una sola vez, en la cuenta por defecto', async () => {
    const { api, db } = await seeded();
    expect(leftoverFor(await stateOf(api), '2026-10')).toMatchObject({ previousKey: '2026-09', added: false });

    const r = await api.post<Month>('/api/months/2026-10/leftover');
    expect(r.status).toBe(201);
    const entry = r.body.budgetLog.at(-1)!;
    expect(entry).toMatchObject({ date: '2026-10-08', accountId: 'dr', kind: 'leftover', note: '' });
    expect(entry.amount).toBeCloseTo(SEP_LEFT, 6);
    expect(entry.amount).toBeCloseTo(3363.46, 2);
    expect(r.body.budgets.dr).toBeCloseTo(70000 + SEP_LEFT, 6);

    const state = await stateOf(api);
    expect(monthCalc(state, '2026-10').budget).toBeCloseTo(70000 + SEP_LEFT, 6);
    expect(monthCalc(state, '2026-10').avail).toBeCloseTo(OCT_LEFT + SEP_LEFT, 6);
    expect(leftoverFor(state, '2026-10').added).toBe(true);
    expect(budgetHistory(state, '2026-10').map((h) => h.kind)).toEqual(['initial', 'adjust', 'leftover']);

    // Otra vez: 409, y no se suma dos veces.
    const again = await api.post('/api/months/2026-10/leftover');
    expect([again.status, again.error]).toEqual([409, { code: 'conflict', message: 'The leftover of the previous month was already added to 2026-10.' }]);
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(3);

    // Quitar ese movimiento permite volver a sumarlo.
    expect((await api.del(`/api/months/2026-10/budget-log/${entry.id}`)).status).toBe(200);
    expect(leftoverFor(await stateOf(api), '2026-10').added).toBe(false);
    expect((await api.post('/api/months/2026-10/leftover')).status).toBe(201);
  });

  it('400 si no hay mes anterior; 404 si el mes no existe; 409 si está cerrado', async () => {
    const { api, db } = await seeded();
    expect((await api.post('/api/months/2026-08/leftover')).error).toEqual(closed);
    await reopenMonth(db, F, '2026-08');
    const first = await api.post('/api/months/2026-08/leftover');
    expect([first.status, first.error]).toEqual([400, { code: 'validation', message: 'There is no month before 2026-08 to take a leftover from.' }]);
    expect((await api.post('/api/months/2031-01/leftover')).error).toEqual({ code: 'not_found', message: 'Month 2031-01 does not exist.' });
    expect((await getMonth(db, F, '2026-08'))!.budgetLog).toHaveLength(1);
  });

  it('un sobrante negativo entra en negativo: lo que se gastó de más se le resta a este mes', async () => {
    const { api, db } = await seeded();
    // Septiembre con 60,000 de presupuesto: se pasó en 6,636.54.
    await reopenMonth(db, F, '2026-09');
    await api.patch('/api/months/2026-09', { budgets: { dr: 60000 } });
    const r = await api.post<Month>('/api/months/2026-10/leftover');
    expect(r.status).toBe(201);
    expect(r.body.budgetLog.at(-1)!.amount).toBeCloseTo(SEP_LEFT - 10000, 6);
    expect(r.body.budgetLog.at(-1)!.amount).toBeCloseTo(-6636.54, 2);
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(60000 + SEP_LEFT, 6);
  });

  it('con la cuenta por defecto en otra moneda, entra convertido con la tasa del mes', async () => {
    const { api, db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    const r = await api.post<Month>('/api/months/2026-10/leftover');
    const entry = r.body.budgetLog.at(-1)!;
    // 3,363.46 DOP ÷ 58.76 = 57.24 USD, en la US account.
    expect(entry).toMatchObject({ accountId: 'us', kind: 'leftover' });
    expect(entry.amount).toBeCloseTo(SEP_LEFT / 58.76, 8);
    expect(entry.amount).toBeCloseTo(57.24, 2);
    // En la moneda principal es el mismo sobrante.
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(70000 + SEP_LEFT, 6);
  });

  it('la fecha del movimiento se lleva al mes cuando hoy cae fuera', async () => {
    const { db } = await seeded();
    await ensureMonth(db, F, '2026-12');
    // El mes anterior registrado a diciembre es octubre.
    const month = await addLeftover(db, F, '2026-12', TODAY);
    expect(month.budgetLog.at(-1)).toMatchObject({ date: '2026-12-01', kind: 'leftover', accountId: 'dr' });
    expect(month.budgetLog.at(-1)!.amount).toBeCloseTo(OCT_LEFT, 6);
  });
});

describe('POST /api/months/:key/close con cuerpo', () => {
  it('sin cuerpo: el mes siguiente arranca con las partes del registro, sin los ingresos que subieron el presupuesto', async () => {
    const { api, db } = await seeded();
    await createIncome(db, F, { id: 'bonus', date: '2026-10-04', accountId: 'dr', amount: 3000, cur: 'DOP', budget: true });
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(73000);
    const r = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(r.status).toBe(200);
    expect(log(r.body.next)).toEqual([['2026-11-01', 'dr', 70000, 'initial', '']]);
    expect(r.body.next.budgets).toEqual({ dr: 70000 });
    expect(leftoverFor(await stateOf(api), '2026-11')).toMatchObject({ previousKey: '2026-10', added: false });
    // Un cuerpo vacío es lo mismo.
    const other = await seeded();
    expect(log((await other.api.post<CloseResponse>('/api/months/2026-10/close', {})).body.next)).toEqual([['2026-11-01', 'dr', 70000, 'initial', '']]);
  });

  it('`budgets` da las partes iniciales del mes siguiente; un 0 no deja movimiento', async () => {
    const { api } = await seeded();
    const r = await api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 80000, us: 100 } });
    expect(r.status).toBe(200);
    expect(r.body.closed.closed).toBe(true);
    // El mes que se cierra conserva su registro.
    expect(r.body.closed.budgets).toEqual({ dr: 70000 });
    expect(log(r.body.next)).toEqual([
      ['2026-11-01', 'dr', 80000, 'initial', ''],
      ['2026-11-01', 'us', 100, 'initial', ''],
    ]);
    expect(r.body.next.budgets).toEqual({ dr: 80000, us: 100 });
    expect(r.body.next.fixed).toHaveLength(11);
    // 80,000 DOP + 100 USD a la última tasa escrita (58.76).
    expect(monthCalc(await stateOf(api), '2026-11').budget).toBeCloseTo(80000 + 5876, 8);

    const none = await seeded();
    const empty = await none.api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 0 } });
    expect(empty.body.next.budgetLog).toEqual([]);
    expect(empty.body.next.budgets).toEqual({});
  });

  it('`addLeftover` suma además lo que sobró del mes que se cierra', async () => {
    const { api } = await seeded();
    const r = await api.post<CloseResponse>('/api/months/2026-10/close', { addLeftover: true });
    const next = r.body.next;
    expect(next.budgetLog.map((e) => [e.date, e.accountId, e.kind])).toEqual([
      ['2026-11-01', 'dr', 'initial'],
      ['2026-11-01', 'dr', 'leftover'],
    ]);
    expect(next.budgetLog[0]!.amount).toBe(70000);
    expect(next.budgetLog[1]!.amount).toBeCloseTo(OCT_LEFT, 6);
    expect(next.budgets.dr).toBeCloseTo(70000 + OCT_LEFT, 6);
    const state = await stateOf(api);
    expect(leftoverFor(state, '2026-11')).toMatchObject({ previousKey: '2026-10', added: true });
    expect(leftoverFor(state, '2026-11').leftover).toBeCloseTo(OCT_LEFT, 6);
    // Ya está sumado: la ruta del sobrante responde 409.
    expect((await api.post('/api/months/2026-11/leftover')).status).toBe(409);

    // Con las dos cosas: las partes que se mandan más el sobrante.
    const both = await seeded();
    const b = await both.api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 50000 }, addLeftover: true });
    expect(b.body.next.budgets.dr).toBeCloseTo(50000 + OCT_LEFT, 6);
  });

  it('la fecha del sobrante es hoy si ya es el mes siguiente; si no, su primer día', async () => {
    const early = await seeded();
    const a = await closeMonth(early.db, F, '2026-10', { addLeftover: true }, TODAY);
    expect(a.next.budgetLog.at(-1)).toMatchObject({ kind: 'leftover', date: '2026-11-01' });
    const late = await seeded();
    const b = await closeMonth(late.db, F, '2026-10', { addLeftover: true }, new Date('2026-11-03T15:00:00.000Z'));
    expect(b.next.budgetLog.at(-1)).toMatchObject({ kind: 'leftover', date: '2026-11-03' });
    expect(b.next.budgetLog[0]).toMatchObject({ kind: 'initial', date: '2026-11-01' });
  });

  it('si el mes siguiente ya existe no se le aplica nada: ni las partes ni el sobrante', async () => {
    const { api, db } = await seeded();
    const { month: november } = await ensureMonth(db, F, '2026-11');
    expect(november.budgets).toEqual({ dr: 70000 });
    const r = await api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 1, us: 2 }, addLeftover: true });
    expect(r.status).toBe(200);
    expect(r.body.closed.closed).toBe(true);
    expect(r.body.next).toEqual(november);
    expect(leftoverFor(await stateOf(api), '2026-11').added).toBe(false);
  });

  it('un cuerpo inválido o una cuenta desconocida no cierran el mes', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const bad: unknown[] = [{ budgets: { dr: -1 } }, { budgets: 70000 }, { addLeftover: 'yes' }, { leftover: true }, [], 'x'];
    for (const body of bad) {
      const r = await api.post('/api/months/2026-10/close', body);
      expect([r.status, r.error?.code], JSON.stringify(body)).toEqual([400, 'validation']);
    }
    const notJson = await api.raw('/api/months/2026-10/close', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
    expect(notJson.status).toBe(400);
    const unknown = await api.post('/api/months/2026-10/close', { budgets: { dr: 1, nope: 2 } });
    expect([unknown.status, unknown.error]).toEqual([400, { code: 'validation', message: 'Unknown account "nope".' }]);
    expect(await loadState(db, F)).toEqual(before);
  });
});

describe('ingresos que suben el presupuesto, por la API', () => {
  it('`budget` es false si no viene; con true el presupuesto del mes de su fecha sube, y deja de subir al quitarlo', async () => {
    const { api } = await seeded();
    const plain = await api.post<Income>('/api/incomes', { date: '2026-10-07', amount: 500, cur: 'DOP' });
    expect(plain.body.budget).toBe(false);
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBe(70000);

    const r = await api.post<Income>('/api/incomes', { id: 'bonus', date: '2026-10-07', desc: 'Bonus', accountId: 'dr', amount: 2500, cur: 'DOP', budget: true });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 'bonus', date: '2026-10-07', desc: 'Bonus', accountId: 'dr', amount: 2500, cur: 'DOP', budget: true, rate: null, recurring: false });
    let state = await stateOf(api);
    expect(monthCalc(state, '2026-10').budget).toBe(72500);
    expect(monthCalc(state, '2026-10').budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ amount: 72500, fromLog: 70000, fromIncomes: 2500 });
    // No escribe nada en el registro: Month.budgets y el registro siguen igual.
    expect(state.months['2026-10']!.budgets).toEqual({ dr: 70000 });
    expect(state.months['2026-10']!.budgetLog).toHaveLength(2);
    expect(budgetHistory(state, '2026-10').at(-1)).toMatchObject({ kind: 'income', id: 'bonus', date: '2026-10-07', amount: 2500, note: 'Bonus', total: 72500 });
    // Y sigue siendo un ingreso: entra a la cuenta.
    expect(monthCalc(state, '2026-10').income).toBeCloseTo(5800 * 58.76 + 3000, 8);

    // Cambiarle la fecha a septiembre mueve la subida a septiembre.
    await api.patch('/api/incomes/bonus', { date: '2026-09-20' });
    state = await stateOf(api);
    expect([monthCalc(state, '2026-09').budget, monthCalc(state, '2026-10').budget]).toEqual([72500, 70000]);
    expect((await api.patch<Income>('/api/incomes/bonus', { budget: false })).body.budget).toBe(false);
    expect(monthCalc(await stateOf(api), '2026-09').budget).toBe(70000);
    expect((await api.patch('/api/incomes/bonus', { budget: 'yes' })).status).toBe(400);
  });

  it('en otra moneda sube lo que valía en su fecha, aunque después se escriba otra tasa', async () => {
    const { api } = await seeded();
    // 100 USD a la cuenta en DOP el día 7, a 58.76.
    await api.post('/api/incomes', { id: 'a', date: '2026-10-07', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(70000 + 5876, 8);
    // El día 8 se escribe 60 y entran otros 100 USD: esos valen 6,000; los del día 7 siguen en 5,876.
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    await api.post('/api/incomes', { id: 'b', date: '2026-10-08', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    const c = monthCalc(await stateOf(api), '2026-10');
    expect(c.budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ fromLog: 70000, fromIncomes: 11876 });
    expect(c.budget).toBeCloseTo(81876, 8);
    expect(c.budgetSecond).toBeCloseTo(81876 / 60, 8);
  });

  it('un mes cerrado no lo impide: el ingreso no es del mes', async () => {
    const { api } = await seeded();
    const r = await api.post('/api/incomes', { date: '2026-08-20', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true });
    expect(r.status).toBe(201);
    expect(monthCalc(await stateOf(api), '2026-08').budget).toBe(71000);
  });
});

describe('moneda "≈" de una meta, por la API', () => {
  it('se crea sin ella (null = la moneda principal), se cambia y se quita', async () => {
    const { api } = await seeded();
    const created = await api.post<Goal>('/api/goals', { id: 'car', name: 'Car', cur: 'USD' });
    expect(created.body).toMatchObject({ id: 'car', cur: 'USD', approxCur: null });
    const withIt = await api.post<Goal>('/api/goals', { id: 'flat', name: 'Flat', cur: 'USD', approxCur: 'TRY' });
    expect(withIt.status).toBe(201);
    expect(withIt.body.approxCur).toBe('TRY');
    expect((await api.get<Goal[]>('/api/goals')).body.map((g) => [g.id, g.approxCur])).toEqual([
      ['emergency', null],
      ['personal', null],
      ['turkey', null],
      ['car', null],
      ['flat', 'TRY'],
    ]);

    // La de la propia meta también vale; null vuelve a la principal. El resto de la meta no cambia.
    const own = await api.patch<Goal>('/api/goals/turkey', { approxCur: 'USD' });
    expect(own.body).toEqual({ ...seedState().goals.find((g) => g.id === 'turkey')!, approxCur: 'USD' });
    let turkey = goalsProgress(await stateOf(api)).find((g) => g.id === 'turkey')!;
    expect([turkey.approxCur, turkey.savedApprox]).toEqual(['USD', 9000]);
    expect((await api.patch<Goal>('/api/goals/turkey', { approxCur: null })).body.approxCur).toBeNull();
    turkey = goalsProgress(await stateOf(api)).find((g) => g.id === 'turkey')!;
    expect(turkey.approxCur).toBe('DOP');
    expect(turkey.savedApprox).toBeCloseTo(9000 * 58.76, 8);

    for (const approxCur of ['EUR', 'usd', 5]) {
      expect((await api.patch('/api/goals/turkey', { approxCur })).status, String(approxCur)).toBe(400);
      expect((await api.post('/api/goals', { name: `x-${approxCur}`, approxCur })).status, String(approxCur)).toBe(400);
    }
  });

  it('lo ahorrado se ve en esa moneda con la última tasa del mes en curso', async () => {
    const { api } = await seeded();
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-02' });
    await api.patch('/api/goals/turkey', { approxCur: 'TRY' });
    const turkey = goalsProgress(await stateOf(api)).find((g) => g.id === 'turkey')!;
    expect(turkey).toMatchObject({ cur: 'USD', saved: 9000, approxCur: 'TRY' });
    expect(turkey.savedApprox).toBeCloseTo(360000, 8);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
  });
});

describe('dos usuarios: el registro, las tasas con fecha, el sobrante y lo demás de cada uno van aparte', () => {
  it('lo que hace Frank no toca lo de Eda, aunque los ids y los meses coincidan', async () => {
    const { api, eda, db, sqlite } = await seeded();
    const before = await loadState(db, E);

    await api.post('/api/months/2026-10/budget-log', { id: 'mine', accountId: 'dr', amount: 999 });
    await api.patch('/api/months/2026-10', { budgets: { dr: 50000, us: 10 } });
    await api.del('/api/months/2026-10/budget-log/seed-bg-2026-10-1');
    await api.post('/api/months/2026-10/leftover');
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 61, date: '2026-10-08' });
    await api.del('/api/months/2026-10/rates/USD/DOP?date=2026-10-01');
    await api.post('/api/incomes', { date: '2026-10-07', amount: 100, cur: 'DOP', budget: true });
    await api.patch('/api/goals/turkey', { approxCur: 'TRY' });
    await api.post('/api/months/2026-10/close', { budgets: { dr: 1 }, addLeftover: true });

    expect(await loadState(db, E)).toEqual(before);
    expect(monthCalc(await stateOf(eda), '2026-10').budget).toBe(70000);
    expect(count(sqlite, 'months', E)).toBe(3);
    expect(count(sqlite, 'month_budget_log', E)).toBe(4);
    expect(count(sqlite, 'month_rates', E)).toBe(2);

    // Eda no ve ni puede tocar los movimientos de Frank: su id, para ella, no existe.
    expect((await eda.del('/api/months/2026-10/budget-log/mine')).status).toBe(404);
    expect((await eda.post('/api/months/2026-11/leftover')).status).toBe(404);
    // Y con un id que tienen los dos (los datos de ejemplo), cada uno borra el suyo.
    const frank = await loadState(db, F);
    expect((await eda.del('/api/months/2026-10/budget-log/seed-bg-2026-10-2')).status).toBe(200);
    expect((await eda.post('/api/months/2026-10/leftover')).status).toBe(201);
    expect(await loadState(db, F)).toEqual(frank);
    expect((await getMonth(db, E, '2026-10'))!.budgetLog.map((e) => e.kind)).toEqual(['initial', 'leftover']);
    // El sobrante de Eda es el de SU septiembre, intacto.
    expect((await getMonth(db, E, '2026-10'))!.budgetLog.at(-1)!.amount).toBeCloseTo(SEP_LEFT, 6);
  });

  it('borrar un movimiento por el repositorio con el id de otro usuario es un 404', async () => {
    const { db } = await seeded();
    await addBudgetEntry(db, F, '2026-10', { id: 'only-frank', accountId: 'dr', amount: 1 }, TODAY);
    await expect(deleteBudgetEntry(db, E, '2026-10', 'only-frank')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(3);
  });
});
