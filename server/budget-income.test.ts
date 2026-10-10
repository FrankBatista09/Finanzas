// A budget entry can say which income it was taken from (migration 0012): what the API accepts and refuses, and
// that the migration only adds the column.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { seedState } from '../shared/seed';
import type { Income, Month } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { replaceAll } from './db';
import { client, FRANK, makeEnv } from './test-util';

const F = FRANK.id;

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  return { ...t, api: client(t.env) };
}

// The seed has Salary (id seed-in-3, 5,800 USD) in the 'us' account; 'dr' is the DOP account.
describe('POST /api/months/:key/budget-log with incomeId', () => {
  it('keeps the link, and it comes back in the month and in the state', async () => {
    const { api } = await seeded();
    const r = await api.post<Month>('/api/months/2026-10/budget-log', { accountId: 'us', amount: 100, incomeId: 'seed-in-3' });
    expect(r.status).toBe(201);
    expect(r.body.budgetLog.at(-1)).toMatchObject({ accountId: 'us', amount: 100, incomeId: 'seed-in-3' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.months['2026-10']!.budgetLog.at(-1)!.incomeId).toBe('seed-in-3');
    // Entries without an income stay as they were.
    expect(state.months['2026-10']!.budgetLog[0]!.incomeId).toBeUndefined();
  });

  it('null means no income', async () => {
    const { api } = await seeded();
    const r = await api.post<Month>('/api/months/2026-10/budget-log', { accountId: 'dr', amount: 100, incomeId: null });
    expect(r.status).toBe(201);
    expect(r.body.budgetLog.at(-1)!.incomeId).toBeUndefined();
  });

  it('refuses an income of another account and one that does not exist (400) without writing', async () => {
    const { api } = await seeded();
    const other = await api.post('/api/months/2026-10/budget-log', { accountId: 'dr', amount: 100, incomeId: 'seed-in-3' });
    expect(other.status).toBe(400);
    expect(other.error!.message).toBe('Invalid data: incomeId: that income is in a different account than the budget entry');
    const unknown = await api.post('/api/months/2026-10/budget-log', { accountId: 'us', amount: 100, incomeId: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.error!.message).toBe('Invalid data: incomeId: unknown income "nope"');
    const month = (await api.get<Month>('/api/months/2026-10')).body;
    expect(month.budgetLog.some((e) => e.incomeId)).toBe(false);
  });

  it('a closed month stays a 409 even with an income', async () => {
    const { api } = await seeded();
    const r = await api.post('/api/months/2026-08/budget-log', { accountId: 'us', amount: 100, incomeId: 'seed-in-3' });
    expect(r.status).toBe(409);
    expect(r.error!.code).toBe('month_closed');
  });
});

describe('an income that budget entries were taken from', () => {
  it('cannot be deleted while an entry points to it, and can once the entry is removed', async () => {
    const { api } = await seeded();
    const added = await api.post<Month>('/api/months/2026-10/budget-log', { accountId: 'us', amount: 100, incomeId: 'seed-in-3' });
    const entryId = added.body.budgetLog.at(-1)!.id;
    const refused = await api.del('/api/incomes/seed-in-3');
    expect(refused.status).toBe(409);
    expect(refused.error!.message).toContain('in use');
    expect((await api.get<Income[]>('/api/incomes')).body.some((i) => i.id === 'seed-in-3')).toBe(true);
    await api.del(`/api/months/2026-10/budget-log/${entryId}`);
    expect((await api.del('/api/incomes/seed-in-3')).status).toBe(200);
  });

  it('cannot move to another account while linked, but its other fields still change', async () => {
    const { api } = await seeded();
    await api.post('/api/months/2026-10/budget-log', { accountId: 'us', amount: 100, incomeId: 'seed-in-3' });
    const moved = await api.patch('/api/incomes/seed-in-3', { accountId: 'dr', cur: 'DOP' });
    expect(moved.status).toBe(409);
    const edited = await api.patch<Income>('/api/incomes/seed-in-3', { desc: 'Pay' });
    expect(edited.body).toMatchObject({ desc: 'Pay', accountId: 'us' });
  });
});

describe('migration 0012', () => {
  it('adds income_id and keeps every budget row as it was, with NULL', () => {
    const files = migrationFiles();
    const last = files.indexOf('0012_budget_income_link.sql');
    expect(last).toBeGreaterThan(0);
    const db = createTestDb(files.slice(0, last));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed) VALUES ('frank', '2026-10', 0);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'dr', 'DR', 'DOP', 0, 0, 0);
      INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note) VALUES
        ('frank', 'b1', '2026-10', '2026-10-01', 'dr', 70000, 'initial', ''),
        ('frank', 'b2', '2026-10', '2026-10-05', 'dr', 5000, 'adjust', 'Car repair');
    `);
    const before = db.sqlite.prepare('SELECT * FROM month_budget_log ORDER BY id').all().map((r) => ({ ...r }));
    applyMigrations(db, files.slice(last));
    const after = db.sqlite.prepare('SELECT * FROM month_budget_log ORDER BY id').all().map((r) => ({ ...r }));
    expect(after).toEqual(before.map((r) => ({ ...r, income_id: null })));
  });
});
