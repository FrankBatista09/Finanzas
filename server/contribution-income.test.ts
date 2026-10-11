// A contribution to a goal can say which income it came from (migration 0013): what the API accepts and refuses,
// that an income with contributions cannot go, and that the migration only adds the column.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { seedState } from '../shared/seed';
import type { Contribution, Income } from '../shared/types';
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
const base = { goalId: 'turkey', date: '2026-10-05', amount: 100, cur: 'USD' };

describe('POST /api/contributions with incomeId', () => {
  it('keeps the link and returns it in the state; unlinked rows stay without it', async () => {
    const { api } = await seeded();
    const r = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us', incomeId: 'seed-in-3' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accountId: 'us', incomeId: 'seed-in-3' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.contribs.find((c) => c.id === r.body.id)!.incomeId).toBe('seed-in-3');
    expect(state.contribs[0]!.incomeId).toBeUndefined();
  });

  it('null means no income', async () => {
    const { api } = await seeded();
    const r = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us', incomeId: null });
    expect(r.status).toBe(201);
    expect(r.body.incomeId).toBeUndefined();
  });

  it('refuses an unknown income, one in another account and one without a source account (400)', async () => {
    const { api } = await seeded();
    const unknown = await api.post('/api/contributions', { ...base, accountId: 'us', incomeId: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.error!.message).toBe('Invalid data: incomeId: unknown income "nope"');
    const other = await api.post('/api/contributions', { ...base, accountId: 'dr', incomeId: 'seed-in-3' });
    expect(other.status).toBe(400);
    expect(other.error!.message).toBe('Invalid data: incomeId: that income is in a different account than the contribution');
    const none = await api.post('/api/contributions', { ...base, incomeId: 'seed-in-3' });
    expect(none.status).toBe(400);
    expect(none.error!.message).toContain('together with the account');
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.contribs.some((c) => c.incomeId)).toBe(false);
  });
});

describe('PATCH /api/contributions/:id with incomeId', () => {
  it('sets and clears the link, with the same checks', async () => {
    const { api } = await seeded();
    const made = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us' });
    const id = made.body.id;
    const set = await api.patch<Contribution>(`/api/contributions/${id}`, { incomeId: 'seed-in-3' });
    expect(set.body.incomeId).toBe('seed-in-3');
    const cleared = await api.patch<Contribution>(`/api/contributions/${id}`, { incomeId: null });
    expect(cleared.body.incomeId).toBeUndefined();
    const unknown = await api.patch(`/api/contributions/${id}`, { incomeId: 'nope' });
    expect(unknown.status).toBe(400);
    const other = await api.patch(`/api/contributions/${id}`, { accountId: 'dr', incomeId: 'seed-in-3' });
    expect(other.status).toBe(400);
  });

  it('refuses an income when the contribution has no source account, and drops the link when the account changes', async () => {
    const { api } = await seeded();
    const plain = await api.post<Contribution>('/api/contributions', base);
    expect((await api.patch(`/api/contributions/${plain.body.id}`, { incomeId: 'seed-in-3' })).status).toBe(400);
    const linked = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us', incomeId: 'seed-in-3' });
    const moved = await api.patch<Contribution>(`/api/contributions/${linked.body.id}`, { accountId: 'dr' });
    expect(moved.body).toMatchObject({ accountId: 'dr' });
    expect(moved.body.incomeId).toBeUndefined();
    const removed = await api.patch<Contribution>(`/api/contributions/${linked.body.id}`, { accountId: 'us', incomeId: 'seed-in-3' });
    const none = await api.patch<Contribution>(`/api/contributions/${removed.body.id}`, { accountId: null });
    expect(none.body.incomeId).toBeUndefined();
  });

  it('other fields of a linked contribution still edit freely', async () => {
    const { api } = await seeded();
    const made = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us', incomeId: 'seed-in-3' });
    const edited = await api.patch<Contribution>(`/api/contributions/${made.body.id}`, { amount: 250 });
    expect(edited.body).toMatchObject({ amount: 250, incomeId: 'seed-in-3' });
  });
});

describe('an income that contributions were taken from', () => {
  it('cannot be deleted while a contribution points to it, and can once it is removed', async () => {
    const { api } = await seeded();
    const made = await api.post<Contribution>('/api/contributions', { ...base, accountId: 'us', incomeId: 'seed-in-3' });
    const refused = await api.del('/api/incomes/seed-in-3');
    expect(refused.status).toBe(409);
    expect(refused.error!.message).toContain('in use');
    expect((await api.get<Income[]>('/api/incomes')).body.some((i) => i.id === 'seed-in-3')).toBe(true);
    await api.del(`/api/contributions/${made.body.id}`);
    expect((await api.del('/api/incomes/seed-in-3')).status).toBe(200);
  });

  it('cannot move to another account while linked, but its other fields still change', async () => {
    const { api } = await seeded();
    await api.post('/api/contributions', { ...base, accountId: 'us', incomeId: 'seed-in-3' });
    const moved = await api.patch('/api/incomes/seed-in-3', { accountId: 'dr', cur: 'DOP' });
    expect(moved.status).toBe(409);
    const edited = await api.patch<Income>('/api/incomes/seed-in-3', { desc: 'Pay' });
    expect(edited.body).toMatchObject({ desc: 'Pay', accountId: 'us' });
  });
});

describe('replacing the whole state', () => {
  it('keeps a link whose income came along in the contribution account, and drops one that did not', async () => {
    const { api, db } = await seeded();
    const state = seedState();
    state.contribs.push(
      { id: 'ok', goalId: 'turkey', date: '2026-10-05', amount: 10, cur: 'USD', rate: null, accountId: 'us', incomeId: 'seed-in-3' },
      { id: 'bad', goalId: 'turkey', date: '2026-10-05', amount: 10, cur: 'USD', rate: null, accountId: 'dr', incomeId: 'seed-in-3' },
    );
    await replaceAll(db, F, state);
    const back = (await api.get<StateResponse>('/api/state')).body.state;
    expect(back.contribs.find((c) => c.id === 'ok')!.incomeId).toBe('seed-in-3');
    expect(back.contribs.find((c) => c.id === 'bad')!.incomeId).toBeUndefined();
  });
});

describe('migration 0013', () => {
  it('adds income_id and keeps every contribution as it was, with NULL', () => {
    const files = migrationFiles();
    const last = files.indexOf('0013_contribution_income_link.sql');
    expect(last).toBeGreaterThan(0);
    const db = createTestDb(files.slice(0, last));
    db.sqlite.exec(`
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES ('frank', 'us', 'PayPal', 'USD', 0, 0, 0);
      INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, sort) VALUES ('frank', 'g1', 'Fund', 'USD', NULL, NULL, NULL, 0);
      INSERT INTO contributions (user_id, id, goal_id, date, amount, currency, rate, account_id) VALUES
        ('frank', 'c1', 'g1', '2026-10-03', 2250, 'USD', NULL, 'us'),
        ('frank', 'c2', 'g1', '2026-10-04', 100, 'USD', 1.5, NULL);
    `);
    const before = db.sqlite.prepare('SELECT * FROM contributions ORDER BY id').all().map((r) => ({ ...r }));
    applyMigrations(db, files.slice(last));
    const after = db.sqlite.prepare('SELECT * FROM contributions ORDER BY id').all().map((r) => ({ ...r }));
    expect(after).toEqual(before.map((r) => ({ ...r, income_id: null })));
  });
});
