// Outside-budget expenses through the repository and the API: migration 0008, validation, moving in a single step,
// accounts in use, closed month, month deletion, import and the Excel workbook.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { balances, monthCalc } from '../shared/calc';
import { buildExportData } from '../shared/excel/data';
import { seedState } from '../shared/seed';
import type { Month, OutsideExpense, Transaction } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { applyImport, getMonth, loadState, replaceAll } from './db';
import { client, count, EDA, FRANK, makeEnv } from './test-util';

const F = FRANK.id;
const OCT = '2026-10';
const GOLD_REJECTED =
  '"Gold" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.';

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, EDA.id, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, EDA.id) };
}

const body = { monthKey: OCT, date: '2026-10-07', name: 'Car repair', amount: 1000 };
const balanceOf = (state: Awaited<ReturnType<typeof loadState>>, id: string) => balances(state, OCT).accounts.find((a) => a.account.id === id)!.balance;

describe('migration 0008', () => {
  it('only adds the table and changes no existing row', () => {
    const files = migrationFiles();
    const at = files.indexOf('0008_outside_expenses.sql');
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES ('frank', '2026-10', 0, NULL);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR account', 'DOP', 100, 0, 0);
      INSERT INTO transactions (user_id, id, month_key, date, description, category, method, amount, currency, account_id)
        VALUES ('frank', 't1', '2026-10', '2026-10-03', 'Lunch', 'Food', 'Cash', 5, 'DOP', 'dr');
    `);
    const dump = () => ['months', 'accounts', 'transactions'].map((t) => db.sqlite.prepare(`SELECT * FROM ${t}`).all().map((r) => ({ ...r })));
    const before = dump();
    applyMigrations(db, ['0008_outside_expenses.sql']);
    expect(dump()).toEqual(before);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM outside_expenses').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the table requires a DOP/USD/TRY currency, a month and an account of the same user, and goes away with its month', () => {
    const { sqlite } = makeEnv();
    sqlite.sqlite.exec(`
      INSERT INTO months (user_id, key) VALUES ('frank', '2026-10');
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR', 'DOP', 0, 0, 0), ('eda', 'x', 'X', 'USD', 0, 0, 0);
    `);
    const insert = (user: string, id: string, month: string, account: string, currency: string) =>
      sqlite.sqlite.exec(
        `INSERT INTO outside_expenses (user_id, id, month_key, date, name, account_id, amount, currency) VALUES ('${user}', '${id}', '${month}', '2026-10-01', 'n', '${account}', 1, '${currency}')`,
      );
    expect(() => insert('frank', 'o1', '2026-10', 'dr', 'XAU')).toThrow();
    expect(() => insert('frank', 'o1', '2026-10', 'x', 'DOP')).toThrow(); // the account is Eda's
    expect(() => insert('frank', 'o1', '2026-11', 'dr', 'DOP')).toThrow(); // the month does not exist
    insert('frank', 'o1', '2026-10', 'dr', 'USD');
    expect(() => insert('frank', 'o1', '2026-10', 'dr', 'USD')).toThrow(); // key (user_id, id)
    expect(sqlite.sqlite.prepare("SELECT description, sort FROM outside_expenses WHERE id = 'o1'").get()).toEqual({ description: '', sort: 0 });
    sqlite.sqlite.exec("DELETE FROM months WHERE user_id = 'frank'");
    expect(count(sqlite, 'outside_expenses')).toBe(0);
  });
});

describe('/api/outside-expenses', () => {
  it('create, read in the month and in the state, edit and delete; the default currency is that of the account', async () => {
    const { api, db } = await seeded();
    const before = balanceOf(await loadState(db, F), 'dr');
    const created = await api.post<OutsideExpense>('/api/outside-expenses', { ...body, name: ' Car repair ', desc: ' radiator ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), monthKey: OCT, date: '2026-10-07', name: 'Car repair', desc: 'radiator', accountId: 'dr', amount: 1000, cur: 'DOP' });
    const id = created.body.id;

    const usd = await api.post<OutsideExpense>('/api/outside-expenses', { ...body, id: 'o-usd', accountId: 'us', amount: 20 });
    expect(usd.body).toMatchObject({ id: 'o-usd', accountId: 'us', cur: 'USD', desc: '' });

    const month = (await api.get<Month>(`/api/months/${OCT}`)).body;
    expect(month.outside?.map((o) => o.id)).toEqual([id, 'o-usd']);
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.months[OCT]!.outside).toHaveLength(2);
    // A month with no outside-budget expenses keeps its usual shape.
    expect('outside' in state.months['2026-09']!).toBe(false);
    expect(balanceOf(state, 'dr')).toBeCloseTo(before - 1000, 8);

    const patched = await api.patch<OutsideExpense>(`/api/outside-expenses/${id}`, { name: 'Radiator', amount: 15.5, cur: 'USD', accountId: 'us', date: '2026-10-06', desc: '' });
    expect(patched.body).toEqual({ ...created.body, name: 'Radiator', amount: 15.5, cur: 'USD', accountId: 'us', date: '2026-10-06', desc: '' });

    expect((await api.del(`/api/outside-expenses/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/outside-expenses/${id}`)).status).toBe(404);
    expect((await api.patch(`/api/outside-expenses/${id}`, { amount: 1 })).status).toBe(404);
  });

  it('validates: fields, unknown account, gold account, closed or missing month, repeated id', async () => {
    const { api, db } = await seeded();
    await api.post('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 100 });
    const snapshot = JSON.stringify(await loadState(db, F));
    const bad: [unknown, number, string][] = [
      [{ ...body, amount: 0 }, 400, 'Invalid data: amount: must be greater than 0'],
      [{ ...body, name: '  ' }, 400, 'Invalid data: name: cannot be empty'],
      [{ ...body, cur: 'XAU' }, 400, 'Invalid data: cur: must be DOP, USD or TRY'],
      [{ ...body, date: '2026-13-01' }, 400, 'Invalid data: date: is not a valid date (YYYY-MM-DD)'],
      [{ ...body, extra: 1 }, 400, expect.stringContaining('Invalid data')],
      [{ ...body, accountId: 'nope' }, 400, 'Unknown account "nope".'],
      [{ ...body, accountId: 'gold' }, 400, GOLD_REJECTED],
      [{ ...body, monthKey: '2026-09' }, 409, expect.stringContaining('closed')],
      [{ ...body, monthKey: '2030-01' }, 404, expect.stringContaining('2030-01')],
    ];
    for (const [payload, status, message] of bad) {
      const r = await api.post('/api/outside-expenses', payload);
      expect([r.status, r.error?.message], JSON.stringify(payload)).toEqual([status, message]);
    }
    const ok = await api.post<OutsideExpense>('/api/outside-expenses', { ...body, id: 'dup' });
    expect(ok.status).toBe(201);
    expect((await api.post('/api/outside-expenses', { ...body, id: 'dup' })).status).toBe(409);

    // On edit: the account is checked too, and the closed month is not touched.
    expect((await api.patch('/api/outside-expenses/dup', { accountId: 'gold' })).error?.message).toBe(GOLD_REJECTED);
    expect((await api.patch('/api/outside-expenses/dup', { accountId: 'nope' })).status).toBe(400);
    expect((await api.patch('/api/outside-expenses/dup', { amount: -1 })).status).toBe(400);
    expect(JSON.stringify((await loadState(db, F)).months['2026-09'])).toBe(JSON.stringify(JSON.parse(snapshot).months['2026-09']));
  });

  it('cannot be touched in a closed month, and reopening the month gives it back', async () => {
    const { api } = await seeded();
    await api.post('/api/outside-expenses', { ...body, id: 'o1' });
    await api.post(`/api/months/${OCT}/close`);
    for (const r of [await api.patch('/api/outside-expenses/o1', { amount: 5 }), await api.del('/api/outside-expenses/o1')]) {
      expect([r.status, r.error?.code]).toEqual([409, 'month_closed']);
    }
    await api.post(`/api/months/${OCT}/reopen`);
    expect((await api.patch('/api/outside-expenses/o1', { amount: 5 })).status).toBe(200);
  });

  it('an account with an outside-budget expense cannot be deleted; without it, it can', async () => {
    const { api } = await seeded();
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'DOP' });
    await api.post('/api/outside-expenses', { ...body, id: 'o1', accountId: 'extra' });
    const r = await api.del('/api/accounts/extra');
    expect([r.status, r.error?.code]).toEqual([409, 'conflict']);
    await api.del('/api/outside-expenses/o1');
    expect((await api.del('/api/accounts/extra')).status).toBe(200);
  });

  it('belongs to each user: another user cannot see or touch it', async () => {
    const { api, eda } = await seeded();
    await api.post('/api/outside-expenses', { ...body, id: 'mine' });
    expect((await eda.patch('/api/outside-expenses/mine', { amount: 1 })).status).toBe(404);
    expect((await eda.del('/api/outside-expenses/mine')).status).toBe(404);
    expect((await eda.post('/api/outside-expenses/mine/move-to-budget')).status).toBe(404);
    expect((await eda.get<Month>(`/api/months/${OCT}`)).body.outside).toBeUndefined();
  });

  it('deleting the month takes its outside-budget expenses with it; replacing the state keeps them', async () => {
    const { api, db, sqlite } = await seeded();
    await api.post('/api/outside-expenses', { ...body, id: 'o1', desc: 'x' });
    const state = await loadState(db, F);
    await replaceAll(db, F, state);
    expect((await loadState(db, F)).months[OCT]!.outside).toEqual(state.months[OCT]!.outside);
    expect(count(sqlite, 'outside_expenses', F)).toBe(1);
    await api.post(`/api/months/${OCT}/reopen`);
    expect((await api.del(`/api/months/${OCT}`)).status).toBe(200);
    expect(count(sqlite, 'outside_expenses', F)).toBe(0);
  });
});

describe('moving between the history and "Outside budget"', () => {
  const tx = { monthKey: OCT, date: '2026-10-07', desc: 'Uber', place: 'Downtown', cat: 'Transport', method: 'Cash', amount: 850, cur: 'DOP', notes: 'to work' };

  it('POST move-outside: a single call leaves the row on the other side, with the same data, and the balances do not change', async () => {
    const { api, db, sqlite } = await seeded();
    const created = (await api.post<Transaction>('/api/transactions', { ...tx, id: 'tx1' })).body;
    const [txBefore, calcBefore, balBefore] = [count(sqlite, 'transactions', F), monthCalc(await loadState(db, F), OCT), balanceOf(await loadState(db, F), 'dr')];

    const moved = await api.post<OutsideExpense>('/api/transactions/tx1/move-outside', { id: 'out1' });
    expect(moved.status).toBe(201);
    expect(moved.body).toEqual({ id: 'out1', monthKey: OCT, date: '2026-10-07', name: 'Uber', desc: 'Downtown · to work', accountId: created.accountId, amount: 850, cur: 'DOP' });
    expect(count(sqlite, 'transactions', F)).toBe(txBefore - 1);
    expect(count(sqlite, 'outside_expenses', F)).toBe(1);
    expect((await api.del('/api/transactions/tx1')).status).toBe(404);

    const after = await loadState(db, F);
    // The balance is the same (it still subtracts); used and the count go down: it is no longer part of the budget.
    expect(balanceOf(after, 'dr')).toBeCloseTo(balBefore, 8);
    expect(monthCalc(after, OCT).txCount).toBe(calcBefore.txCount - 1);
    expect(monthCalc(after, OCT).used).toBeCloseTo(calcBefore.used - 850, 8);
  });

  it('without a body it generates the id; and a repeated id undoes everything: the transaction is still there', async () => {
    const { api, db, sqlite } = await seeded();
    await api.post('/api/transactions', { ...tx, id: 'tx1' });
    await api.post('/api/outside-expenses', { ...body, id: 'taken' });
    const clash = await api.post('/api/transactions/tx1/move-outside', { id: 'taken' });
    expect([clash.status, clash.error?.code]).toEqual([409, 'conflict']);
    expect((await getMonth(db, F, OCT))!.tx.some((t) => t.id === 'tx1')).toBe(true);
    expect(count(sqlite, 'outside_expenses', F)).toBe(1);

    const auto = await api.post<OutsideExpense>('/api/transactions/tx1/move-outside');
    expect(auto.status).toBe(201);
    expect(auto.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getMonth(db, F, OCT))!.tx.some((t) => t.id === 'tx1')).toBe(false);
  });

  it('POST move-to-budget: category Other, method Transfer, no place; the description goes to the notes', async () => {
    const { api, db, sqlite } = await seeded();
    await api.post('/api/outside-expenses', { ...body, id: 'o1', desc: 'radiator', accountId: 'us', cur: 'DOP', amount: 5876 });
    const moved = await api.post<Transaction>('/api/outside-expenses/o1/move-to-budget', { id: 'tx-new' });
    expect(moved.status).toBe(201);
    expect(moved.body).toEqual({
      id: 'tx-new',
      monthKey: OCT,
      date: '2026-10-07',
      desc: 'Car repair',
      place: '',
      cat: 'Other',
      method: 'Transfer',
      amount: 5876,
      cur: 'DOP',
      accountId: 'us',
      notes: 'radiator',
      source: 'web',
      createdAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(count(sqlite, 'outside_expenses', F)).toBe(0);
    expect((await getMonth(db, F, OCT))!.tx.at(-1)!.id).toBe('tx-new');
    expect((await api.post('/api/outside-expenses/o1/move-to-budget')).status).toBe(404);

    // Another category and method can be chosen.
    await api.post('/api/outside-expenses', { ...body, id: 'o2' });
    const custom = await api.post<Transaction>('/api/outside-expenses/o2/move-to-budget', { cat: 'Food', method: 'Cash' });
    expect(custom.body).toMatchObject({ cat: 'Food', method: 'Cash' });
  });

  it('in a closed month, or with another user key, it moves nothing', async () => {
    const { api, db, sqlite } = await seeded();
    await api.post('/api/transactions', { ...tx, id: 'tx1' });
    await api.post('/api/outside-expenses', { ...body, id: 'o1' });
    await api.post(`/api/months/${OCT}/close`);
    const [a, b] = [await api.post('/api/transactions/tx1/move-outside'), await api.post('/api/outside-expenses/o1/move-to-budget')];
    expect([a.status, b.status, a.error?.code, b.error?.code]).toEqual([409, 409, 'month_closed', 'month_closed']);
    expect((await getMonth(db, F, OCT))!.tx.some((t) => t.id === 'tx1')).toBe(true);
    expect(count(sqlite, 'outside_expenses', F)).toBe(1);
    expect((await api.post('/api/transactions/ghost/move-outside')).status).toBe(404);
    expect((await api.post('/api/transactions/tx1/move-outside', { nope: 1 })).status).toBe(400);
  });
});

describe('import and export with outside-budget expenses', () => {
  it('the workbook carries the balances already net of them, and an import does not delete them', async () => {
    const { db, api } = await seeded();
    const base = await loadState(db, F);
    await api.post('/api/outside-expenses', { ...body, id: 'o1', amount: 5000 });
    const state = await loadState(db, F);

    const [book0, book1] = [buildExportData(base), buildExportData(state)];
    const oct = (d: ReturnType<typeof buildExportData>) => d.months.find((m) => m.key === OCT)!;
    // The workbook balances follow the app (they subtract 5,000 DOP) and the rest of the month is the same: neither used nor rows.
    expect(oct(book1).accounts.dop).toBeCloseTo(oct(book0).accounts.dop! - 5000, 6);
    expect(oct(book1).accounts.usd).toBe(oct(book0).accounts.usd);
    expect(oct(book1).tx).toEqual(oct(book0).tx);
    expect(oct(book1).budget).toBe(oct(book0).budget);

    // Re-importing the same workbook: the expense stays and the app balance does not change.
    const payload = {
      months: book1.months.map((m) => ({ key: m.key, closed: state.months[m.key]!.closed, budget: m.budget ?? 0, incomeUSD: m.incomeUSD ?? 0, accounts: { usd: m.accounts.usd ?? 0, dop: m.accounts.dop ?? 0 }, fixed: m.fixed, transfers: m.transfers, tx: m.tx })),
      contribs: null,
      goals: null,
    } as Parameters<typeof applyImport>[2];
    await applyImport(db, F, payload);
    const after = await loadState(db, F);
    expect(after.months[OCT]!.outside).toEqual(state.months[OCT]!.outside);
    expect(balanceOf(after, 'dr')).toBeCloseTo(balanceOf(state, 'dr'), 4);
    expect(balanceOf(after, 'us')).toBeCloseTo(balanceOf(state, 'us'), 4);
  });
});
