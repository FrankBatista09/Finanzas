// Own rate and origin account of a contribution, and recurring incomes, through the API and the repository.
// Sample data for October 2026 (seedState): accounts us (USD) and dr (DOP), goals emergency, personal and turkey.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { balances, incomeInMonth } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { Account, Contribution, Income } from '../shared/types';
import { closeMonth, createIncome, ensureMonth, listIncomes, loadState, patchIncome, replaceAll } from './db';
import { client, FRANK, makeEnv } from './test-util';

const F = FRANK.id;

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, F, seedState());
  return { ...t, api: client(t.env) };
}

const income = { date: '2026-10-09', desc: 'PayPal', accountId: 'dr', amount: 100, cur: 'USD' };

describe('API: own rate on incomes and contributions', () => {
  it('rate > 0 is stored, changes the month figures and null removes it; 0, negative or non-numeric is 400', async () => {
    const { api } = await seeded();
    const base = incomeInMonth((await api.get<StateResponse>('/api/state')).body.state, '2026-10');
    const created = await api.post<Income>('/api/incomes', { ...income, rate: 61.5 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ rate: 61.5, recurring: false });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(incomeInMonth(state, '2026-10')).toBeCloseTo(base + 100 * 61.5, 6);

    const cleared = await api.patch<Income>(`/api/incomes/${created.body.id}`, { rate: null });
    expect(cleared.body.rate).toBeNull();
    for (const bad of [0, -1, 'x']) {
      expect((await api.post('/api/incomes', { ...income, rate: bad })).status).toBe(400);
      expect((await api.patch(`/api/incomes/${created.body.id}`, { rate: bad })).status).toBe(400);
    }
    const c = await api.post<Contribution>('/api/contributions', { goalId: 'emergency', date: '2026-10-09', amount: 10, cur: 'USD', rate: 60 });
    expect(c.body).toMatchObject({ rate: 60, accountId: null });
    expect((await api.patch<Contribution>(`/api/contributions/${c.body.id}`, { rate: null })).body.rate).toBeNull();
    expect((await api.post('/api/contributions', { goalId: 'emergency', date: '2026-10-09', amount: 10, cur: 'USD', rate: 0 })).status).toBe(400);
  });
});

describe('API: account a contribution comes out of', () => {
  it('it is stored, and removed with null; an unknown or gold account is 400; and the account in use cannot be deleted', async () => {
    const { api } = await seeded();
    expect((await api.post<Account>('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 5 })).status).toBe(201);
    const body = { goalId: 'emergency', date: '2026-10-09', amount: 10, cur: 'USD' };
    const ok = await api.post<Contribution>('/api/contributions', { ...body, accountId: 'us' });
    expect(ok.status).toBe(201);
    expect(ok.body.accountId).toBe('us');

    const unknown = await api.post('/api/contributions', { ...body, accountId: 'nope' });
    expect(unknown.status).toBe(400);
    const gold = await api.post('/api/contributions', { ...body, accountId: 'gold' });
    expect(gold.status).toBe(400);
    expect(gold.error?.message).toContain('gold account');
    expect((await api.patch(`/api/contributions/${ok.body.id}`, { accountId: 'gold' })).status).toBe(400);
    expect((await api.patch(`/api/contributions/${ok.body.id}`, { accountId: 'nope' })).status).toBe(400);

    // A contribution uses it: it cannot be deleted (409), only hidden.
    expect((await api.del('/api/accounts/us')).status).toBe(409);
    const cleared = await api.patch<Contribution>(`/api/contributions/${ok.body.id}`, { accountId: null });
    expect(cleared.body.accountId).toBeNull();
    // Without the contribution (and with no other movements) it can be deleted again: the new account has nothing.
    const fresh = await api.post<Account>('/api/accounts', { name: 'Fresh', currency: 'USD' });
    const used = await api.post<Contribution>('/api/contributions', { ...body, accountId: fresh.body.id });
    expect((await api.del(`/api/accounts/${fresh.body.id}`)).status).toBe(409);
    await api.del(`/api/contributions/${used.body.id}`);
    expect((await api.del(`/api/accounts/${fresh.body.id}`)).status).toBe(200);
  });

  it('the contribution lowers the account balance in the state the server reads', async () => {
    const { api } = await seeded();
    const before = balances((await api.get<StateResponse>('/api/state')).body.state, '2026-10').accounts.find((a) => a.account.id === 'us')!.balance;
    await api.post('/api/contributions', { goalId: 'emergency', date: '2026-10-09', amount: 25, cur: 'USD', accountId: 'us' });
    const after = balances((await api.get<StateResponse>('/api/state')).body.state, '2026-10').accounts.find((a) => a.account.id === 'us')!.balance;
    expect(after).toBeCloseTo(before - 25, 8);
  });
});

describe('recurring incomes when a month is created', () => {
  const nov = async (db: D1Database) => (await listIncomes(db, F)).filter((i) => i.date.startsWith('2026-11'));

  it('copies only the recurring ones from the previous month: same data, recurring, with no own rate and with the day clamped', async () => {
    const { db } = await seeded();
    await ensureMonth(db, F, '2027-01');
    await createIncome(db, F, { date: '2027-01-31', desc: 'Salary', accountId: 'dr', amount: 1000, cur: 'USD', budget: true, rate: 60, recurring: true });
    await createIncome(db, F, { date: '2027-01-15', desc: 'Gift', accountId: 'dr', amount: 5, cur: 'DOP' });
    await ensureMonth(db, F, '2027-02');
    const feb = (await listIncomes(db, F)).filter((i) => i.date.startsWith('2027-02'));
    expect(feb.map(({ id: _id, ...i }) => i)).toEqual([
      { date: '2027-02-28', desc: 'Salary', accountId: 'dr', amount: 1000, cur: 'USD', budget: true, rate: null, recurring: true },
    ]);
    // The chain goes on: March gets February's, with its day 28 (it does not go back to the 31st).
    await ensureMonth(db, F, '2027-03');
    const mar = (await listIncomes(db, F)).filter((i) => i.date.startsWith('2027-03'));
    expect(mar.map((i) => [i.date, i.recurring])).toEqual([['2027-03-28', true]]);
  });

  it('only once per month: opening the month again, closing twice or already having an identical one does not duplicate', async () => {
    const { db } = await seeded();
    await patchIncome(db, F, 'seed-in-3', { recurring: true });
    await createIncome(db, F, { date: '2026-10-20', desc: 'Rent', accountId: 'dr', amount: 300, cur: 'DOP', recurring: true });
    // November already has an income identical to the Rent one (even though it is not recurring): that one is not copied.
    await createIncome(db, F, { date: '2026-11-03', desc: 'Rent', accountId: 'dr', amount: 300, cur: 'DOP' });
    await closeMonth(db, F, '2026-10');
    expect((await nov(db)).map((i) => [i.desc, i.date, i.recurring]).sort()).toEqual([
      ['Rent', '2026-11-03', false],
      ['Salary', '2026-11-01', true],
    ]);
    await closeMonth(db, F, '2026-10');
    await ensureMonth(db, F, '2026-11');
    expect(await nov(db)).toHaveLength(2);
    expect(incomeInMonth(await loadState(db, F), '2026-11')).toBeGreaterThan(0);
  });

  it('unchecking "Recurring" only affects future copies; gold is copied without budget', async () => {
    const { api, db } = await seeded();
    await api.post('/api/accounts', { id: 'gold', name: 'Gold', currency: 'XAU', opening: 0 });
    await createIncome(db, F, { date: '2026-10-12', desc: 'Grams', accountId: 'gold', amount: 2.5, cur: 'XAU', recurring: true });
    await patchIncome(db, F, 'seed-in-3', { recurring: true });
    await patchIncome(db, F, 'seed-in-3', { recurring: false });
    await closeMonth(db, F, '2026-10');
    const copies = await nov(db);
    expect(copies.map((i) => [i.desc, i.cur, i.budget, i.recurring, i.date])).toEqual([['Grams', 'XAU', false, true, '2026-11-12']]);
  });
});
