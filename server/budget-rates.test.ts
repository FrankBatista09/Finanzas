// The budget as a dated log, the leftover from the previous month, closing with a body, the incomes that
// raise the budget and the "≈" currency of the goals: through the API (what the web app uses) and through the repository
// (where the clock has to be pinned). The figures are worked out by hand from the sample data (shared/seed.ts).

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

/** "Today" for every test: October 8, 2026 in Santo Domingo. */
const TODAY = new Date('2026-10-08T15:00:00.000Z');

// September: budget 70,000; used = fixed expenses in DOP 35,872.66 + Claude 106 USD × (134,721 ÷ 2,300) + transactions 24,555.
const SEP_LEFT = 70000 - (35872.66 + (106 * 134721) / 2300 + 24555);
// October: 70,000 − 49,149.71 used.
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
  // Only the clock: the dates the server sets come from "today".
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TODAY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/months/:key/budget-log', () => {
  it('adds a movement to the part of an account: by default an adjustment dated today', async () => {
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

    // With everything given: id, date, kind. And negative, in another account (in its currency).
    const cut = await api.post<Month>('/api/months/2026-10/budget-log', { id: 'cut-1', date: '2026-10-03', accountId: 'us', amount: -50, kind: 'initial' });
    expect(cut.status).toBe(201);
    // They are read by date: the one from the 3rd lands among the sample ones.
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

  it('validates the body, the date within the month and the account; a repeated id is a 409', async () => {
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
    // Another user's account is like one that does not exist.
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

  it('in a month that does not contain today, the default date is moved into the month', async () => {
    const { db } = await seeded();
    await reopenMonth(db, F, '2026-08');
    await ensureMonth(db, F, '2026-12');
    expect(log(await addBudgetEntry(db, F, '2026-08', { accountId: 'dr', amount: 1 }, TODAY)).at(-1)).toEqual(['2026-08-31', 'dr', 1, 'adjust', '']);
    expect(log(await addBudgetEntry(db, F, '2026-12', { accountId: 'dr', amount: 1 }, TODAY)).at(-1)).toEqual(['2026-12-01', 'dr', 1, 'adjust', '']);
  });
});

describe('DELETE /api/months/:key/budget-log/:id', () => {
  it('removes that movement and the budget goes down with it', async () => {
    const { api } = await seeded();
    const r = await api.del<Month>('/api/months/2026-10/budget-log/seed-bg-2026-10-2');
    expect(r.status).toBe(200);
    expect(log(r.body)).toEqual([['2026-10-01', 'dr', 65000, 'initial', '']]);
    expect(r.body.budgets).toEqual({ dr: 65000 });
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBe(65000);
    // It is gone: 404.
    expect((await api.del('/api/months/2026-10/budget-log/seed-bg-2026-10-2')).error).toEqual({ code: 'not_found', message: 'Budget entry not found.' });
  });

  it('404 if the movement is not from that month; 409 if the month is closed', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    // It exists, but in September.
    expect((await api.del('/api/months/2026-10/budget-log/seed-bg-2026-09-1')).status).toBe(404);
    expect((await api.del('/api/months/2026-10/budget-log/nope')).status).toBe(404);
    expect((await api.del('/api/months/2031-01/budget-log/seed-bg-2026-10-1')).error?.message).toBe('Month 2031-01 does not exist.');
    expect((await api.del('/api/months/2026-08/budget-log/seed-bg-2026-08-1')).error).toEqual(closed);
    expect(await loadState(db, F)).toEqual(before);
  });
});

describe('POST /api/months/:key/leftover', () => {
  it('adds to the month what was left over from the previous one, only once, in the default account', async () => {
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

    // Again: 409, and it is not added twice.
    const again = await api.post('/api/months/2026-10/leftover');
    expect([again.status, again.error]).toEqual([409, { code: 'conflict', message: 'The leftover of the previous month was already added to 2026-10.' }]);
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(3);

    // Removing that movement allows adding it again.
    expect((await api.del(`/api/months/2026-10/budget-log/${entry.id}`)).status).toBe(200);
    expect(leftoverFor(await stateOf(api), '2026-10').added).toBe(false);
    expect((await api.post('/api/months/2026-10/leftover')).status).toBe(201);
  });

  it('400 if there is no previous month; 404 if the month does not exist; 409 if it is closed', async () => {
    const { api, db } = await seeded();
    expect((await api.post('/api/months/2026-08/leftover')).error).toEqual(closed);
    await reopenMonth(db, F, '2026-08');
    const first = await api.post('/api/months/2026-08/leftover');
    expect([first.status, first.error]).toEqual([400, { code: 'validation', message: 'There is no month before 2026-08 to take a leftover from.' }]);
    expect((await api.post('/api/months/2031-01/leftover')).error).toEqual({ code: 'not_found', message: 'Month 2031-01 does not exist.' });
    expect((await getMonth(db, F, '2026-08'))!.budgetLog).toHaveLength(1);
  });

  it('a negative leftover goes in as negative: what was overspent is subtracted from this month', async () => {
    const { api, db } = await seeded();
    // September with a 60,000 budget: it went over by 6,636.54.
    await reopenMonth(db, F, '2026-09');
    await api.patch('/api/months/2026-09', { budgets: { dr: 60000 } });
    const r = await api.post<Month>('/api/months/2026-10/leftover');
    expect(r.status).toBe(201);
    expect(r.body.budgetLog.at(-1)!.amount).toBeCloseTo(SEP_LEFT - 10000, 6);
    expect(r.body.budgetLog.at(-1)!.amount).toBeCloseTo(-6636.54, 2);
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(60000 + SEP_LEFT, 6);
  });

  it('with the default account in another currency, it goes in converted at the month rate', async () => {
    const { api, db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    const r = await api.post<Month>('/api/months/2026-10/leftover');
    const entry = r.body.budgetLog.at(-1)!;
    // 3,363.46 DOP ÷ 58.76 = 57.24 USD, in the US account.
    expect(entry).toMatchObject({ accountId: 'us', kind: 'leftover' });
    expect(entry.amount).toBeCloseTo(SEP_LEFT / 58.76, 8);
    expect(entry.amount).toBeCloseTo(57.24, 2);
    // In the main currency it is the same leftover.
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(70000 + SEP_LEFT, 6);
  });

  it('the movement date is moved into the month when today falls outside it', async () => {
    const { db } = await seeded();
    await ensureMonth(db, F, '2026-12');
    // The last recorded month before December is October.
    const month = await addLeftover(db, F, '2026-12', TODAY);
    expect(month.budgetLog.at(-1)).toMatchObject({ date: '2026-12-01', kind: 'leftover', accountId: 'dr' });
    expect(month.budgetLog.at(-1)!.amount).toBeCloseTo(OCT_LEFT, 6);
  });
});

describe('POST /api/months/:key/close with a body', () => {
  it('without a body: the next month starts with the parts from the log, without the incomes that raised the budget', async () => {
    const { api, db } = await seeded();
    await createIncome(db, F, { id: 'bonus', date: '2026-10-04', accountId: 'dr', amount: 3000, cur: 'DOP', budget: true });
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(73000);
    const r = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(r.status).toBe(200);
    expect(log(r.body.next)).toEqual([['2026-11-01', 'dr', 70000, 'initial', '']]);
    expect(r.body.next.budgets).toEqual({ dr: 70000 });
    expect(leftoverFor(await stateOf(api), '2026-11')).toMatchObject({ previousKey: '2026-10', added: false });
    // An empty body is the same.
    const other = await seeded();
    expect(log((await other.api.post<CloseResponse>('/api/months/2026-10/close', {})).body.next)).toEqual([['2026-11-01', 'dr', 70000, 'initial', '']]);
  });

  it('`budgets` gives the initial parts of the next month; a 0 leaves no movement', async () => {
    const { api } = await seeded();
    const r = await api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 80000, us: 100 } });
    expect(r.status).toBe(200);
    expect(r.body.closed.closed).toBe(true);
    // The month being closed keeps its log.
    expect(r.body.closed.budgets).toEqual({ dr: 70000 });
    expect(log(r.body.next)).toEqual([
      ['2026-11-01', 'dr', 80000, 'initial', ''],
      ['2026-11-01', 'us', 100, 'initial', ''],
    ]);
    expect(r.body.next.budgets).toEqual({ dr: 80000, us: 100 });
    expect(r.body.next.fixed).toHaveLength(11);
    // 80,000 DOP + 100 USD at the last typed rate (58.76).
    expect(monthCalc(await stateOf(api), '2026-11').budget).toBeCloseTo(80000 + 5876, 8);

    const none = await seeded();
    const empty = await none.api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 0 } });
    expect(empty.body.next.budgetLog).toEqual([]);
    expect(empty.body.next.budgets).toEqual({});
  });

  it('`addLeftover` also adds what was left over from the month being closed', async () => {
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
    // It is already added: the leftover route answers 409.
    expect((await api.post('/api/months/2026-11/leftover')).status).toBe(409);

    // With both: the parts that are sent plus the leftover.
    const both = await seeded();
    const b = await both.api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 50000 }, addLeftover: true });
    expect(b.body.next.budgets.dr).toBeCloseTo(50000 + OCT_LEFT, 6);
  });

  it('the leftover date is today if it is already the next month; otherwise, its first day', async () => {
    const early = await seeded();
    const a = await closeMonth(early.db, F, '2026-10', { addLeftover: true }, TODAY);
    expect(a.next.budgetLog.at(-1)).toMatchObject({ kind: 'leftover', date: '2026-11-01' });
    const late = await seeded();
    const b = await closeMonth(late.db, F, '2026-10', { addLeftover: true }, new Date('2026-11-03T15:00:00.000Z'));
    expect(b.next.budgetLog.at(-1)).toMatchObject({ kind: 'leftover', date: '2026-11-03' });
    expect(b.next.budgetLog[0]).toMatchObject({ kind: 'initial', date: '2026-11-01' });
  });

  it('if the next month already exists nothing is applied to it: neither the parts nor the leftover', async () => {
    const { api, db } = await seeded();
    const { month: november } = await ensureMonth(db, F, '2026-11');
    expect(november.budgets).toEqual({ dr: 70000 });
    const r = await api.post<CloseResponse>('/api/months/2026-10/close', { budgets: { dr: 1, us: 2 }, addLeftover: true });
    expect(r.status).toBe(200);
    expect(r.body.closed.closed).toBe(true);
    expect(r.body.next).toEqual(november);
    expect(leftoverFor(await stateOf(api), '2026-11').added).toBe(false);
  });

  it('an invalid body or an unknown account does not close the month', async () => {
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

describe('incomes that raise the budget, through the API', () => {
  it('`budget` is false when absent; with true the budget of the month of its date goes up, and stops going up when it is removed', async () => {
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
    // It writes nothing to the log: Month.budgets and the log stay the same.
    expect(state.months['2026-10']!.budgets).toEqual({ dr: 70000 });
    expect(state.months['2026-10']!.budgetLog).toHaveLength(2);
    expect(budgetHistory(state, '2026-10').at(-1)).toMatchObject({ kind: 'income', id: 'bonus', date: '2026-10-07', amount: 2500, note: 'Bonus', total: 72500 });
    // And it is still an income: it goes into the account.
    expect(monthCalc(state, '2026-10').income).toBeCloseTo(5800 * 58.76 + 3000, 8);

    // Changing its date to September moves the increase to September.
    await api.patch('/api/incomes/bonus', { date: '2026-09-20' });
    state = await stateOf(api);
    expect([monthCalc(state, '2026-09').budget, monthCalc(state, '2026-10').budget]).toEqual([72500, 70000]);
    expect((await api.patch<Income>('/api/incomes/bonus', { budget: false })).body.budget).toBe(false);
    expect(monthCalc(await stateOf(api), '2026-09').budget).toBe(70000);
    expect((await api.patch('/api/incomes/bonus', { budget: 'yes' })).status).toBe(400);
  });

  it('in another currency it raises the budget by what it was worth on its date, even if another rate is typed later', async () => {
    const { api } = await seeded();
    // 100 USD into the DOP account on the 7th, at 58.76.
    await api.post('/api/incomes', { id: 'a', date: '2026-10-07', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    expect(monthCalc(await stateOf(api), '2026-10').budget).toBeCloseTo(70000 + 5876, 8);
    // On the 8th 60 is typed and another 100 USD comes in: those are worth 6,000; the ones from the 7th stay at 5,876.
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    await api.post('/api/incomes', { id: 'b', date: '2026-10-08', accountId: 'dr', amount: 100, cur: 'USD', budget: true });
    const c = monthCalc(await stateOf(api), '2026-10');
    expect(c.budgetParts.find((p) => p.account.id === 'dr')).toMatchObject({ fromLog: 70000, fromIncomes: 11876 });
    expect(c.budget).toBeCloseTo(81876, 8);
    expect(c.budgetSecond).toBeCloseTo(81876 / 60, 8);
  });

  it('a closed month does not prevent it: the income does not belong to the month', async () => {
    const { api } = await seeded();
    const r = await api.post('/api/incomes', { date: '2026-08-20', accountId: 'dr', amount: 1000, cur: 'DOP', budget: true });
    expect(r.status).toBe(201);
    expect(monthCalc(await stateOf(api), '2026-08').budget).toBe(71000);
  });
});

describe('"≈" currency of a goal, through the API', () => {
  it('is created without it (null = the main currency), changed and removed', async () => {
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

    // The goal's own currency is also valid; null goes back to the main one. The rest of the goal does not change.
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

  it('what is saved shows in that currency at the last rate of the current month', async () => {
    const { api } = await seeded();
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-02' });
    await api.patch('/api/goals/turkey', { approxCur: 'TRY' });
    const turkey = goalsProgress(await stateOf(api)).find((g) => g.id === 'turkey')!;
    expect(turkey).toMatchObject({ cur: 'USD', saved: 9000, approxCur: 'TRY' });
    expect(turkey.savedApprox).toBeCloseTo(360000, 8);
    expect(turkey.savedMain).toBeCloseTo(9000 * 58.76, 8);
  });
});

describe('two users: the log, the dated rates, the leftover and everything else of each one are kept apart', () => {
  it('nothing Frank does touches the data of Eda, even if the ids and the months match', async () => {
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

    // Eda cannot see or touch Frank's movements: to her, their id does not exist.
    expect((await eda.del('/api/months/2026-10/budget-log/mine')).status).toBe(404);
    expect((await eda.post('/api/months/2026-11/leftover')).status).toBe(404);
    // And with an id they both have (the sample data), each one deletes their own.
    const frank = await loadState(db, F);
    expect((await eda.del('/api/months/2026-10/budget-log/seed-bg-2026-10-2')).status).toBe(200);
    expect((await eda.post('/api/months/2026-10/leftover')).status).toBe(201);
    expect(await loadState(db, F)).toEqual(frank);
    expect((await getMonth(db, E, '2026-10'))!.budgetLog.map((e) => e.kind)).toEqual(['initial', 'leftover']);
    // Eda's leftover is the one from HER September, untouched.
    expect((await getMonth(db, E, '2026-10'))!.budgetLog.at(-1)!.amount).toBeCloseTo(SEP_LEFT, 6);
  });

  it('deleting a movement through the repository with the id of another user is a 404', async () => {
    const { db } = await seeded();
    await addBudgetEntry(db, F, '2026-10', { id: 'only-frank', accountId: 'dr', amount: 1 }, TODAY);
    await expect(deleteBudgetEntry(db, E, '2026-10', 'only-frank')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(3);
  });
});
