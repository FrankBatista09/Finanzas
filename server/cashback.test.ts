// Cashback on credit cards: migration 0014, the flag on the card, the monthly amount endpoint and what it does to the totals.

import { describe, expect, it } from 'vitest';
import type { StateResponse } from '../shared/api';
import { cardCalc } from '../shared/calc';
import { seedState } from '../shared/seed';
import type { CreditCard, Month } from '../shared/types';
import { applyMigrations, createTestDb, migrationFiles } from './d1-node';
import { loadState, replaceAll } from './db';
import { client, FRANK, makeEnv } from './test-util';

const OCT = '2026-10';
const CARD: CreditCard = { id: 'card', name: 'Visa', bank: null, last4: null, cur: 'DOP', limit: null, cutoffDay: null, dueDay: null, active: true, sort: 0 };
const C = `/api/months/${OCT}/cards/card`;

async function seeded() {
  const t = makeEnv();
  await replaceAll(t.db, FRANK.id, { ...seedState(), cards: [CARD] });
  return { ...t, api: client(t.env) };
}

describe('migration 0014', () => {
  const FILE = '0014_card_cashback.sql';
  it('keeps every row and adds both columns with their defaults', () => {
    const files = migrationFiles();
    const at = files.indexOf(FILE);
    expect(at).toBeGreaterThan(-1);
    const db = createTestDb(files.slice(0, at));
    db.sqlite.exec(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES ('frank', '2026-10', 0, NULL);
      INSERT INTO credit_cards (user_id, id, name, currency, active, sort) VALUES ('frank', 'card', 'Visa', 'DOP', 1, 0);
      INSERT INTO month_cards (user_id, month_key, card_id, other) VALUES ('frank', '2026-10', 'card', 300);
    `);
    applyMigrations(db, [FILE]);
    expect(db.sqlite.prepare('SELECT id, name, active, cashback FROM credit_cards').all().map((r) => ({ ...r }))).toEqual([{ id: 'card', name: 'Visa', active: 1, cashback: 0 }]);
    expect(db.sqlite.prepare('SELECT card_id, other, cashback FROM month_cards').all().map((r) => ({ ...r }))).toEqual([{ card_id: 'card', other: 300, cashback: 0 }]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('cashback API', () => {
  it('the flag is optional on create, shows only when on, and is edited with PATCH', async () => {
    const { api } = await seeded();
    expect((await api.post<CreditCard>('/api/credit-cards', { name: 'Plain' })).body).not.toHaveProperty('cashback');
    const made = await api.post<CreditCard>('/api/credit-cards', { name: 'Cash', cashback: true });
    expect(made.body.cashback).toBe(true);
    expect((await api.post('/api/credit-cards', { name: 'Bad', cashback: 'yes' })).status).toBe(400);
    const off = await api.patch<CreditCard>(`/api/credit-cards/${made.body.id}`, { cashback: false });
    expect(off.body).not.toHaveProperty('cashback');
  });

  it('requires the flag: a card without it answers 400 and an unknown card 404', async () => {
    const { api } = await seeded();
    const r = await api.patch(`${C}/cashback`, { cashback: 10 });
    expect([r.status, r.error?.code]).toEqual([400, 'validation']);
    expect(r.error?.message).toContain('does not have cashback');
    expect((await api.patch(`/api/months/${OCT}/cards/nope/cashback`, { cashback: 10 })).status).toBe(404);
  });

  it('stores the amount, lowers what is owed and validates it', async () => {
    const { api, db } = await seeded();
    await api.patch(`/api/credit-cards/card`, { cashback: true });
    await api.patch(`${C}/other`, { other: 1000 });
    const set = await api.patch<Month>(`${C}/cashback`, { cashback: 120 });
    expect(set.status).toBe(200);
    expect(set.body.cards).toEqual([{ cardId: 'card', other: 1000, cashback: 120, payments: [] }]);
    const state = await loadState(db, FRANK.id);
    expect(cardCalc(state, OCT, 'card')).toMatchObject({ total: 880, remainder: 880 });
    expect((await api.patch(`${C}/cashback`, { cashback: -1 })).status).toBe(400);
    expect((await api.patch(`${C}/cashback`, { cashback: 1, extra: 1 })).status).toBe(400);
    // Paying more than what is left after the deduction is refused.
    expect((await api.post(`${C}/pay`, { amount: 900, accountId: 'dr' })).status).toBe(400);
    expect((await api.post(`${C}/pay`, { amount: 880, accountId: 'dr' })).status).toBe(200);
  });

  it('0 clears it and the row goes away when nothing else is stored; other charges are kept', async () => {
    const { api } = await seeded();
    await api.patch(`/api/credit-cards/card`, { cashback: true });
    await api.patch(`${C}/cashback`, { cashback: 50 });
    const cleared = await api.patch<Month>(`${C}/cashback`, { cashback: 0 });
    expect(cleared.body.cards).toBeUndefined();
    await api.patch(`${C}/other`, { other: 10 });
    await api.patch(`${C}/cashback`, { cashback: 5 });
    expect((await api.patch<Month>(`${C}/other`, { other: 0 })).body.cards).toEqual([{ cardId: 'card', other: 0, cashback: 5, payments: [] }]);
  });

  it('turning the flag off clears the stored amounts', async () => {
    const { api } = await seeded();
    await api.patch(`/api/credit-cards/card`, { cashback: true });
    await api.patch(`${C}/cashback`, { cashback: 50 });
    await api.patch(`/api/credit-cards/card`, { cashback: false });
    await api.patch(`/api/credit-cards/card`, { cashback: true });
    const month = (await api.get<StateResponse>('/api/state')).body.state.months[OCT]!;
    expect(month.cards).toBeUndefined();
  });

  it('a closed month answers 409', async () => {
    const { api } = await seeded();
    await api.patch(`/api/credit-cards/card`, { cashback: true });
    const closed = await api.patch(`/api/months/2026-09/cards/card/cashback`, { cashback: 5 });
    expect(closed.status).toBe(409);
  });
});
