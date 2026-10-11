import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CloseResponse,
  ImportPayload,
  ImportResponse,
  MonthSummary,
  OkResponse,
  SessionResponse,
  SettingsResponse,
  StateResponse,
} from '../shared/api';
import { balances, monthCalc, rateFor } from '../shared/calc';
import { DEFAULT_ACCOUNTS, DEFAULT_GOALS, DEFAULT_RATE } from '../shared/constants';
import { IMPORTED_INCOME } from '../shared/excel/data';
import { currentMonthKey } from '../shared/month';
import { seedState, SEED_ACCOUNTS, SEED_PLANNED_GOAL } from '../shared/seed';
import type { Account, AppState, Contribution, FixedExpense, Goal, Income, Month, Transaction, Transfer } from '../shared/types';
import { MAX_JSON_BYTES } from './app';
import { loadState, replaceAll } from './db';
import type { Env } from './env';
import { client, count, EDA, FRANK, makeEnv, TOKEN, USERS, withoutTimestamps } from './test-util';

// `api` always speaks as Frank. Eda sits alongside with the same sample data (same ids, same months).
const F = FRANK.id;
const E = EDA.id;

let bystander: { db: D1Database; before: AppState } | null = null;

/** Both users with the sample data, watching nobody: for the tests in which both of them act. */
async function pair(extra: Partial<Env> = {}) {
  const t = makeEnv(extra);
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

/** Like pair(), and when the test ends it checks that nothing Frank did touched Eda's data. */
async function seeded(extra: Partial<Env> = {}) {
  const t = await pair(extra);
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

function fresh(extra: Partial<Env> = {}) {
  const t = makeEnv(extra);
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const watched = bystander;
  bystander = null;
  if (watched) expect(await loadState(watched.db, E)).toEqual(watched.before);
});

const emptyMonth = (key: string): Month => ({ key, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] });

/** A newly arrived user: their initial accounts and goals and the current month, empty. */
const arrivedState = (language: AppState['language'] = 'en'): AppState => ({
  months: { [currentMonthKey()]: emptyMonth(currentMonthKey()) },
  accounts: [...DEFAULT_ACCOUNTS],
  incomes: [],
  goals: [...DEFAULT_GOALS],
  contribs: [],
  cards: [],
  mainCurrency: 'DOP',
  secondCurrency: 'USD',
  defaultAccountId: null,
  defaultRate: DEFAULT_RATE,
  goldPrice: null,
  theme: null,
  language,
});

const DEFAULT_SETTINGS: SettingsResponse = { theme: null, language: 'en', mainCurrency: 'DOP', secondCurrency: 'USD', defaultAccountId: null, goldPrice: null };

const unknownAccount = (id: string) => ({ code: 'validation', message: `Unknown account "${id}".` });

/** Balance of one of Frank's accounts at the end of `asOf`, as the web app would compute it from the API response. */
async function balance(api: ReturnType<typeof client>, accountId: string, asOf = '2026-10'): Promise<number> {
  const { state } = (await api.get<StateResponse>('/api/state')).body;
  return balances(state, asOf).accounts.find((a) => a.account.id === accountId)!.balance;
}

describe('GET /api/session', () => {
  it('lists the configured users, in their order, without requiring X-User', async () => {
    const { env, sqlite } = makeEnv();
    const r = await client(env, null).get<SessionResponse>('/api/session');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ users: [FRANK, EDA], devTools: false });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    // With the header it answers the same, and it sets nobody up in the database.
    expect((await client(env, E).get<SessionResponse>('/api/session')).body).toEqual(r.body);
    expect(count(sqlite, 'settings')).toBe(0);
  });

  it('devTools reflects ALLOW_DEV_RESET', async () => {
    const session = async (flag: string) => (await fresh({ ALLOW_DEV_RESET: flag }).api.get<SessionResponse>('/api/session')).body;
    expect((await session('1')).devTools).toBe(true);
    expect((await session('true')).devTools).toBe(false);
  });

  it('USERS: default name, whitespace and, when it is not set, a single user', async () => {
    const users = async (value: string | undefined) => {
      const { db } = makeEnv();
      const env: Env = value === undefined ? { DB: db } : { DB: db, USERS: value };
      return (await client(env, null).get<SessionResponse>('/api/session')).body.users;
    };
    expect(await users(' ana : Ana María , luis ')).toEqual([
      { id: 'ana', name: 'Ana María' },
      { id: 'luis', name: 'Luis' },
    ]);
    expect(await users(undefined)).toEqual([{ id: 'me', name: 'Me' }]);
    expect(await users('')).toEqual([{ id: 'me', name: 'Me' }]);
  });

  it('a malformed USERS is a configuration error: 500 across the whole API, with the reason in the log and not in the response', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, sqlite } = makeEnv({ USERS: 'frank:Frank,Eda Maria:Eda' });
    const replies = [
      await client(env, null).get('/api/session'),
      await client(env).get('/api/state'),
      await client(env).post('/api/goals', { name: 'x' }),
      await client(env, null).post('/api/ingest/transaction', { description: 'x', amount: 1 }, { Authorization: `Bearer ${TOKEN}` }),
    ];
    for (const r of replies) {
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: 'internal', message: 'Internal server error.' } });
    }
    expect(log).toHaveBeenCalledTimes(replies.length);
    expect(String(log.mock.calls[0]![1])).toContain('USERS: invalid user id "Eda Maria"');
    // It does not silently fall back to another list: nobody got to write anything.
    for (const table of ['months', 'accounts', 'goals', 'settings', 'transactions']) expect(count(sqlite, table)).toBe(0);
  });
});

describe('X-User header', () => {
  const routes: [method: 'get' | 'post' | 'put' | 'patch' | 'del', path: string, body?: unknown][] = [
    ['get', '/api/state'],
    ['patch', '/api/settings', { language: 'es' }],
    ['patch', '/api/settings', { mainCurrency: 'USD', secondCurrency: 'DOP' }],
    ['get', '/api/accounts'],
    ['post', '/api/accounts', { name: 'PayPal', currency: 'USD' }],
    ['patch', '/api/accounts/us', { hidden: true }],
    ['del', '/api/accounts/us'],
    ['get', '/api/months'],
    ['get', '/api/months/2026-10'],
    ['patch', '/api/months/2026-10', { budgets: { dr: 1 } }],
    ['put', '/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' }],
    ['del', '/api/months/2026-10/rates/USD/DOP?date=2026-10-06'],
    ['post', '/api/months/2026-10/close'],
    ['post', '/api/months/2026-08/reopen'],
    ['del', '/api/months/2026-10'],
    ['post', '/api/fixed', { monthKey: '2026-10', name: 'Agua', amount: 500, cur: 'DOP' }],
    ['patch', '/api/fixed/seed-fx-2026-10-1', { paid: false }],
    ['del', '/api/fixed/seed-fx-2026-10-1'],
    ['post', '/api/transactions', { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' }],
    ['patch', '/api/transactions/seed-tx-2026-10-1', { amount: 1 }],
    ['del', '/api/transactions/seed-tx-2026-10-1'],
    ['post', '/api/transfers', { monthKey: '2026-10', date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1, rate: 58 }],
    ['patch', '/api/transfers/seed-tr-2026-10-1', { amount: 1 }],
    ['del', '/api/transfers/seed-tr-2026-10-1'],
    ['get', '/api/incomes'],
    ['post', '/api/incomes', { date: '2026-10-07', amount: 1, cur: 'USD' }],
    ['patch', '/api/incomes/seed-in-1', { amount: 1 }],
    ['del', '/api/incomes/seed-in-1'],
    ['get', '/api/goals'],
    ['post', '/api/goals', { name: 'Car' }],
    ['patch', '/api/goals/turkey', { sort: 9 }],
    ['del', '/api/goals/personal'],
    ['get', '/api/contributions'],
    ['post', '/api/contributions', { goalId: 'personal', date: '2026-10-07', amount: 1, cur: 'USD' }],
    ['patch', '/api/contributions/seed-ct-1', { amount: 1 }],
    ['del', '/api/contributions/seed-ct-1'],
    ['get', '/api/export.xlsx'],
    ['post', '/api/import', { months: [], contribs: [], goals: null }],
    ['post', '/api/dev/seed'],
    ['post', '/api/dev/reset'],
  ];

  const call = (api: ReturnType<typeof client>, [method, path, body]: (typeof routes)[number]) =>
    method === 'get' || method === 'del' ? api[method](path) : api[method](path, body);

  it('without it, every route except /api/session and /api/ingest/* answers 400 validation and touches nothing', async () => {
    const t = makeEnv({ ALLOW_DEV_RESET: '1' });
    await replaceAll(t.db, F, seedState());
    await replaceAll(t.db, E, seedState());
    const before = [await loadState(t.db, F), await loadState(t.db, E)];
    const anonymous = client(t.env, null);
    for (const route of routes) {
      const r = await call(anonymous, route);
      expect(r.status, route[1]).toBe(400);
      expect(r.body, route[1]).toEqual({
        error: { code: 'validation', message: 'The X-User header is required (valid ids: frank, eda).' },
      });
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await anonymous.get('/api/state', { 'X-User': '  ' })).status).toBe(400);
    expect([await loadState(t.db, F), await loadState(t.db, E)]).toEqual(before);
  });

  it('with a user that is not configured: 400 validation with the valid ids, and nothing is created for them', async () => {
    const t = makeEnv({ ALLOW_DEV_RESET: '1' });
    const stranger = client(t.env, 'pedro');
    for (const route of routes) {
      const r = await call(stranger, route);
      expect(r.status, route[1]).toBe(400);
      expect(r.error, route[1]).toEqual({
        code: 'validation',
        message: 'Unknown user "pedro" in the X-User header (valid ids: frank, eda).',
      });
    }
    // The display name is not the id; and a very long value is not returned in full.
    expect((await client(t.env, 'Frank Reyes').get('/api/state')).status).toBe(400);
    const long = await client(t.env, 'x'.repeat(500)).get('/api/state');
    expect(long.error?.message).toHaveLength('Unknown user "" in the X-User header (valid ids: frank, eda).'.length + 40);
    for (const table of ['months', 'accounts', 'goals', 'settings', 'transactions', 'incomes']) expect(count(t.sqlite, table)).toBe(0);
  });

  it('with a configured user it goes through; the id ignores case and whitespace, and so does the header name', async () => {
    const { env } = makeEnv();
    const variants: Record<string, string>[] = [{ 'X-User': 'eda' }, { 'x-user': ' Eda ' }, { 'X-USER': 'EDA' }];
    for (const headers of variants) {
      const r = await client(env, null).get<StateResponse>('/api/state', headers);
      expect(r.status, JSON.stringify(headers)).toBe(200);
      expect(r.body.user).toEqual(EDA);
    }
  });

  it('a route that does not exist is still a 404 for a valid user', async () => {
    const { api } = fresh();
    expect((await api.get('/api/nada')).status).toBe(404);
    // /api/session is only that exact route.
    expect((await client(makeEnv().env, null).get('/api/session/otra')).status).toBe(400);
  });
});

describe('GET /api/state', () => {
  it('the first visit of a user creates their initial accounts and goals and the current month', async () => {
    const { api, sqlite } = fresh();
    const r = await api.get<StateResponse>('/api/state');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.body).toEqual({ user: FRANK, state: arrivedState() });
    // Requesting it again creates nothing else, and nobody has created anything for Eda yet.
    expect((await api.get<StateResponse>('/api/state')).body).toEqual(r.body);
    expect(count(sqlite, 'months')).toBe(1);
    expect(count(sqlite, 'accounts')).toBe(2);
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'accounts', E)).toBe(0);
    expect(count(sqlite, 'goals', E)).toBe(0);
  });

  it('each user gets their own data, with their name', async () => {
    const { api, eda, sqlite } = fresh();
    await api.get('/api/state');
    await api.post('/api/goals', { name: 'Car' });
    await api.post('/api/accounts', { name: 'PayPal', currency: 'USD' });
    const r = await eda.get<StateResponse>('/api/state');
    expect(r.body.user).toEqual(EDA);
    expect(r.body.state.goals).toEqual([...DEFAULT_GOALS]);
    expect(r.body.state.accounts).toEqual([...DEFAULT_ACCOUNTS]);
    expect((await api.get<StateResponse>('/api/state')).body.state.accounts.map((a) => a.name)).toEqual(['US account', 'DR account', 'PayPal']);
    expect((await api.get<StateResponse>('/api/state')).body.state.goals.map((g) => g.name)).toEqual([
      'Emergency fund',
      'Personal savings',
      'Car',
    ]);
    expect(count(sqlite, 'months')).toBe(2);
  });

  it('a user who deletes their initial accounts or goals does not get them back on the next visit', async () => {
    const { api } = fresh();
    await api.get('/api/state');
    expect((await api.del('/api/goals/emergency')).status).toBe(200);
    expect((await api.get<StateResponse>('/api/state')).body.state.goals.map((g) => g.id)).toEqual(['personal']);
    expect((await api.del('/api/goals/personal')).status).toBe(200);
    expect((await api.del('/api/accounts/us')).status).toBe(200);
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.goals).toEqual([]);
    expect(state.accounts.map((a) => a.id)).toEqual(['dr']);
  });

  it('with data it creates nothing and returns the whole history', async () => {
    const { api, sqlite } = await seeded();
    const r = await api.get<StateResponse>('/api/state');
    expect(r.body.user).toEqual(FRANK);
    expect(withoutTimestamps(r.body.state)).toEqual(seedState());
    expect(count(sqlite, 'months', F)).toBe(3);
    expect(count(sqlite, 'accounts', F)).toBe(2);
    expect(count(sqlite, 'goals', F)).toBe(3);
  });

  it('a user left with no months finds the current one again, empty, with everything else as it was', async () => {
    const { api } = await seeded();
    for (const key of ['2026-08', '2026-09', '2026-10']) expect((await api.del(`/api/months/${key}`)).status).toBe(200);
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.months).toEqual({ [currentMonthKey()]: emptyMonth(currentMonthKey()) });
    expect(state.accounts).toEqual(seedState().accounts);
    expect(state.incomes).toEqual(seedState().incomes);
    expect(state.goals).toEqual(seedState().goals);
    expect(state.contribs).toEqual(seedState().contribs);
  });
});

describe('PATCH /api/settings', () => {
  const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };

  it('language: stored per user and returned in /api/state', async () => {
    const { api, eda } = fresh();
    const r = await api.patch<SettingsResponse>('/api/settings', { language: 'tr' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...DEFAULT_SETTINGS, language: 'tr' });
    expect((await api.get<StateResponse>('/api/state')).body.state.language).toBe('tr');
    expect((await eda.get<StateResponse>('/api/state')).body.state.language).toBe('en');
    expect((await eda.patch<SettingsResponse>('/api/settings', { language: 'es' })).body.language).toBe('es');
    expect((await api.get<StateResponse>('/api/state')).body.state.language).toBe('tr');
  });

  it('colors: they are normalized, change without touching the language, and null resets them', async () => {
    const { api } = fresh();
    await api.patch('/api/settings', { language: 'es' });
    const set = await api.patch<SettingsResponse>('/api/settings', { theme: { accent: '#2A6F97', header: ' #16202A ', background: '#ABC' } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ...DEFAULT_SETTINGS, theme: { accent: '#2a6f97', header: '#16202a', background: '#aabbcc' }, language: 'es' });
    expect((await api.get<StateResponse>('/api/state')).body.state.theme).toEqual(set.body.theme);

    // Only what is sent changes.
    expect((await api.patch<SettingsResponse>('/api/settings', { language: 'en' })).body).toEqual({ ...DEFAULT_SETTINGS, theme: set.body.theme });
    expect((await api.patch<SettingsResponse>('/api/settings', { theme: ocean, language: 'tr' })).body).toEqual({
      ...DEFAULT_SETTINGS,
      theme: ocean,
      language: 'tr',
    });

    const reset = await api.patch<SettingsResponse>('/api/settings', { theme: null });
    expect(reset.body).toEqual({ ...DEFAULT_SETTINGS, language: 'tr' });
    expect((await api.get<StateResponse>('/api/state')).body.state.theme).toBeNull();
  });

  it('the original palette is stored (and returned) as null', async () => {
    const { api, sqlite } = fresh();
    await api.patch('/api/settings', { theme: ocean });
    const r = await api.patch<SettingsResponse>('/api/settings', { theme: { accent: '#2F7D52', header: '#1d1f1c', background: '#efeee8' } });
    expect(r.body.theme).toBeNull();
    expect(sqlite.sqlite.prepare("SELECT value FROM settings WHERE user_id = 'frank' AND key = 'theme'").get()?.value).toBeNull();
  });

  it('currencies: main and second belong to each user; to swap them both go in the same request', async () => {
    const { api, eda } = await pair();
    const swapped = await api.patch<SettingsResponse>('/api/settings', { mainCurrency: 'USD', secondCurrency: 'DOP' });
    expect(swapped.status).toBe(200);
    expect(swapped.body).toEqual({ ...DEFAULT_SETTINGS, mainCurrency: 'USD', secondCurrency: 'DOP', defaultAccountId: 'dr' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect([state.mainCurrency, state.secondCurrency]).toEqual(['USD', 'DOP']);
    // Everything that is summarized now comes out in the new main currency.
    expect((await api.get<MonthSummary[]>('/api/months')).body[2]).toMatchObject({ main: 'USD' });
    expect((await eda.get<MonthSummary[]>('/api/months')).body[2]).toMatchObject({ main: 'DOP', budget: 70000 });

    // Just one, if it does not clash with the one they already have.
    expect((await api.patch<SettingsResponse>('/api/settings', { secondCurrency: 'TRY' })).body).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY' });
    expect((await api.patch<SettingsResponse>('/api/settings', { mainCurrency: 'DOP' })).body).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    expect((await eda.get<StateResponse>('/api/state')).body.state).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'USD' });
  });

  it('optional second currency: null or "none" remove it and it is stored without a migration; choosing another brings it back', async () => {
    const { api, eda } = await pair();
    for (const secondCurrency of [null, 'none']) {
      await api.patch('/api/settings', { secondCurrency: 'TRY' });
      const r = await api.patch<SettingsResponse>('/api/settings', { secondCurrency });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ mainCurrency: 'DOP', secondCurrency: null });
      expect((await api.get<StateResponse>('/api/state')).body.state.secondCurrency).toBeNull();
    }
    // Without a second one there is nothing to clash with: the main one can be any currency.
    expect((await api.patch<SettingsResponse>('/api/settings', { mainCurrency: 'USD' })).body).toMatchObject({ mainCurrency: 'USD', secondCurrency: null });
    // It is per user.
    expect((await eda.get<StateResponse>('/api/state')).body.state.secondCurrency).toBe('USD');
    expect((await api.patch<SettingsResponse>('/api/settings', { secondCurrency: 'DOP' })).body).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'DOP' });
  });

  it('equal currencies: 400, whether both are sent or only one that matches the other one already set', async () => {
    const { api } = await seeded();
    const same = { code: 'validation', message: 'Invalid data: secondCurrency: must be different from mainCurrency' };
    for (const body of [{ mainCurrency: 'USD' }, { secondCurrency: 'DOP' }, { mainCurrency: 'TRY', secondCurrency: 'TRY' }, { mainCurrency: 'USD', secondCurrency: 'USD' }]) {
      const r = await api.patch('/api/settings', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error, JSON.stringify(body)).toEqual(same);
    }
    // Nothing else that came with them is stored either.
    expect((await api.patch('/api/settings', { language: 'tr', mainCurrency: 'USD' })).status).toBe(400);
    expect((await api.get<StateResponse>('/api/state')).body.state).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'USD', language: 'en' });
  });

  it("default account: one of the user's accounts or null; one that does not exist or belongs to someone else, 400", async () => {
    const { api, eda } = await pair();
    await eda.post('/api/accounts', { id: 'solo-eda', name: 'Garanti', currency: 'TRY' });
    expect((await api.patch<SettingsResponse>('/api/settings', { defaultAccountId: 'us' })).body.defaultAccountId).toBe('us');
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBe('us');
    for (const id of ['no-existe', 'solo-eda']) {
      const r = await api.patch('/api/settings', { defaultAccountId: id });
      expect(r.status).toBe(400);
      expect(r.error).toEqual(unknownAccount(id));
    }
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBe('us');
    expect((await eda.patch<SettingsResponse>('/api/settings', { defaultAccountId: 'solo-eda' })).body.defaultAccountId).toBe('solo-eda');
    // null goes back to the automatic one.
    expect((await api.patch<SettingsResponse>('/api/settings', { defaultAccountId: null })).body.defaultAccountId).toBeNull();
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
  });

  it('an empty body, or one with unknown keys or invalid values: 400 and nothing changes', async () => {
    const { api } = fresh();
    await api.patch('/api/settings', { theme: ocean, language: 'es' });
    const bad: unknown[] = [
      {},
      { otra: 1 },
      { language: 'es', otra: 1 },
      { language: 'fr' },
      { language: 'ES' },
      { language: null },
      { language: 7 },
      { theme: 'dark' },
      { theme: {} },
      { theme: { accent: '#112233', header: '#000000' } },
      { theme: { ...ocean, accent: 'red' } },
      { theme: { ...ocean, background: '#12345' } },
      { theme: [ocean] },
      { mainCurrency: 'EUR' },
      { mainCurrency: 'usd' },
      { secondCurrency: 'none ' },
      { secondCurrency: 'XAU' },
      { defaultAccountId: '' },
      { defaultAccountId: 7 },
      { defaultRate: 60 },
      // A valid part is not stored if the other one is not valid.
      { language: 'tr', theme: 'dark' },
      { language: 'fr', theme: null },
      { language: 'tr', mainCurrency: 'EUR' },
      [],
      null,
      'es',
    ];
    for (const body of bad) {
      const r = await api.patch('/api/settings', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect((await api.patch('/api/settings', {})).error?.message).toBe(
      'Invalid data: nothing to change: send theme, language, mainCurrency, secondCurrency, defaultAccountId or goldPrice',
    );
    expect((await api.patch('/api/settings', { language: 'fr' })).error?.message).toBe('Invalid data: language: must be one of: en, es, tr');
    expect((await api.patch('/api/settings', { mainCurrency: 'EUR' })).error?.message).toBe('Invalid data: mainCurrency: must be DOP, USD or TRY');
    expect((await api.patch('/api/settings', { theme: 'dark' })).error?.message).toBe(
      'Invalid data: theme: must be null or the three colors accent, header and background as "#rrggbb"',
    );
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect([state.theme, state.language, state.mainCurrency, state.secondCurrency]).toEqual([ocean, 'es', 'DOP', 'USD']);
  });
});

describe('accounts', () => {
  it('list, create, rename, correct the opening balance, hide and delete', async () => {
    const { api } = fresh();
    // A user who has not opened the app yet has no accounts: their first visit creates them.
    expect((await api.get<Account[]>('/api/accounts')).body).toEqual([]);
    await api.get('/api/state');
    expect((await api.get<Account[]>('/api/accounts')).body).toEqual([...DEFAULT_ACCOUNTS]);

    const created = await api.post<Account>('/api/accounts', { name: '  PayPal ', currency: 'USD' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), name: 'PayPal', currency: 'USD', opening: 0, hidden: false, sort: 2 });
    const id = created.body.id;
    const tr = await api.post<Account>('/api/accounts', { id: 'tr', name: 'İş Bankası', currency: 'TRY', opening: -1250.5 });
    expect(tr.body).toEqual({ id: 'tr', name: 'İş Bankası', currency: 'TRY', opening: -1250.5, hidden: false, sort: 3 });

    const patched = await api.patch<Account>(`/api/accounts/${id}`, { name: 'PayPal USD', opening: 320.75, hidden: true, sort: 0 });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ id, name: 'PayPal USD', currency: 'USD', opening: 320.75, hidden: true, sort: 0 });
    expect((await api.patch<Account>(`/api/accounts/${id}`, { hidden: false })).body).toEqual({ ...patched.body, hidden: false });
    expect((await api.patch<Account>(`/api/accounts/${id}`, {})).body).toEqual({ ...patched.body, hidden: false });
    // With nothing using it, the currency can still be changed.
    expect((await api.patch<Account>(`/api/accounts/${id}`, { currency: 'DOP' })).body.currency).toBe('DOP');
    // GET /api/accounts and the state return all of them (the hidden ones too), in their order.
    await api.patch(`/api/accounts/tr`, { hidden: true });
    const listed = (await api.get<Account[]>('/api/accounts')).body;
    expect(listed.map((a) => [a.id, a.hidden])).toEqual([
      ['us', false],
      [id, false],
      ['dr', false],
      ['tr', true],
    ]);
    expect((await api.get<StateResponse>('/api/state')).body.state.accounts).toEqual(listed);

    expect((await api.del<OkResponse>(`/api/accounts/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/accounts/${id}`)).status).toBe(404);
    expect((await api.get<Account[]>('/api/accounts')).body.map((a) => a.id)).toEqual(['us', 'dr', 'tr']);
  });

  it('an account name is user data: it is stored as is, and it is unique ignoring case (409)', async () => {
    const { api, eda, sqlite } = await pair();
    const taken = { code: 'conflict', message: 'There is already an account with that name.' };
    for (const name of ['US account', 'us account', '  DR ACCOUNT  ']) {
      const r = await api.post('/api/accounts', { name, currency: 'TRY' });
      expect(r.status, name).toBe(409);
      expect(r.error).toEqual(taken);
    }
    expect((await api.post<Account>('/api/accounts', { id: 'ah', name: 'Ahorros en dólares 💵', currency: 'USD' })).body.name).toBe('Ahorros en dólares 💵');
    expect((await api.post('/api/accounts', { name: 'AHORROS EN DÓLARES 💵', currency: 'USD' })).status).toBe(409);
    const rename = await api.patch('/api/accounts/dr', { name: 'us ACCOUNT' });
    expect(rename.status).toBe(409);
    expect(rename.error).toEqual(taken);
    expect(count(sqlite, 'accounts', F)).toBe(3);
    // Rewriting its own name (or only changing its case) is not a conflict.
    expect((await api.patch<Account>('/api/accounts/dr', { name: 'DR ACCOUNT' })).body.name).toBe('DR ACCOUNT');
    // Once renamed, the previous name is free; and another person can have an account with the same name.
    expect((await api.patch<Account>('/api/accounts/us', { name: 'Chase' })).status).toBe(200);
    expect((await api.post('/api/accounts', { name: 'US account', currency: 'USD' })).status).toBe(201);
    expect((await eda.post('/api/accounts', { id: 'ah', name: 'Ahorros en dólares 💵', currency: 'DOP' })).status).toBe(201);
    // The client id, repeated: 409.
    expect((await api.post('/api/accounts', { id: 'ah', name: 'Otra', currency: 'USD' })).error).toEqual({
      code: 'conflict',
      message: 'A record with that id already exists.',
    });
  });

  it('the currency cannot be changed once the account has movements (409)', async () => {
    const { api } = await seeded();
    const r = await api.patch('/api/accounts/dr', { currency: 'USD' });
    expect(r.status).toBe(409);
    expect(r.error).toEqual({ code: 'conflict', message: 'The account is in use: its currency cannot be changed.' });
    expect((await api.patch('/api/accounts/us', { name: 'Chase', currency: 'TRY' })).status).toBe(409);
    expect((await api.get<Account[]>('/api/accounts')).body).toEqual([...SEED_ACCOUNTS]);
    // The one it already has can be "written", along with other changes.
    expect((await api.patch<Account>('/api/accounts/us', { name: 'Chase', currency: 'USD' })).body).toMatchObject({ name: 'Chase', currency: 'USD' });
  });

  it('an account that something uses cannot be deleted (409: hide it instead); neither can the last one', async () => {
    const { api } = await seeded();
    const inUse = { code: 'conflict', message: 'The account is in use: hide it instead of deleting it.' };
    for (const id of ['us', 'dr']) {
      const r = await api.del(`/api/accounts/${id}`);
      expect(r.status).toBe(409);
      expect(r.error).toEqual(inUse);
    }
    // A budget part, an income or a transfer is enough for it to be in use.
    await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' });
    await api.patch('/api/months/2026-10', { budgets: { pp: 10 } });
    expect((await api.del('/api/accounts/pp')).error).toEqual(inUse);
    // Setting the part to 0 is not enough: the budget log keeps its movements. They have to be deleted.
    const zeroed = await api.patch<Month>('/api/months/2026-10', { budgets: { pp: 0 } });
    expect((await api.del('/api/accounts/pp')).error).toEqual(inUse);
    for (const e of zeroed.body.budgetLog.filter((x) => x.accountId === 'pp')) {
      expect((await api.del(`/api/months/2026-10/budget-log/${e.id}`)).status).toBe(200);
    }
    const income = await api.post<Income>('/api/incomes', { date: '2026-10-07', amount: 1, cur: 'USD', accountId: 'pp' });
    expect((await api.del('/api/accounts/pp')).error).toEqual(inUse);
    await api.del(`/api/incomes/${income.body.id}`);
    const transfer = await api.post<Transfer>('/api/transfers', { monthKey: '2026-10', date: '2026-10-07', via: 'PayPal', fromAccountId: 'us', toAccountId: 'pp', amount: 1 });
    expect((await api.del('/api/accounts/pp')).error).toEqual(inUse);
    // Hiding it is allowed: it stops counting toward the total money, but it is still there.
    expect((await api.patch<Account>('/api/accounts/pp', { hidden: true })).body.hidden).toBe(true);
    await api.del(`/api/transfers/${transfer.body.id}`);
    expect((await api.del('/api/accounts/pp')).status).toBe(200);

    // The last one: a user always has at least one account.
    const lonely = fresh();
    await lonely.api.get('/api/state');
    expect((await lonely.api.del('/api/accounts/us')).status).toBe(200);
    const last = await lonely.api.del('/api/accounts/dr');
    expect(last.status).toBe(409);
    expect(last.error).toEqual({ code: 'conflict', message: 'The last account cannot be deleted: there must always be one.' });
    expect((await lonely.api.get<Account[]>('/api/accounts')).body.map((a) => a.id)).toEqual(['dr']);
  });

  it('deleting the default account leaves it on the automatic one', async () => {
    const { api } = fresh();
    await api.get('/api/state');
    await api.patch('/api/settings', { defaultAccountId: 'us' });
    expect((await api.del('/api/accounts/us')).status).toBe(200);
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
  });

  it('correcting a balance means adjusting the opening balance: the balance is neither sent nor stored', async () => {
    const { api } = await seeded();
    const before = await balance(api, 'dr');
    expect(before).toBeCloseTo(220641.93, 6);
    // For the account to show 200,000, the opening balance has to go down by the same amount that is in excess.
    const opening = 60000 + (200000 - before);
    expect((await api.patch<Account>('/api/accounts/dr', { opening })).body.opening).toBe(opening);
    expect(await balance(api, 'dr')).toBeCloseTo(200000, 6);
    expect((await api.patch('/api/accounts/dr', { balance: 200000 })).status).toBe(400);
  });

  it('validates and returns 404', async () => {
    const { api, sqlite } = await seeded();
    const bad: unknown[] = [
      {},
      { name: 'x' },
      { currency: 'USD' },
      { name: '', currency: 'USD' },
      { name: '   ', currency: 'USD' },
      { name: 'x'.repeat(121), currency: 'USD' },
      { name: 7, currency: 'USD' },
      { name: 'x', currency: 'EUR' },
      { name: 'x', currency: 'usd' },
      { name: 'x', currency: 'USD', opening: '10' },
      { name: 'x', currency: 'USD', opening: 1e13 },
      { name: 'x', currency: 'USD', hidden: true },
      { name: 'x', currency: 'USD', sort: 1 },
      { name: 'x', currency: 'USD', id: 'con espacios' },
      { name: 'x', currency: 'USD', balance: 5 },
    ];
    for (const body of bad) {
      const r = await api.post('/api/accounts', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect((await api.post('/api/accounts', { name: 'x'.repeat(120), currency: 'TRY' })).status).toBe(201);
    for (const body of [{ name: ' ' }, { name: 'x'.repeat(121) }, { currency: 'EUR' }, { opening: null }, { hidden: 'yes' }, { sort: -1 }, { sort: 1.5 }, { id: 'otra' }]) {
      expect((await api.patch('/api/accounts/us', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.patch('/api/accounts/no-existe', { name: 'x' })).error).toEqual({ code: 'not_found', message: 'Account not found.' });
    expect((await api.patch('/api/accounts/no-existe', {})).status).toBe(404);
    expect((await api.del('/api/accounts/no-existe')).status).toBe(404);
    expect(count(sqlite, 'accounts', F)).toBe(3);
  });
});

describe('months', () => {
  it('GET /api/months lists the summaries, in the main currency of the user', async () => {
    const { api } = await seeded();
    const r = await api.get<MonthSummary[]>('/api/months');
    expect(r.status).toBe(200);
    expect(r.body.map((m) => [m.key, m.closed, m.txCount, m.main])).toEqual([
      ['2026-08', true, 10, 'DOP'],
      ['2026-09', true, 10, 'DOP'],
      ['2026-10', false, 7, 'DOP'],
    ]);
    expect(r.body[2]).toEqual({ key: '2026-10', closed: false, closedAt: null, main: 'DOP', budget: 70000, used: expect.any(Number), txCount: 7 });
    // October: 6 paid fixed expenses (Claude in USD at 58.76) + 7 transactions.
    expect(r.body[2]!.used).toBeCloseTo(1337.15 + 2699 + 5640 + 15000 + 106 * 58.76 + 7400 + 10845, 6);
  });

  it('GET /api/months/:key returns the whole month; 404 if it does not exist or the key is not a month', async () => {
    const { api } = await seeded();
    const r = await api.get<Month>('/api/months/2026-10');
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('2026-10');
    expect(r.body.budgets).toEqual({ dr: 70000 });
    expect(r.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
    expect(r.body.budgetLog.map(({ id: _id, ...e }) => e)).toEqual([
      { date: '2026-10-01', accountId: 'dr', amount: 65000, kind: 'initial', note: '' },
      { date: '2026-10-05', accountId: 'dr', amount: 5000, kind: 'adjust', note: 'Car repair' },
    ]);
    expect(r.body.fixed).toHaveLength(11);
    expect(r.body.transfers).toHaveLength(1);
    expect(r.body.tx).toHaveLength(7);

    for (const path of ['/api/months/2031-01', '/api/months/october', '/api/months/2026-13']) {
      const miss = await api.get(path);
      expect(miss.status).toBe(404);
      expect(miss.error?.code).toBe('not_found');
    }
    expect((await api.get('/api/months/2031-01')).error?.message).toBe('Month 2031-01 does not exist.');
  });

  it('PATCH /api/months/:key changes the budget parts that are sent; 0 removes the part', async () => {
    const { api } = await seeded();
    const r = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 58248.5, us: 200 } });
    expect(r.status).toBe(200);
    expect(r.body.budgets).toEqual({ dr: 58248.5, us: 200 });
    expect(r.body.fixed).toHaveLength(11);
    // The total is the sum converted to the main currency: 58,248.50 + 200 USD at 58.76.
    expect((await api.get<MonthSummary[]>('/api/months')).body[2]!.budget).toBeCloseTo(58248.5 + 200 * 58.76, 8);

    // The accounts that are not sent keep their part.
    const one = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 0 } });
    expect(one.body.budgets).toEqual({ us: 200 });
    // An empty patch returns the month unchanged.
    expect((await api.patch<Month>('/api/months/2026-10', {})).body).toEqual(one.body);
    expect((await api.patch<Month>('/api/months/2026-10', { budgets: {} })).body).toEqual(one.body);
    expect((await api.patch<Month>('/api/months/2026-10', { budgets: { us: 0 } })).body.budgets).toEqual({});
  });

  it('PATCH /api/months/:key validates, requires the account to exist and returns 404 if the month does not exist', async () => {
    const { api } = await seeded();
    const bad: unknown[] = [
      { budgets: { dr: -1 } },
      { budgets: { dr: '70000' } },
      { budgets: { dr: null } },
      { budgets: { dr: 1e13 } },
      { budgets: 70000 },
      { budgets: [70000] },
      { budgets: { 'con espacios': 1 } },
      // The previous format (a single budget, the income and the balances of the month) no longer exists.
      { budget: 70000 },
      { incomeUSD: 5800 },
      { accUSD: 1 },
      { otra: 1 },
      [],
      'x',
      null,
    ];
    for (const body of bad) {
      const r = await api.patch('/api/months/2026-10', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    // An account that does not exist: 400, and no part is applied.
    const unknown = await api.patch('/api/months/2026-10', { budgets: { us: 5, 'no-existe': 10 } });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toEqual(unknownAccount('no-existe'));
    expect((await api.get<Month>('/api/months/2026-10')).body.budgets).toEqual({ dr: 70000 });
    expect((await api.patch('/api/months/2031-01', { budgets: { dr: 1 } })).status).toBe(404);
    expect((await api.patch('/api/months/2031-01', {})).status).toBe(404);
  });
});

describe('month rates', () => {
  it('PUT /api/months/:key/rates sets the rate of a pair from a date on: one per pair and date, also when it arrives reversed', async () => {
    const { api, sqlite } = await seeded();
    // October already has two (day 1 and day 6). Typing the day 6 one again replaces it.
    const r = await api.put<Month>('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-06' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('2026-10');
    expect(r.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-06' },
    ]);
    expect(r.body.fixed).toHaveLength(11);

    // Typing DOP → USD replaces the USD → DOP one of that date: it is the same pair.
    const inverse = await api.put<Month>('/api/months/2026-10/rates', { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' });
    expect(inverse.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
    ]);
    // Another date of the same pair is added; so is another pair.
    await api.put<Month>('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    const third = await api.put<Month>('/api/months/2026-10/rates', { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-02' });
    expect(third.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-02' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' },
    ]);
    expect(count(sqlite, 'month_rates', F)).toBe(4);
    // The month rate is the last one; what belongs to each day uses the rate in effect that day.
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').rate).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-08' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-07')).toEqual({ rate: 1 / 0.0168, source: 'month', monthKey: '2026-10', date: '2026-10-06' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-05').rate).toBe(58.76);
    // A month with no typed rate accepts one too (September, reopened).
    await api.post('/api/months/2026-09/reopen');
    expect((await api.put<Month>('/api/months/2026-09/rates', { from: 'USD', to: 'DOP', rate: 58.6, date: '2026-09-15' })).body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.6, date: '2026-09-15' },
    ]);
  });

  it('typing a new rate today does not change what was converted in earlier transactions', async () => {
    const { api } = await seeded();
    // Two 10 USD expenses paid from the DOP account: on day 2 and on day 8.
    const usd = { monthKey: '2026-10', desc: 'Domain', cat: 'Subscriptions', method: 'Debit card', amount: 10, cur: 'USD', accountId: 'dr' };
    await api.post('/api/transactions', { ...usd, id: 'early', date: '2026-10-02' });
    const before = (await api.get<StateResponse>('/api/state')).body.state;
    expect(monthCalc(before, '2026-10').varSpent).toBeCloseTo(10845 + 587.6, 8);
    const drBefore = await balance(api, 'dr');
    expect(drBefore).toBeCloseTo(220641.93 - 587.6, 6);

    // On day 8, 60 is typed.
    expect((await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' })).status).toBe(200);
    const after = (await api.get<StateResponse>('/api/state')).body.state;
    // The day 2 expense is still worth 587.60 in the month and in the account balance.
    expect(monthCalc(after, '2026-10').varSpent).toBeCloseTo(10845 + 587.6, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(drBefore, 8);
    // One on day 8 already goes at 60.
    await api.post('/api/transactions', { ...usd, id: 'late', date: '2026-10-08' });
    expect(monthCalc((await api.get<StateResponse>('/api/state')).body.state, '2026-10').varSpent).toBeCloseTo(10845 + 587.6 + 600, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(drBefore - 600, 8);
    // What belongs to the whole month does follow the last one: the month rate and the fixed expense in USD.
    expect(monthCalc(after, '2026-10').rate!.rate).toBe(60);
    expect(monthCalc(after, '2026-10').fixedPaid).toBeCloseTo(32076.15 + 106 * 60, 6);
  });

  it('DELETE /api/months/:key/rates/:from/:to?date= removes the one of that date, whether it is stored in one direction or the other', async () => {
    const { api, sqlite } = await seeded();
    // October has them typed as USD → DOP; the request is reversed. Only the one of the requested date goes away.
    const one = await api.del<Month>('/api/months/2026-10/rates/DOP/USD?date=2026-10-06');
    expect(one.status).toBe(200);
    expect(one.body.key).toBe('2026-10');
    expect(one.body.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    const r = await api.del<Month>('/api/months/2026-10/rates/USD/DOP?date=2026-10-01');
    expect(r.body.rates).toEqual([]);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    // With no typed rate, the app derives it from the month's transfers (here, the same figure).
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').rate).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    // Removing the one of a pair or a date that has no typed rate is not an error: the month stays the same.
    expect((await api.del<Month>('/api/months/2026-10/rates/USD/DOP?date=2026-10-01')).body).toEqual(r.body);
    expect((await api.del<Month>('/api/months/2026-10/rates/TRY/USD?date=2026-10-03')).status).toBe(200);
    // Without a date (or with one that is not a date) there is no telling which one to remove: 400.
    for (const path of ['/api/months/2026-10/rates/USD/DOP', '/api/months/2026-10/rates/USD/DOP?date=', '/api/months/2026-10/rates/USD/DOP?date=2026-10', '/api/months/2026-10/rates/USD/DOP?date=2026-02-30']) {
      const bad = await api.del(path);
      expect(bad.status, path).toBe(400);
      expect(bad.error?.code, path).toBe('validation');
    }
    expect((await api.del('/api/months/2026-10/rates/USD/DOP')).error?.message).toBe('Invalid data: date: is required');
  });

  it('validates the pair and the rate, and returns 404 if the month does not exist', async () => {
    const { api } = await seeded();
    const bad: unknown[] = [
      {},
      { from: 'USD', to: 'DOP', date: '2026-10-08' },
      { from: 'USD', to: 'DOP', rate: 0, date: '2026-10-08' },
      { from: 'USD', to: 'DOP', rate: -58, date: '2026-10-08' },
      { from: 'USD', to: 'DOP', rate: '58.76', date: '2026-10-08' },
      { from: 'USD', to: 'USD', rate: 1, date: '2026-10-08' },
      { from: 'USD', to: 'EUR', rate: 1, date: '2026-10-08' },
      { from: 'usd', to: 'DOP', rate: 58, date: '2026-10-08' },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-08', monthKey: '2026-10' },
      [{ from: 'USD', to: 'DOP', rate: 58, date: '2026-10-08' }],
      null,
      // The date: required, a real date and within the month of the route.
      { from: 'USD', to: 'DOP', rate: 58 },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10' },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-32' },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-09-30' },
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-11-01' },
    ];
    for (const body of bad) {
      const r = await api.put('/api/months/2026-10/rates', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect((await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'USD', rate: 1, date: '2026-10-06' })).error?.message).toBe(
      'Invalid data: to: must be different from `from`',
    );
    expect((await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 58, date: '2026-11-01' })).error?.message).toBe(
      'Invalid data: date: must be a date in 2026-10',
    );
    for (const path of ['/api/months/2026-10/rates/USD/USD?date=2026-10-01', '/api/months/2026-10/rates/USD/EUR?date=2026-10-01', '/api/months/2026-10/rates/usd/dop?date=2026-10-01']) {
      const r = await api.del(path);
      expect(r.status, path).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect((await api.get<Month>('/api/months/2026-10')).body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);
    expect((await api.put('/api/months/2031-01/rates', { from: 'USD', to: 'DOP', rate: 58, date: '2031-01-01' })).error).toEqual({
      code: 'not_found',
      message: 'Month 2031-01 does not exist.',
    });
    expect((await api.del('/api/months/2031-01/rates/USD/DOP?date=2031-01-01')).status).toBe(404);
    expect((await api.put('/api/months/nada/rates', { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' })).status).toBe(404);
    // Only those two routes exist.
    expect((await api.get('/api/months/2026-10/rates')).status).toBe(404);
    expect((await api.del('/api/months/2026-10/rates/USD')).status).toBe(404);
  });
});

describe('delete a month', () => {
  it('DELETE /api/months/:key deletes the month with everything in it, open or closed, and the balances change accordingly', async () => {
    const { api, sqlite } = await seeded();
    expect(await balance(api, 'us')).toBeCloseTo(13482, 8);
    // September is closed.
    const r = await api.del<OkResponse>('/api/months/2026-09');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await api.get('/api/months/2026-09')).status).toBe(404);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.key)).toEqual(['2026-08', '2026-10']);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(22);
    expect(count(sqlite, 'transactions', F)).toBe(17);
    expect(count(sqlite, 'transfers', F)).toBe(3);
    expect(count(sqlite, 'month_budget_log', F)).toBe(3);
    // Its transfers (2,300 USD) and its Claude (106 USD) no longer count; the September salary does: it is an income.
    expect(await balance(api, 'us')).toBeCloseTo(13482 + 2300 + 106, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(60000 + 104730 + 88140 - 27850 - 10845 - 35750.26 - 32076.15, 6);
    expect((await api.get<Income[]>('/api/incomes')).body).toHaveLength(3);
    expect((await api.get<Contribution[]>('/api/contributions')).body).toHaveLength(8);

    // October is open and has a typed rate.
    expect((await api.del('/api/months/2026-10')).status).toBe(200);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    expect(count(sqlite, 'transactions', F)).toBe(10);
  });

  it('404 if the month does not exist or the key is not a month', async () => {
    const { api, sqlite } = await seeded();
    for (const path of ['/api/months/2031-01', '/api/months/october', '/api/months/2026-13']) {
      const r = await api.del(path);
      expect(r.status, path).toBe(404);
      expect(r.error?.code).toBe('not_found');
    }
    await api.del('/api/months/2026-10');
    expect((await api.del('/api/months/2026-10')).error).toEqual({ code: 'not_found', message: 'Month 2026-10 does not exist.' });
    expect(count(sqlite, 'months', F)).toBe(2);
  });
});

describe('close and reopen', () => {
  it('closing creates the next month with the fixed expenses unpaid (with their account) and the same budget parts; the rates are not copied', async () => {
    const { api, sqlite } = await seeded();
    await api.patch('/api/months/2026-10', { budgets: { us: 150 } });
    const october = (await api.get<Month>('/api/months/2026-10')).body;
    const r = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(r.status).toBe(200);

    const { closed, next } = r.body;
    expect(closed.key).toBe('2026-10');
    expect(closed.closed).toBe(true);
    expect(Date.parse(closed.closedAt!)).toBeGreaterThan(Date.now() - 60_000);
    // The closed month keeps everything it had.
    expect({ ...closed, closed: false, closedAt: null }).toEqual(october);

    expect(next).toMatchObject({
      key: '2026-11',
      closed: false,
      closedAt: null,
      budgets: { dr: 70000, us: 150 },
      rates: [],
      transfers: [],
      tx: [],
    });
    expect(october.rates).toHaveLength(2);
    // The new month's budget starts with one initial movement per account, dated day 1.
    expect(next.budgetLog.map(({ id: _id, ...e }) => e)).toEqual([
      { date: '2026-11-01', accountId: 'dr', amount: 70000, kind: 'initial', note: '' },
      { date: '2026-11-01', accountId: 'us', amount: 150, kind: 'initial', note: '' },
    ]);
    expect(next.fixed.map((f) => [f.name, f.day, f.amount, f.cur, f.accountId, f.sort, f.paid, f.monthKey])).toEqual(
      october.fixed.map((f) => [f.name, f.day, f.amount, f.cur, f.accountId, f.sort, false, '2026-11']),
    );
    expect(new Set([...next.fixed, ...october.fixed].map((f) => f.id)).size).toBe(22);
    expect(count(sqlite, 'months', F)).toBe(4);
    expect((await api.get<Month>('/api/months/2026-11')).body).toEqual(next);
    // Closing moves no balance: the new month's fixed expenses start out unpaid.
    expect(await balance(api, 'dr', '2026-11')).toBeCloseTo(220641.93, 6);
    // And with no rate of its own, the last typed one is still in effect in November.
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-11').rate).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('if the next month already exists, closing does not touch it or duplicate its fixed expenses', async () => {
    const { api, sqlite } = await seeded();
    await api.post('/api/months/2026-10/close');
    await api.post('/api/months/2026-10/reopen');

    // November already has a life of its own.
    const nov = (await api.get<Month>('/api/months/2026-11')).body;
    await api.patch(`/api/fixed/${nov.fixed[0]!.id}`, { paid: true, amount: 1400 });
    await api.del(`/api/fixed/${nov.fixed[10]!.id}`);
    await api.post('/api/transactions', { monthKey: '2026-11', date: '2026-11-01', desc: 'Coffee', cat: 'Food', method: 'Debit card', amount: 200, cur: 'DOP' });
    await api.patch('/api/months/2026-11', { budgets: { dr: 80000 } });
    await api.put('/api/months/2026-11/rates', { from: 'USD', to: 'DOP', rate: 59, date: '2026-11-01' });
    const before = (await api.get<Month>('/api/months/2026-11')).body;

    const r = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(r.status).toBe(200);
    expect(r.body.closed.closed).toBe(true);
    expect(r.body.next).toEqual(before);
    expect(r.body.next.fixed).toHaveLength(10);
    expect(count(sqlite, 'months', F)).toBe(4);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33 + 10);
  });

  it('closing an already closed month changes nothing (a retry does not fail)', async () => {
    const { api, sqlite } = await seeded();
    const first = await api.post<CloseResponse>('/api/months/2026-10/close');
    const again = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(44);
  });

  it('reopening makes the month editable again', async () => {
    const { api } = await seeded();
    const r = await api.post<Month>('/api/months/2026-08/reopen');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: '2026-08', closed: false, closedAt: null });
    expect(r.body.tx).toHaveLength(10);
    expect((await api.patch('/api/fixed/seed-fx-2026-08-1', { paid: false })).status).toBe(200);
  });

  it('404 if the month does not exist', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/months/2031-01/close')).error?.code).toBe('not_found');
    expect((await api.post('/api/months/2031-01/reopen')).error?.code).toBe('not_found');
    expect((await api.post('/api/months/nada/close')).status).toBe(404);
  });
});

describe('fixed expenses', () => {
  it('create, edit and delete', async () => {
    const { api } = await seeded();
    const created = await api.post<FixedExpense>('/api/fixed', { monthKey: '2026-10', name: '  Spotify ', amount: 9.99, cur: 'USD' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      monthKey: '2026-10',
      name: 'Spotify',
      day: '',
      amount: 9.99,
      cur: 'USD',
      paid: false,
      // Without `accountId` it is paid from the user's default account, whatever the currency of the expense.
      accountId: 'dr',
      sort: 11,
    });
    const id = created.body.id;

    const patched = await api.patch<FixedExpense>(`/api/fixed/${id}`, {
      name: 'Spotify Duo',
      day: ' 12 ',
      amount: 0,
      cur: 'TRY',
      paid: true,
      accountId: 'us',
      sort: 3,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ id, monthKey: '2026-10', name: 'Spotify Duo', day: '12', amount: 0, cur: 'TRY', paid: true, accountId: 'us', sort: 3 });
    expect((await api.patch<FixedExpense>(`/api/fixed/${id}`, { paid: false })).body).toEqual({ ...patched.body, paid: false });
    expect((await api.patch<FixedExpense>(`/api/fixed/${id}`, {})).body).toEqual({ ...patched.body, paid: false });

    const del = await api.del<OkResponse>(`/api/fixed/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect((await api.del(`/api/fixed/${id}`)).status).toBe(404);
    expect((await api.get<Month>('/api/months/2026-10')).body.fixed).toHaveLength(11);
  });

  it('accepts the client id and rejects a repeated one with 409', async () => {
    const { api } = await seeded();
    const body = { id: 'fx_cliente-1', monthKey: '2026-10', name: 'Agua', day: '3', amount: 500, cur: 'DOP', paid: true, accountId: 'us' };
    const r = await api.post<FixedExpense>('/api/fixed', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'fx_cliente-1', day: '3', paid: true, accountId: 'us' });
    const dup = await api.post('/api/fixed', body);
    expect(dup.status).toBe(409);
    expect(dup.error).toEqual({ code: 'conflict', message: 'A record with that id already exists.' });
  });

  it('validates the body', async () => {
    const { api, sqlite } = await seeded();
    const ok = { monthKey: '2026-10', name: 'Agua', amount: 500, cur: 'DOP' };
    const bad: unknown[] = [
      { ...ok, amount: 0 },
      { ...ok, amount: -5 },
      { ...ok, amount: '500' },
      { ...ok, name: '   ' },
      { ...ok, name: 'x'.repeat(121) },
      { ...ok, cur: 'EUR' },
      { ...ok, cur: 'try' },
      { ...ok, accountId: '' },
      { ...ok, accountId: null },
      { ...ok, accountId: 'con espacios' },
      { ...ok, monthKey: '2026-13' },
      { ...ok, monthKey: undefined },
      { ...ok, id: 'con espacios' },
      { ...ok, id: 'x'.repeat(65) },
      { ...ok, paid: 1 },
      { ...ok, sort: 2 },
      { ...ok, extra: true },
      // The user goes in the header, not in the body.
      { ...ok, user: 'eda' },
    ];
    for (const body of bad) {
      const r = await api.post('/api/fixed', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    for (const body of [{ amount: -1 }, { name: '' }, { sort: 1.5 }, { cur: 'usd' }, { monthKey: '2026-09' }, { id: 'otro' }, { accountId: '' }]) {
      expect((await api.patch('/api/fixed/seed-fx-2026-10-1', body)).status, JSON.stringify(body)).toBe(400);
    }
    // The account has to be one of the user's, on create and on edit.
    expect((await api.post('/api/fixed', { ...ok, accountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    const moved = await api.patch('/api/fixed/seed-fx-2026-10-1', { accountId: 'no-existe', paid: false });
    expect(moved.status).toBe(400);
    expect(moved.error).toEqual(unknownAccount('no-existe'));
    expect((await api.get<Month>('/api/months/2026-10')).body.fixed[0]).toMatchObject({ paid: true, accountId: 'dr' });
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('a fixed expense is subtracted from its account only while it is marked as paid', async () => {
    const { api } = await seeded();
    const dr = await balance(api, 'dr');
    // Netflix: 1,137.30 DOP, unpaid in October.
    const netflix = (await api.get<Month>('/api/months/2026-10')).body.fixed.find((f) => f.name === 'Netflix')!;
    expect(netflix).toMatchObject({ paid: false, accountId: 'dr' });
    await api.patch(`/api/fixed/${netflix.id}`, { paid: true });
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 1137.3, 6);
    await api.patch(`/api/fixed/${netflix.id}`, { paid: false });
    expect(await balance(api, 'dr')).toBeCloseTo(dr, 6);
  });

  it('404 if the month or the fixed expense does not exist', async () => {
    const { api } = await seeded();
    const noMonth = await api.post('/api/fixed', { monthKey: '2031-01', name: 'Agua', amount: 500, cur: 'DOP' });
    expect(noMonth.status).toBe(404);
    expect(noMonth.error?.code).toBe('not_found');
    expect((await api.patch('/api/fixed/no-existe', { paid: true })).error).toEqual({ code: 'not_found', message: 'Monthly expense not found.' });
    expect((await api.patch('/api/fixed/no-existe', {})).status).toBe(404);
    expect((await api.del('/api/fixed/no-existe')).status).toBe(404);
  });
});

describe('transactions', () => {
  const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Debit card', amount: 850, cur: 'DOP' };

  it('create, edit and delete', async () => {
    const { api } = await seeded();
    const created = await api.post<Transaction>('/api/transactions', { ...tx, place: ' Uber ', notes: ' al trabajo ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      monthKey: '2026-10',
      date: '2026-10-07',
      desc: 'Uber',
      place: 'Uber',
      cat: 'Transport',
      method: 'Debit card',
      amount: 850,
      cur: 'DOP',
      accountId: 'dr',
      notes: 'al trabajo',
      source: 'web',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const id = created.body.id;

    // Category and method are free text: whatever is not in the lists is stored as is, untranslated.
    const patched = await api.patch<Transaction>(`/api/transactions/${id}`, {
      date: '2026-10-06',
      desc: 'Taxi',
      place: '',
      cat: 'Otra categoría',
      method: 'Efectivo',
      amount: 15.5,
      cur: 'USD',
      accountId: 'us',
      notes: '',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({
      ...created.body,
      date: '2026-10-06',
      desc: 'Taxi',
      place: '',
      cat: 'Otra categoría',
      method: 'Efectivo',
      amount: 15.5,
      cur: 'USD',
      accountId: 'us',
      notes: '',
    });

    expect((await api.del<OkResponse>(`/api/transactions/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/transactions/${id}`)).status).toBe(404);
  });

  it('the optional fields stay empty; the date can be in another month', async () => {
    const { api } = await seeded();
    const r = await api.post<Transaction>('/api/transactions', { ...tx, date: '2026-11-01' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ monthKey: '2026-10', date: '2026-11-01', place: '', notes: '', accountId: 'dr' });
  });

  it('it comes out of the given account (or the default one) and is subtracted from it, converted to the account currency', async () => {
    const { api } = await seeded();
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];
    // 850 DOP from the default account ('dr').
    await api.post('/api/transactions', tx);
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 850, 6);
    // 1,000 TRY paid from the USD account: with no typed rate for TRY, the default rate applies (42 per USD).
    const lira = await api.post<Transaction>('/api/transactions', { ...tx, amount: 1000, cur: 'TRY', accountId: 'us' });
    expect(lira.body).toMatchObject({ amount: 1000, cur: 'TRY', accountId: 'us' });
    expect(await balance(api, 'us')).toBeCloseTo(us - 1000 / 42, 6);
    // Switching its account moves the expense from one balance to the other.
    await api.patch(`/api/transactions/${lira.body.id}`, { accountId: 'dr' });
    expect(await balance(api, 'us')).toBeCloseTo(us, 6);
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 850 - (1000 * 58.76) / 42, 6);
    // If the user changes their default account, what comes next is paid from it.
    await api.patch('/api/settings', { defaultAccountId: 'us' });
    expect((await api.post<Transaction>('/api/transactions', tx)).body.accountId).toBe('us');
  });

  it('accepts the client id and rejects a repeated one with 409', async () => {
    const { api } = await seeded();
    expect((await api.post<Transaction>('/api/transactions', { ...tx, id: 'tx-optimista' })).body.id).toBe('tx-optimista');
    const dup = await api.post('/api/transactions', { ...tx, id: 'tx-optimista' });
    expect(dup.status).toBe(409);
    expect(dup.error?.code).toBe('conflict');
    // Also against an id that already existed.
    expect((await api.post('/api/transactions', { ...tx, id: 'seed-tx-2026-08-1' })).status).toBe(409);
  });

  it('validates the body', async () => {
    const { api, sqlite } = await seeded();
    const bad: unknown[] = [
      { ...tx, amount: 0 },
      { ...tx, desc: ' ' },
      { ...tx, desc: undefined },
      { ...tx, date: '2026-02-30' },
      { ...tx, date: '07/10/2026' },
      { ...tx, cat: '' },
      { ...tx, method: undefined },
      { ...tx, cur: 'EUR' },
      { ...tx, accountId: 'con espacios' },
      { ...tx, account: 'dr' },
      { ...tx, notes: 'x'.repeat(1001) },
      { ...tx, source: 'claude' },
      { ...tx, createdAt: '2026-01-01' },
    ];
    for (const body of bad) {
      const r = await api.post('/api/transactions', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    for (const body of [{ amount: -1 }, { desc: '' }, { date: 'ayer' }, { monthKey: '2026-09' }, { source: 'web' }, { accountId: null }]) {
      expect((await api.patch('/api/transactions/seed-tx-2026-10-1', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.post('/api/transactions', { ...tx, accountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    expect((await api.patch('/api/transactions/seed-tx-2026-10-1', { accountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('a non-finite amount is rejected (JSON accepts 1e999)', async () => {
    const { api } = await seeded();
    const res = await api.raw('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx).replace('850', '1e999'),
    });
    expect(res.status).toBe(400);
  });

  it('404 if the month or the transaction does not exist', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/transactions', { ...tx, monthKey: '2031-01' })).error?.code).toBe('not_found');
    expect((await api.patch('/api/transactions/no-existe', { amount: 1 })).error).toEqual({ code: 'not_found', message: 'Transaction not found.' });
    expect((await api.del('/api/transactions/no-existe')).status).toBe(404);
  });
});

describe('transfers', () => {
  const transfer = { monthKey: '2026-10', date: '2026-10-05', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 300, rate: 57.9 };

  it('create, edit and delete', async () => {
    const { api } = await seeded();
    const created = await api.post<Transfer>('/api/transfers', transfer);
    expect(created.status).toBe(201);
    // Without `budget` the transfer moves no budget; without `fee`, it carries no fee.
    expect(created.body).toEqual({ id: expect.any(String), ...transfer, budget: false, fee: 0 });
    const id = created.body.id;

    const patched = await api.patch<Transfer>(`/api/transfers/${id}`, { date: '2026-10-06', via: 'Remitly', amount: 350.5, rate: 58.1 });
    expect(patched.body).toEqual({ ...transfer, id, date: '2026-10-06', via: 'Remitly', amount: 350.5, rate: 58.1, budget: false, fee: 0 });
    // The accounts too: in the opposite direction, with its rate.
    const reversed = await api.patch<Transfer>(`/api/transfers/${id}`, { fromAccountId: 'dr', toAccountId: 'us', amount: 5810, rate: 1 / 58.1 });
    expect(reversed.body).toEqual({ ...patched.body, fromAccountId: 'dr', toAccountId: 'us', amount: 5810, rate: 1 / 58.1 });
    expect((await api.patch<Transfer>(`/api/transfers/${id}`, {})).body).toEqual(reversed.body);

    expect((await api.del<OkResponse>(`/api/transfers/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/transfers/${id}`)).status).toBe(404);
  });

  it('moves both balances: the amount leaves the origin account and amount × rate enters the destination account', async () => {
    const { api } = await seeded();
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];
    const created = await api.post<Transfer>('/api/transfers', transfer);
    expect(await balance(api, 'us')).toBeCloseTo(us - 300, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(dr + 300 * 57.9, 6);
    await api.patch(`/api/transfers/${created.body.id}`, { amount: 100 });
    expect(await balance(api, 'us')).toBeCloseTo(us - 100, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(dr + 5790, 6);
    await api.del(`/api/transfers/${created.body.id}`);
    expect([await balance(api, 'us'), await balance(api, 'dr')]).toEqual([us, dr]);
  });

  it('without `rate` it takes the rate in effect on its date for the currencies of the two accounts; between accounts of the same currency, 1', async () => {
    const { api } = await seeded();
    const { rate: _rate, ...noRate } = transfer;
    // October has 1 USD = 58.76 DOP typed.
    expect((await api.post<Transfer>('/api/transfers', noRate)).body.rate).toBe(58.76);
    const back = await api.post<Transfer>('/api/transfers', { ...noRate, fromAccountId: 'dr', toAccountId: 'us' });
    expect(back.body.rate).toBeCloseTo(1 / 58.76, 12);
    // 60 is typed from day 6 on: a transfer on day 5 stays at 58.76; one on day 6, at 60.
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' });
    expect((await api.post<Transfer>('/api/transfers', noRate)).body.rate).toBe(58.76);
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, date: '2026-10-06' })).body.rate).toBe(60);

    await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, toAccountId: 'pp' })).body.rate).toBe(1);
    // The one that is sent is respected, even if it is not the month's.
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, toAccountId: 'pp', rate: 0.97 })).body.rate).toBe(0.97);
  });

  it('`fee`: it is stored and edited with the transfer, it is subtracted from the origin account and a negative one answers 400', async () => {
    const { api } = await seeded();
    const us = await balance(api, 'us');
    const created = await api.post<Transfer>('/api/transfers', { ...transfer, fee: 2.99 });
    expect(created.status).toBe(201);
    expect(created.body.fee).toBe(2.99);
    expect(await balance(api, 'us')).toBeCloseTo(us - 300 - 2.99, 8);
    const patched = await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { fee: 0 });
    expect(patched.body).toEqual({ ...created.body, fee: 0 });
    expect(await balance(api, 'us')).toBeCloseTo(us - 300, 8);
    expect((await api.post('/api/transfers', { ...transfer, fee: -1 })).status).toBe(400);
    expect((await api.patch(`/api/transfers/${created.body.id}`, { fee: -1 })).status).toBe(400);
    expect((await api.patch(`/api/transfers/${created.body.id}`, { fee: null })).status).toBe(400);
  });

  it('with `budget: true` it moves month budget from the origin account to the destination one, without writing to the budget log or changing the balances', async () => {
    const { api, db } = await seeded();
    const budget = async () => monthCalc(await loadState(db, FRANK.id), '2026-10').budget;
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];

    // 300 USD at 57.9: +17,370 DOP in the DR account and −300 USD (17,628 DOP at the month rate, 58.76) in the US account.
    const moved = 17370 - 300 * 58.76;
    const created = await api.post<Transfer>('/api/transfers', { ...transfer, budget: true });
    expect(created.status).toBe(201);
    expect(created.body.budget).toBe(true);
    expect(await budget()).toBeCloseTo(70000 + moved, 8);
    const parts = monthCalc(await loadState(db, FRANK.id), '2026-10').budgetParts.map((p) => [p.account.id, p.amount, p.fromTransfers]);
    expect(parts).toEqual([
      ['us', -300, -300],
      ['dr', 87370, 17370],
    ]);
    const month = (await api.get<Month>('/api/months/2026-10')).body;
    expect(month.budgetLog).toHaveLength(2);
    expect(month.budgets).toEqual({ dr: 70000 });
    expect(month.transfers.at(-1)).toEqual(created.body);
    // The balances move as with any transfer.
    expect(await balance(api, 'us')).toBeCloseTo(us - 300, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(dr + 17370, 6);

    // PATCH { budgets } sets what the budget log adds up to: the transfer's share is kept apart, like an income's.
    const patched = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 72000 } });
    expect(patched.body.budgets).toEqual({ dr: 72000 });
    expect(await budget()).toBeCloseTo(72000 + moved, 8);

    // The checkbox is cleared and set with PATCH; the rest of the row does not change.
    const off = await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { budget: false });
    expect(off.body).toEqual({ ...created.body, budget: false });
    expect(await budget()).toBe(72000);
    expect((await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { budget: true })).body.budget).toBe(true);
    expect((await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { amount: 100 })).body.budget).toBe(true);
    expect(await budget()).toBeCloseTo(72000 + 5790 - 100 * 58.76, 8);

    for (const bad of ['yes', 1, null]) {
      expect((await api.post('/api/transfers', { ...transfer, budget: bad })).status, String(bad)).toBe(400);
      expect((await api.patch(`/api/transfers/${created.body.id}`, { budget: bad })).status, String(bad)).toBe(400);
    }
  });

  it('the via is free text: Remitly and PayPal are only suggestions', async () => {
    const { api } = await seeded();
    const created = await api.post<Transfer>('/api/transfers', { ...transfer, via: '  Western Union ' });
    expect(created.status).toBe(201);
    expect(created.body.via).toBe('Western Union');
    expect((await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { via: 'Banco Popular (ventanilla)' })).body.via).toBe(
      'Banco Popular (ventanilla)',
    );
    // The only requirement is that it is not empty and does not exceed 60 characters.
    expect((await api.post('/api/transfers', { ...transfer, via: 'x'.repeat(61) })).status).toBe(400);
    expect((await api.post('/api/transfers', { ...transfer, via: 'x'.repeat(60) })).status).toBe(201);
  });

  it('two different accounts, and both must exist', async () => {
    const { api, sqlite } = await seeded();
    const same = { code: 'validation', message: 'Invalid data: toAccountId: must be different from fromAccountId' };
    const r = await api.post('/api/transfers', { ...transfer, toAccountId: 'us' });
    expect(r.status).toBe(400);
    expect(r.error).toEqual(same);
    // On edit, the account that does not change counts too: seed-tr-2026-10-1 goes from 'us' to 'dr'.
    for (const body of [{ toAccountId: 'us' }, { fromAccountId: 'dr' }, { fromAccountId: 'dr', toAccountId: 'dr' }]) {
      const patched = await api.patch('/api/transfers/seed-tr-2026-10-1', body);
      expect(patched.status, JSON.stringify(body)).toBe(400);
      expect(patched.error, JSON.stringify(body)).toEqual(same);
    }
    for (const body of [{ ...transfer, toAccountId: 'no-existe' }, { ...transfer, fromAccountId: 'no-existe' }, { ...transfer, toAccountId: 'no-existe', rate: undefined }]) {
      const unknown = await api.post('/api/transfers', body);
      expect(unknown.status).toBe(400);
      expect(unknown.error).toEqual(unknownAccount('no-existe'));
    }
    expect((await api.patch('/api/transfers/seed-tr-2026-10-1', { toAccountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    expect(count(sqlite, 'transfers', F)).toBe(5);
    expect((await api.get<Month>('/api/months/2026-10')).body.transfers).toEqual(seedState().months['2026-10']!.transfers);
  });

  it('client id, repeated 409, validation and 404', async () => {
    const { api } = await seeded();
    expect((await api.post<Transfer>('/api/transfers', { ...transfer, id: 'tr-1' })).body.id).toBe('tr-1');
    expect((await api.post('/api/transfers', { ...transfer, id: 'tr-1' })).error?.code).toBe('conflict');

    const bad: unknown[] = [
      { ...transfer, amount: 0 },
      { ...transfer, amount: -5 },
      { ...transfer, rate: 0 },
      { ...transfer, rate: -1 },
      { ...transfer, rate: null },
      { ...transfer, via: '' },
      { ...transfer, date: '2026-10' },
      { ...transfer, fromAccountId: undefined },
      { ...transfer, toAccountId: '' },
      { ...transfer, dop: 1 },
      // The previous format: dollars only, without accounts.
      { monthKey: '2026-10', date: '2026-10-05', via: 'PayPal', usd: 300, rate: 57.9 },
    ];
    for (const body of bad) {
      expect((await api.post('/api/transfers', body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ amount: 0 }, { rate: 0 }, { via: ' ' }, { usd: 1 }, { fromAccountId: 'con espacios' }]) {
      expect((await api.patch('/api/transfers/tr-1', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.post('/api/transfers', { ...transfer, monthKey: '2031-01' })).status).toBe(404);
    expect((await api.patch('/api/transfers/no-existe', { amount: 1 })).error).toEqual({ code: 'not_found', message: 'Transfer not found.' });
    expect((await api.patch('/api/transfers/no-existe', { toAccountId: 'us' })).status).toBe(404);
    expect((await api.del('/api/transfers/no-existe')).status).toBe(404);
  });
});

describe('incomes', () => {
  const income = { date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD' };

  it('list, create, edit and delete', async () => {
    const { api } = await seeded();
    expect((await api.get<Income[]>('/api/incomes')).body).toEqual(seedState().incomes);

    const created = await api.post<Income>('/api/incomes', { ...income, desc: '  Freelance ' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), ...income, budget: false, rate: null, recurring: false });
    const id = created.body.id;

    const patched = await api.patch<Income>(`/api/incomes/${id}`, { date: '2026-10-16', desc: '', accountId: 'dr', amount: 23500, cur: 'DOP' });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ id, date: '2026-10-16', desc: '', accountId: 'dr', amount: 23500, cur: 'DOP', budget: false, rate: null, recurring: false });
    expect((await api.patch<Income>(`/api/incomes/${id}`, { amount: 0 })).body.amount).toBe(0);
    expect((await api.patch<Income>(`/api/incomes/${id}`, {})).body).toEqual({ ...patched.body, amount: 0 });
    // It shows up in the state, with the others.
    expect((await api.get<StateResponse>('/api/state')).body.state.incomes).toHaveLength(4);

    expect((await api.del<OkResponse>(`/api/incomes/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/incomes/${id}`)).status).toBe(404);
    expect((await api.get<Income[]>('/api/incomes')).body).toHaveLength(3);
  });

  it('the month income is the sum of those dated in it, and each one goes into the balance of its account', async () => {
    const { api } = await seeded();
    const us = await balance(api, 'us');
    await api.post('/api/incomes', income);
    // Without an account it goes into the default one ('dr'); in another currency, converted with its month's rate.
    const extra = await api.post<Income>('/api/incomes', { date: '2026-10-20', amount: 100, cur: 'USD' });
    expect(extra.body).toMatchObject({ accountId: 'dr', desc: '' });
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').income).toBeCloseTo((5800 + 400 + 100) * 58.76, 6);
    expect(await balance(api, 'us')).toBeCloseTo(us + 400, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(220641.93 + 5876, 6);
  });

  it('they do not belong to a month: any date is valid, whether that month is closed or does not exist', async () => {
    const { api, sqlite } = await seeded();
    // August is closed; 2031 has no month.
    const closed = await api.post<Income>('/api/incomes', { ...income, date: '2026-08-15' });
    expect(closed.status).toBe(201);
    expect((await api.post('/api/incomes', { ...income, date: '2031-01-01' })).status).toBe(201);
    expect((await api.patch<Income>('/api/incomes/seed-in-1', { amount: 6100 })).body).toMatchObject({ date: '2026-08-01', amount: 6100 });
    expect((await api.patch<Income>(`/api/incomes/${closed.body.id}`, { date: '2026-09-15' })).status).toBe(200);
    expect((await api.del(`/api/incomes/${closed.body.id}`)).status).toBe(200);
    expect((await api.del('/api/incomes/seed-in-2')).status).toBe(200);
    // They neither create the month of their date nor change the status of any month.
    expect(count(sqlite, 'months', F)).toBe(3);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.closed)).toEqual([true, true, false]);
  });

  it('client id, repeated 409, validation and 404', async () => {
    const { api, sqlite } = await seeded();
    expect((await api.post<Income>('/api/incomes', { ...income, id: 'in-1' })).body.id).toBe('in-1');
    expect((await api.post('/api/incomes', { ...income, id: 'in-1' })).error).toEqual({ code: 'conflict', message: 'A record with that id already exists.' });

    const bad: unknown[] = [
      {},
      { ...income, amount: 0 },
      { ...income, amount: -1 },
      { ...income, amount: '400' },
      { ...income, cur: 'EUR' },
      { ...income, cur: undefined },
      { ...income, date: '2026-10-32' },
      { ...income, date: undefined },
      { ...income, desc: 'x'.repeat(201) },
      { ...income, accountId: '' },
      { ...income, monthKey: '2026-10' },
      { ...income, account: 'us' },
    ];
    for (const body of bad) {
      const r = await api.post('/api/incomes', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    for (const body of [{ amount: -1 }, { date: 'ayer' }, { cur: 'usd' }, { accountId: null }, { id: 'otro' }]) {
      expect((await api.patch('/api/incomes/in-1', body)).status, JSON.stringify(body)).toBe(400);
    }
    // The account has to exist, on create and when changing it.
    const noAccount = await api.post('/api/incomes', { ...income, accountId: 'no-existe' });
    expect(noAccount.status).toBe(400);
    expect(noAccount.error).toEqual(unknownAccount('no-existe'));
    expect((await api.patch('/api/incomes/in-1', { accountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    expect((await api.patch('/api/incomes/no-existe', { amount: 1 })).error).toEqual({ code: 'not_found', message: 'Income not found.' });
    expect((await api.patch('/api/incomes/no-existe', { accountId: 'us' })).status).toBe(404);
    expect((await api.patch('/api/incomes/no-existe', {})).status).toBe(404);
    expect((await api.del('/api/incomes/no-existe')).status).toBe(404);
    expect(count(sqlite, 'incomes', F)).toBe(4);
  });
});

describe('closed month = read-only', () => {
  it('fixed expenses, transactions and transfers cannot be created, edited or deleted, nor can its budget or its rates be changed', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const attempts = [
      api.post('/api/fixed', { monthKey: '2026-08', name: 'Agua', amount: 500, cur: 'DOP' }),
      api.patch('/api/fixed/seed-fx-2026-08-1', { paid: false }),
      api.patch('/api/fixed/seed-fx-2026-08-1', { accountId: 'us' }),
      api.del('/api/fixed/seed-fx-2026-08-1'),
      api.post('/api/transactions', { monthKey: '2026-08', date: '2026-08-30', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' }),
      api.patch('/api/transactions/seed-tx-2026-08-1', { amount: 1 }),
      api.patch('/api/transactions/seed-tx-2026-08-1', { accountId: 'us' }),
      api.del('/api/transactions/seed-tx-2026-08-1'),
      api.post('/api/transfers', { monthKey: '2026-08', date: '2026-08-30', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1, rate: 58 }),
      api.post('/api/transfers', { monthKey: '2026-08', date: '2026-08-30', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1 }),
      api.patch('/api/transfers/seed-tr-2026-08-1', { amount: 1 }),
      api.patch('/api/transfers/seed-tr-2026-08-1', { fromAccountId: 'dr', toAccountId: 'us' }),
      api.del('/api/transfers/seed-tr-2026-08-1'),
      api.patch('/api/months/2026-08', { budgets: { dr: 1 } }),
      api.patch('/api/months/2026-08', { budgets: { dr: 0 } }),
      api.patch('/api/months/2026-08', { budgets: { us: 1, dr: 2 } }),
      api.put('/api/months/2026-08/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-08-01' }),
      api.put('/api/months/2026-08/rates', { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-08-01' }),
      api.del('/api/months/2026-08/rates/USD/DOP?date=2026-08-01'),
      api.post('/api/months/2026-08/budget-log', { accountId: 'dr', amount: 100 }),
      api.del('/api/months/2026-08/budget-log/seed-bg-2026-08-1'),
      api.post('/api/months/2026-08/leftover'),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(409);
      // The message is in English, with the month name in English; the web app translates it by its code.
      expect(r.error).toEqual({ code: 'month_closed', message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' });
    }
    expect(await loadState(db, F)).toEqual(before);
  });

  it("the message does not depend on the user's language", async () => {
    const { api } = await seeded();
    await api.patch('/api/settings', { language: 'es' });
    expect((await api.del('/api/fixed/seed-fx-2026-09-1')).error?.message).toMatch(/^September 2026 is closed/);
  });

  it('what does not belong to the month can still be changed: the incomes and contributions dated in it', async () => {
    const { api } = await seeded();
    expect((await api.patch<Income>('/api/incomes/seed-in-1', { amount: 6100 })).status).toBe(200);
    expect((await api.post('/api/incomes', { date: '2026-08-20', amount: 50, cur: 'USD' })).status).toBe(201);
    expect((await api.post('/api/contributions', { goalId: 'personal', date: '2026-08-20', amount: 50, cur: 'USD' })).status).toBe(201);
    // And the accounts, even if their movements are in closed months.
    expect((await api.patch('/api/accounts/dr', { opening: 61000, name: 'Popular' })).status).toBe(200);
    expect((await api.get<Month>('/api/months/2026-08')).body.closed).toBe(true);
  });

  it('reopen it, and then writing is allowed', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/months/2026-08/reopen')).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', { budgets: { dr: 1 } })).status).toBe(200);
    expect((await api.put('/api/months/2026-08/rates', { from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' })).status).toBe(200);
    expect((await api.del('/api/months/2026-08/rates/USD/DOP?date=2026-08-01')).status).toBe(200);
    expect((await api.del('/api/transactions/seed-tx-2026-08-1')).status).toBe(200);
    expect((await api.post('/api/fixed', { monthKey: '2026-08', name: 'Agua', amount: 500, cur: 'DOP' })).status).toBe(201);
  });

  it('a closed month can be deleted without reopening it', async () => {
    const { api } = await seeded();
    expect((await api.del('/api/months/2026-08')).status).toBe(200);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.key)).toEqual(['2026-09', '2026-10']);
  });

  it('an empty patch on a row of a closed month only reads it', async () => {
    const { api } = await seeded();
    expect((await api.patch('/api/transactions/seed-tx-2026-08-1', {})).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', {})).status).toBe(200);
  });
});

describe('goals', () => {
  it('list, create, edit and delete', async () => {
    const { api } = fresh();
    // A user who has not opened the app yet has no goals: their first visit creates them.
    expect((await api.get<Goal[]>('/api/goals')).body).toEqual([]);
    await api.get('/api/state');
    expect((await api.get<Goal[]>('/api/goals')).body).toEqual([...DEFAULT_GOALS]);

    const created = await api.post<Goal>('/api/goals', { name: ' Car ' });
    expect(created.status).toBe(201);
    // Without `cur`, the goal is in the user's main currency (DOP).
    expect(created.body).toEqual({ id: expect.any(String), name: 'Car', cur: 'DOP', monthly: null, start: null, end: null, approxCur: null, sort: 2 });
    const id = created.body.id;

    const planned = await api.post<Goal>('/api/goals', { id: 'house', name: 'House', cur: 'USD', monthly: 500, start: '2026-10', end: '2030-09' });
    expect(planned.body).toEqual({ id: 'house', name: 'House', cur: 'USD', monthly: 500, start: '2026-10', end: '2030-09', approxCur: null, sort: 3 });
    expect((await api.post('/api/goals', { id: 'house', name: 'Other' })).error).toEqual({
      code: 'conflict',
      message: 'A record with that id already exists.',
    });

    const patched = await api.patch<Goal>(`/api/goals/${id}`, { name: 'New car', cur: 'TRY', monthly: 250, start: '2026-11', end: '2027-11', approxCur: null, sort: 0 });
    expect(patched.body).toEqual({ id, name: 'New car', cur: 'TRY', monthly: 250, start: '2026-11', end: '2027-11', approxCur: null, sort: 0 });
    // null in all three goes back to "variable contributions".
    expect((await api.patch<Goal>(`/api/goals/${id}`, { monthly: null, start: null, end: null })).body).toEqual({
      ...patched.body,
      monthly: null,
      start: null,
      end: null,
    });
    expect((await api.patch<Goal>(`/api/goals/${id}`, {})).body).toMatchObject({ name: 'New car', monthly: null });

    expect((await api.del<OkResponse>(`/api/goals/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/goals/${id}`)).status).toBe(404);
    expect((await api.get<Goal[]>('/api/goals')).body.map((g) => g.id)).toEqual(['emergency', 'personal', 'house']);
  });

  it('the currency of a goal: the one sent or, failing that, the main currency of the user at that moment', async () => {
    const { api } = await seeded();
    expect((await api.post<Goal>('/api/goals', { name: 'A' })).body.cur).toBe('DOP');
    await api.patch('/api/settings', { mainCurrency: 'TRY' });
    expect((await api.post<Goal>('/api/goals', { name: 'B' })).body.cur).toBe('TRY');
    expect((await api.post<Goal>('/api/goals', { name: 'C', cur: 'USD' })).body.cur).toBe('USD');
    // Changing the main currency does not change that of the goals that already exist.
    expect((await api.get<Goal[]>('/api/goals')).body.map((g) => g.cur)).toEqual(['USD', 'USD', 'USD', 'DOP', 'TRY', 'USD']);
    for (const cur of ['EUR', 'usd', null, '']) {
      expect((await api.post('/api/goals', { name: 'D', cur })).status, String(cur)).toBe(400);
      expect((await api.patch('/api/goals/turkey', { cur })).status, String(cur)).toBe(400);
    }
  });

  it('a goal name is user data: it is stored as is, in any language', async () => {
    const { api } = fresh();
    const r = await api.post<Goal>('/api/goals', { name: 'Türkiye tatili ✈️' });
    expect(r.body.name).toBe('Türkiye tatili ✈️');
    expect((await api.patch<Goal>(`/api/goals/${r.body.id}`, { name: 'Viaje a Turquía' })).body.name).toBe('Viaje a Turquía');
  });

  it('plan on create: monthly, start and end go together (or none of them)', async () => {
    const { api, sqlite } = await seeded();
    const partial = 'monthly, start and end go together: set all three, or leave all three null';
    const bad: [body: Record<string, unknown>, message: string][] = [
      [{ name: 'x', monthly: 100 }, `Invalid data: monthly: ${partial}`],
      [{ name: 'x', monthly: 100, start: '2026-10' }, `Invalid data: monthly: ${partial}`],
      [{ name: 'x', start: '2026-10', end: '2027-01' }, `Invalid data: monthly: ${partial}`],
      [{ name: 'x', monthly: null, start: '2026-10', end: '2027-01' }, `Invalid data: monthly: ${partial}`],
      [{ name: 'x', monthly: 100, start: '2026-10', end: null }, `Invalid data: monthly: ${partial}`],
      [{ name: 'x', monthly: 0, start: '2026-10', end: '2027-01' }, 'Invalid data: monthly: must be greater than 0'],
      [{ name: 'x', monthly: 100, start: '2027-02', end: '2027-01' }, 'Invalid data: end: the start month cannot be after the end month'],
      [{ name: 'x', monthly: 100, start: '2026', end: '2027-01' }, 'Invalid data: start: is not a valid month (YYYY-MM)'],
    ];
    for (const [body, message] of bad) {
      const r = await api.post('/api/goals', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error, JSON.stringify(body)).toEqual({ code: 'validation', message });
    }
    expect(count(sqlite, 'goals', F)).toBe(3);

    // A single month is a valid plan; and all three null (or absent), a goal with variable contributions.
    expect((await api.post<Goal>('/api/goals', { name: 'a', monthly: 100, start: '2026-10', end: '2026-10' })).status).toBe(201);
    expect((await api.post<Goal>('/api/goals', { name: 'b', monthly: null, start: null, end: null })).body).toMatchObject({
      monthly: null,
      start: null,
      end: null,
    });
  });

  it('plan on edit: the resulting goal is validated, not only what is sent', async () => {
    const { api } = await seeded();
    // 'turkey' has a plan: sending only `end` (or only the monthly amount) is fine.
    expect((await api.patch<Goal>('/api/goals/turkey', { end: '2028-01' })).body).toEqual({ ...SEED_PLANNED_GOAL, end: '2028-01' });
    expect((await api.patch<Goal>('/api/goals/turkey', { monthly: 2000 })).body).toMatchObject({ monthly: 2000, start: '2026-08', end: '2028-01' });
    // Anything that leaves the plan half set or backwards is not.
    for (const body of [{ monthly: null }, { start: null }, { end: null }, { start: null, end: null }, { start: '2028-02' }, { end: '2026-07' }]) {
      const r = await api.patch('/api/goals/turkey', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    // 'personal' has no plan: sending only part of it is a 400; all three together is not.
    const alone = await api.patch('/api/goals/personal', { monthly: 150 });
    expect(alone.status).toBe(400);
    expect(alone.error).toEqual({
      code: 'validation',
      message: 'Invalid data: monthly: monthly, start and end go together: set all three, or leave all three null',
    });
    expect((await api.patch('/api/goals/personal', { start: '2026-10', end: '2027-01' })).status).toBe(400);
    expect((await api.patch<Goal>('/api/goals/personal', { monthly: 150, start: '2026-10', end: '2027-01' })).body).toMatchObject({
      monthly: 150,
      start: '2026-10',
      end: '2027-01',
    });

    const goals = (await api.get<Goal[]>('/api/goals')).body;
    expect(goals.map((g) => [g.id, g.monthly, g.start, g.end])).toEqual([
      ['emergency', null, null, null],
      ['personal', 150, '2026-10', '2027-01'],
      ['turkey', 2000, '2026-08', '2028-01'],
    ]);
  });

  it('the name is unique per user ignoring case: 409 conflict', async () => {
    const { api, sqlite } = await seeded();
    const taken = { code: 'conflict', message: 'There is already a goal with that name.' };
    for (const name of ['Emergency fund', 'emergency fund', '  EMERGENCY FUND  ', 'trip to turkey']) {
      const r = await api.post('/api/goals', { name });
      expect(r.status, name).toBe(409);
      expect(r.error).toEqual(taken);
    }
    const rename = await api.patch('/api/goals/personal', { name: 'TRIP TO TURKEY' });
    expect(rename.status).toBe(409);
    expect(rename.error).toEqual(taken);
    expect(count(sqlite, 'goals', F)).toBe(3);

    // Rewriting its own name (or only changing its case) is not a conflict.
    expect((await api.patch<Goal>('/api/goals/personal', { name: 'PERSONAL SAVINGS' })).body.name).toBe('PERSONAL SAVINGS');
    // With accents it counts too.
    expect((await api.post('/api/goals', { name: 'Educación' })).status).toBe(201);
    expect((await api.post('/api/goals', { name: 'EDUCACIÓN' })).status).toBe(409);
    // Once the goal is deleted, the name is free.
    for (const c of ['seed-ct-2', 'seed-ct-5', 'seed-ct-8']) await api.del(`/api/contributions/${c}`);
    expect((await api.del('/api/goals/emergency')).status).toBe(200);
    expect((await api.post('/api/goals', { name: 'emergency fund' })).status).toBe(201);
  });

  it('validates and returns 404', async () => {
    const { api } = await seeded();
    // `monthlyUSD` was the name of the monthly amount when all goals were in dollars.
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 7 }, { name: 'x', sort: 1 }, { name: 'x', target: 45000 }, { name: 'x', monthlyUSD: 100, start: '2026-10', end: '2027-01' }]) {
      const r = await api.post('/api/goals', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect((await api.post('/api/goals', { name: 'x'.repeat(120) })).status).toBe(201);
    for (const body of [{ monthly: -1 }, { sort: -1 }, { name: ' ' }, { name: 'x'.repeat(121) }, { id: 'otra' }, { start: '2027-02', end: '2027-01' }]) {
      expect((await api.patch('/api/goals/turkey', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.patch('/api/goals/no-existe', { name: 'x' })).error).toEqual({ code: 'not_found', message: 'Goal not found.' });
    expect((await api.patch('/api/goals/no-existe', {})).status).toBe(404);
    expect((await api.del('/api/goals/no-existe')).status).toBe(404);
  });

  it('a goal with contributions cannot be deleted (409)', async () => {
    const { api } = await seeded();
    const r = await api.del('/api/goals/turkey');
    expect(r.status).toBe(409);
    expect(r.error).toEqual({ code: 'conflict', message: 'The goal has contributions: delete or move them before deleting it.' });
    expect((await api.get<Goal[]>('/api/goals')).body).toHaveLength(3);
    // Without contributions (deleted or moved to another goal) it can now be deleted.
    await api.del('/api/contributions/seed-ct-1');
    await api.patch('/api/contributions/seed-ct-4', { goalId: 'personal' });
    await api.patch('/api/contributions/seed-ct-7', { goalId: 'personal' });
    expect((await api.del('/api/goals/turkey')).status).toBe(200);
  });
});

describe('contributions', () => {
  const contribution = { goalId: 'emergency', date: '2026-10-07', amount: 150, cur: 'USD' };

  it('list, create, edit and delete', async () => {
    const { api } = await seeded();
    expect((await api.get<Contribution[]>('/api/contributions')).body).toEqual(seedState().contribs);

    const created = await api.post<Contribution>('/api/contributions', contribution);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), ...contribution, rate: null, accountId: null });
    const id = created.body.id;

    const patched = await api.patch<Contribution>(`/api/contributions/${id}`, { goalId: 'personal', date: '2026-10-08', amount: 9000, cur: 'DOP' });
    expect(patched.body).toEqual({ id, goalId: 'personal', date: '2026-10-08', amount: 9000, cur: 'DOP', rate: null, accountId: null });
    expect((await api.patch<Contribution>(`/api/contributions/${id}`, { amount: 0 })).body.amount).toBe(0);
    // In any of the three currencies.
    expect((await api.patch<Contribution>(`/api/contributions/${id}`, { amount: 4200, cur: 'TRY' })).body).toMatchObject({ amount: 4200, cur: 'TRY' });

    expect((await api.del<OkResponse>(`/api/contributions/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/contributions/${id}`)).status).toBe(404);
    expect((await api.get<Contribution[]>('/api/contributions')).body).toHaveLength(8);
  });

  it('contributions do not depend on the month being closed, and they do not move the balance of any account', async () => {
    const { api } = await seeded();
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];
    expect((await api.post('/api/contributions', { ...contribution, date: '2026-08-15' })).status).toBe(201);
    expect((await api.post('/api/contributions', { ...contribution, amount: 5000, cur: 'DOP' })).status).toBe(201);
    expect((await api.del('/api/contributions/seed-ct-1')).status).toBe(200);
    expect([await balance(api, 'us'), await balance(api, 'dr')]).toEqual([us, dr]);
  });

  it('client id, repeated 409, validation and 404', async () => {
    const { api } = await seeded();
    expect((await api.post<Contribution>('/api/contributions', { ...contribution, id: 'ct-1' })).body.id).toBe('ct-1');
    expect((await api.post('/api/contributions', { ...contribution, id: 'ct-1' })).error?.code).toBe('conflict');

    for (const body of [{ ...contribution, amount: 0 }, { ...contribution, cur: 'EUR' }, { ...contribution, date: '2026-10-32' }, { ...contribution, goalId: '' }, { ...contribution, goal: 'emergency' }]) {
      expect((await api.post('/api/contributions', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.patch('/api/contributions/ct-1', { amount: -1 })).status).toBe(400);

    // The goal has to exist, on create and on move.
    const noGoal = await api.post('/api/contributions', { ...contribution, goalId: 'no-existe' });
    expect(noGoal.status).toBe(404);
    expect(noGoal.error).toEqual({ code: 'not_found', message: 'Goal not found.' });
    expect((await api.patch('/api/contributions/ct-1', { goalId: 'no-existe' })).error?.message).toBe('Goal not found.');
    expect((await api.patch('/api/contributions/no-existe', { goalId: 'emergency' })).error?.message).toBe('Contribution not found.');
    expect((await api.patch('/api/contributions/no-existe', { amount: 1 })).status).toBe(404);
    expect((await api.del('/api/contributions/no-existe')).status).toBe(404);
  });
});

describe('two users through the API', () => {
  it('each one reads and changes only their own data, even when the ids, accounts and months match', async () => {
    const { api, eda, db } = await pair();
    const before = await loadState(db, E);

    // Frank changes rows whose ids Eda also has.
    await api.patch('/api/months/2026-10', { budgets: { dr: 1, us: 2 } });
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' });
    await api.patch('/api/accounts/dr', { name: 'De Frank', opening: 1 });
    await api.patch('/api/accounts/us', { hidden: true });
    await api.patch('/api/fixed/seed-fx-2026-10-1', { name: 'De Frank', paid: false, accountId: 'us' });
    await api.del('/api/fixed/seed-fx-2026-10-2');
    await api.patch('/api/transactions/seed-tx-2026-10-1', { amount: 1, accountId: 'us' });
    await api.del('/api/transactions/seed-tx-2026-10-2');
    await api.patch('/api/transfers/seed-tr-2026-10-1', { amount: 1 });
    await api.patch('/api/incomes/seed-in-1', { amount: 1 });
    await api.del('/api/incomes/seed-in-2');
    await api.patch('/api/goals/turkey', { name: 'De Frank', monthly: 1, cur: 'TRY' });
    await api.patch('/api/contributions/seed-ct-1', { amount: 1 });
    await api.del('/api/contributions/seed-ct-2');
    await api.patch('/api/settings', { mainCurrency: 'USD', secondCurrency: 'TRY', defaultAccountId: 'us' });
    expect(await loadState(db, E)).toEqual(before);
    expect((await eda.get<Month>('/api/months/2026-10')).body).toEqual(before.months['2026-10']);
    expect((await eda.get<Account[]>('/api/accounts')).body).toEqual(before.accounts);
    expect((await eda.get<Income[]>('/api/incomes')).body).toEqual(before.incomes);
    expect((await eda.get<Goal[]>('/api/goals')).body).toEqual(before.goals);
    expect((await eda.get<Contribution[]>('/api/contributions')).body).toEqual(before.contribs);
    expect((await eda.get<MonthSummary[]>('/api/months')).body[2]).toMatchObject({ main: 'DOP', budget: 70000, txCount: 7 });
    // Frank sees his own data in his main currency (USD): 1 DOP at 60 plus 2 USD.
    const mine = (await api.get<MonthSummary[]>('/api/months')).body[2]!;
    expect(mine).toMatchObject({ main: 'USD', txCount: 6 });
    expect(mine.budget).toBeCloseTo(1 / 60 + 2, 10);
    // And the balance of Eda's 'dr' account is still that of the sample data.
    expect(await balance(eda, 'dr')).toBeCloseTo(220641.93, 6);

    // And Eda changes hers without undoing Frank's changes.
    const frank = await loadState(db, F);
    await eda.patch('/api/transactions/seed-tx-2026-10-1', { amount: 999 });
    await eda.patch('/api/accounts/us', { name: 'De Eda' });
    await eda.post('/api/incomes', { id: 'seed-in-2', date: '2026-10-09', amount: 5, cur: 'TRY' });
    await eda.post('/api/months/2026-10/close');
    expect(await loadState(db, F)).toEqual(frank);
    expect((await api.get<Month>('/api/months/2026-10')).body.closed).toBe(false);
    expect((await api.get('/api/months/2026-11')).status).toBe(404);
    expect((await eda.get<Month>('/api/months/2026-11')).body.fixed).toHaveLength(11);
    // Deleting a month only affects whoever deletes it.
    expect((await api.del('/api/months/2026-10')).status).toBe(200);
    expect((await eda.get<Month>('/api/months/2026-10')).body.tx).toHaveLength(7);
  });

  it('an id that exists but belongs to another user answers 404, the same as one that does not exist', async () => {
    const { api, eda, db } = await pair();
    // Rows that only Frank has.
    await api.post('/api/accounts', { id: 'acc-frank', name: 'PayPal', currency: 'USD' });
    await api.post('/api/fixed', { id: 'fx-frank', monthKey: '2026-10', name: 'Agua', amount: 500, cur: 'DOP' });
    await api.post('/api/transactions', { id: 'tx-frank', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' });
    await api.post('/api/transfers', { id: 'tr-frank', monthKey: '2026-10', date: '2026-10-07', via: 'Wise', fromAccountId: 'us', toAccountId: 'acc-frank', amount: 1 });
    await api.post('/api/incomes', { id: 'in-frank', date: '2026-10-07', amount: 5, cur: 'USD', accountId: 'acc-frank' });
    await api.post('/api/goals', { id: 'goal-frank', name: 'Car' });
    await api.post('/api/contributions', { id: 'ct-frank', goalId: 'goal-frank', date: '2026-10-07', amount: 5, cur: 'USD' });
    await api.post('/api/months/2026-10/close');
    const before = [await loadState(db, F), await loadState(db, E)];

    const attempts: [string, Awaited<ReturnType<typeof eda.get>>, Awaited<ReturnType<typeof eda.get>>][] = [
      ['PATCH account', await eda.patch('/api/accounts/acc-frank', { hidden: true }), await eda.patch('/api/accounts/no-existe', { hidden: true })],
      ['PATCH account {}', await eda.patch('/api/accounts/acc-frank', {}), await eda.patch('/api/accounts/no-existe', {})],
      ['DELETE account', await eda.del('/api/accounts/acc-frank'), await eda.del('/api/accounts/no-existe')],
      ['PATCH fixed', await eda.patch('/api/fixed/fx-frank', { paid: true }), await eda.patch('/api/fixed/no-existe', { paid: true })],
      ['PATCH fixed {}', await eda.patch('/api/fixed/fx-frank', {}), await eda.patch('/api/fixed/no-existe', {})],
      ['DELETE fixed', await eda.del('/api/fixed/fx-frank'), await eda.del('/api/fixed/no-existe')],
      ['PATCH tx', await eda.patch('/api/transactions/tx-frank', { amount: 2 }), await eda.patch('/api/transactions/no-existe', { amount: 2 })],
      ['DELETE tx', await eda.del('/api/transactions/tx-frank'), await eda.del('/api/transactions/no-existe')],
      ['PATCH transfer', await eda.patch('/api/transfers/tr-frank', { amount: 2 }), await eda.patch('/api/transfers/no-existe', { amount: 2 })],
      ['PATCH transfer (cuenta)', await eda.patch('/api/transfers/tr-frank', { toAccountId: 'dr' }), await eda.patch('/api/transfers/no-existe', { toAccountId: 'dr' })],
      ['DELETE transfer', await eda.del('/api/transfers/tr-frank'), await eda.del('/api/transfers/no-existe')],
      ['PATCH income', await eda.patch('/api/incomes/in-frank', { amount: 9 }), await eda.patch('/api/incomes/no-existe', { amount: 9 })],
      ['PATCH income {}', await eda.patch('/api/incomes/in-frank', {}), await eda.patch('/api/incomes/no-existe', {})],
      ['DELETE income', await eda.del('/api/incomes/in-frank'), await eda.del('/api/incomes/no-existe')],
      ['PATCH goal', await eda.patch('/api/goals/goal-frank', { name: 'Mía' }), await eda.patch('/api/goals/no-existe', { name: 'Mía' })],
      ['DELETE goal', await eda.del('/api/goals/goal-frank'), await eda.del('/api/goals/no-existe')],
      ['PATCH contribution', await eda.patch('/api/contributions/ct-frank', { amount: 9 }), await eda.patch('/api/contributions/no-existe', { amount: 9 })],
      ['DELETE contribution', await eda.del('/api/contributions/ct-frank'), await eda.del('/api/contributions/no-existe')],
      [
        'POST contribution a una meta ajena',
        await eda.post('/api/contributions', { goalId: 'goal-frank', date: '2026-10-07', amount: 5, cur: 'USD' }),
        await eda.post('/api/contributions', { goalId: 'no-existe', date: '2026-10-07', amount: 5, cur: 'USD' }),
      ],
      [
        'mover un aporte a una meta ajena',
        await eda.patch('/api/contributions/seed-ct-1', { goalId: 'goal-frank' }),
        await eda.patch('/api/contributions/seed-ct-1', { goalId: 'no-existe' }),
      ],
      ['GET mes', await eda.get('/api/months/2026-11'), await eda.get('/api/months/2031-01')],
      ['reabrir mes', await eda.post('/api/months/2026-11/reopen'), await eda.post('/api/months/2031-01/reopen')],
      ['cerrar mes', await eda.post('/api/months/2026-11/close'), await eda.post('/api/months/2031-01/close')],
      ['presupuesto del mes', await eda.patch('/api/months/2026-11', { budgets: { dr: 1 } }), await eda.patch('/api/months/2031-01', { budgets: { dr: 1 } })],
      ['tasa del mes', await eda.put('/api/months/2026-11/rates', { from: 'USD', to: 'DOP', rate: 1, date: '2026-11-01' }), await eda.put('/api/months/2031-01/rates', { from: 'USD', to: 'DOP', rate: 1, date: '2031-01-01' })],
      ['borrar mes', await eda.del('/api/months/2026-11'), await eda.del('/api/months/2031-01')],
    ];
    for (const [what, foreign, missing] of attempts) {
      expect(foreign.status, what).toBe(404);
      expect(foreign.error?.code, what).toBe('not_found');
      // Neither the status nor the message reveals that the id exists in someone else's finances.
      if (!what.endsWith('mes')) expect(foreign.error, what).toEqual(missing.error);
    }
    expect([await loadState(db, F), await loadState(db, E)]).toEqual(before);
  });

  it('an account of another user cannot be used to pay, receive, transfer or budget: 400, like one that does not exist', async () => {
    const { api, eda, db } = await pair();
    await api.post('/api/accounts', { id: 'acc-frank', name: 'PayPal', currency: 'USD' });
    const before = [await loadState(db, F), await loadState(db, E)];
    const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' };
    const transfer = { monthKey: '2026-10', date: '2026-10-07', via: 'Wise', amount: 1 };
    const using = (id: string) => [
      eda.post('/api/transactions', { ...tx, accountId: id }),
      eda.patch('/api/transactions/seed-tx-2026-10-1', { accountId: id }),
      eda.post('/api/fixed', { monthKey: '2026-10', name: 'Agua', amount: 1, cur: 'DOP', accountId: id }),
      eda.patch('/api/fixed/seed-fx-2026-10-1', { accountId: id }),
      eda.post('/api/transfers', { ...transfer, fromAccountId: 'us', toAccountId: id }),
      eda.post('/api/transfers', { ...transfer, fromAccountId: id, toAccountId: 'dr', rate: 58 }),
      eda.patch('/api/transfers/seed-tr-2026-10-1', { toAccountId: id }),
      eda.post('/api/incomes', { date: '2026-10-07', amount: 5, cur: 'USD', accountId: id }),
      eda.patch('/api/incomes/seed-in-1', { accountId: id }),
      eda.patch('/api/months/2026-10', { budgets: { [id]: 100 } }),
      eda.patch('/api/settings', { defaultAccountId: id }),
    ];
    const foreign = await Promise.all(using('acc-frank'));
    const missing = await Promise.all(using('no-existe'));
    foreign.forEach((r, i) => {
      expect(r.status, String(i)).toBe(400);
      expect(r.error, String(i)).toEqual(unknownAccount('acc-frank'));
      expect(missing[i]!.error, String(i)).toEqual(unknownAccount('no-existe'));
    });
    expect([await loadState(db, F), await loadState(db, E)]).toEqual(before);
    // For its owner it is an account.
    expect((await api.post('/api/transactions', { ...tx, accountId: 'acc-frank' })).status).toBe(201);
  });

  it('the same client id is valid for one row of each user; repeated for the same user, 409', async () => {
    const { api, eda } = await pair();
    const tx = { id: 'tx-igual', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' };
    expect((await api.post('/api/transactions', tx)).status).toBe(201);
    expect((await eda.post('/api/transactions', { ...tx, amount: 2 })).status).toBe(201);
    expect((await api.post('/api/transactions', tx)).status).toBe(409);
    expect((await api.post('/api/goals', { id: 'g', name: 'Car' })).status).toBe(201);
    // Same id and same goal name (and account name), but another person's.
    expect((await eda.post('/api/goals', { id: 'g', name: 'Car' })).status).toBe(201);
    expect((await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' })).status).toBe(201);
    expect((await eda.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'TRY' })).status).toBe(201);
    expect((await api.post('/api/accounts', { id: 'pp', name: 'Otra', currency: 'USD' })).status).toBe(409);
    expect((await api.patch<Transaction>('/api/transactions/tx-igual', {})).body.amount).toBe(1);
    expect((await eda.patch<Transaction>('/api/transactions/tx-igual', {})).body.amount).toBe(2);
    expect((await api.patch<Account>('/api/accounts/pp', {})).body.currency).toBe('USD');
    expect((await eda.patch<Account>('/api/accounts/pp', {})).body.currency).toBe('TRY');
  });

  it('a month closed for one user is not read-only for the other', async () => {
    const { api, eda } = await pair();
    expect((await api.post('/api/months/2026-08/reopen')).status).toBe(200);
    expect((await api.del('/api/transactions/seed-tx-2026-08-1')).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', { budgets: { dr: 1 } })).status).toBe(200);
    expect((await eda.del('/api/transactions/seed-tx-2026-08-1')).error?.code).toBe('month_closed');
    expect((await eda.patch('/api/months/2026-08', { budgets: { dr: 1 } })).error?.code).toBe('month_closed');
  });
});

describe('import (JSON)', () => {
  const payload: ImportPayload = {
    months: [
      {
        key: '2026-10',
        closed: true,
        budget: 60000,
        incomeUSD: 5000,
        accounts: { usd: 10, dop: 20 },
        fixed: [{ name: ' Luz ', day: '', amount: 1500, cur: 'DOP', paid: true }],
        transfers: [{ date: '2026-10-02', via: 'Remitly', usd: 1000, rate: 59 }],
        tx: [{ date: '2026-10-03', desc: 'Café', place: '', cat: 'Food', method: 'Debit card', amount: 250, cur: 'DOP', notes: '' }],
      },
      { key: '2026-11', closed: false, budget: 60000, incomeUSD: 5000, accounts: { usd: 10, dop: 20 }, fixed: [], transfers: [], tx: [] },
    ],
    contribs: [{ date: '2026-10-05', goalName: 'Car', amount: 100, cur: 'USD' }],
    goals: [
      { name: 'Trip to Turkey', monthlyUSD: 3200, start: '2026-08', end: '2027-10' },
      { name: 'Car', monthlyUSD: null, start: null, end: null },
    ],
  };

  it('upsert per month; contributions replaced; goals created by name and plan updated', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const r = await api.post<ImportResponse>('/api/import', payload);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ months: ['2026-10', '2026-11'], contributions: 1 });

    const after = await loadState(db, F);
    expect(Object.keys(after.months)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(after.months['2026-08']).toEqual(before.months['2026-08']);
    expect(after.months['2026-09']).toEqual(before.months['2026-09']);

    // The workbook only knows two accounts: everything lands in the user's USD account and DOP account.
    const oct = after.months['2026-10']!;
    expect(oct).toMatchObject({ closed: true, budgets: { dr: 60000 }, rates: [] });
    expect(oct.closedAt).not.toBeNull();
    expect(oct.fixed.map((f) => [f.name, f.accountId])).toEqual([['Luz', 'dr']]);
    expect(oct.transfers.map((t) => [t.via, t.fromAccountId, t.toAccountId, t.amount, t.rate])).toEqual([['Remitly', 'us', 'dr', 1000, 59]]);
    expect(oct.tx.map((t) => [t.desc, t.accountId, t.source])).toEqual([['Café', 'dr', 'import']]);
    expect(after.months['2026-11']).toMatchObject({ closed: false, closedAt: null, budgets: { dr: 60000 }, fixed: [], transfers: [], tx: [] });
    // The workbook's income is the month total: October already had 5,800 USD recorded (more than the workbook's
    // 5,000) and gets none; November, which had none, gets its own. The last month's balances are the workbook's.
    expect(after.incomes.filter((i) => i.desc === IMPORTED_INCOME).map((i) => [i.date, i.accountId, i.amount, i.cur])).toEqual([
      ['2026-11-01', 'us', 5000, 'USD'],
    ]);
    expect(after.incomes.slice(0, 3)).toEqual(before.incomes);
    expect(balances(after, '2026-11').accounts.map((a) => [a.account.id, Math.round(a.balance * 100) / 100])).toEqual([
      ['us', 10],
      ['dr', 20],
    ]);

    expect(after.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings', 'Trip to Turkey', 'Car']);
    expect(after.goals[2]).toEqual({ ...SEED_PLANNED_GOAL, monthly: 3200 });
    expect(after.contribs.map((c) => [c.goalId, c.amount])).toEqual([[after.goals[3]!.id, 100]]);
    // The settings do not come in the workbook: they stay as they were.
    expect([after.mainCurrency, after.secondCurrency, after.defaultAccountId, after.language]).toEqual(['DOP', 'USD', 'dr', 'en']);
  });

  it('null contribs and goals leave the contributions and the goals as they were', async () => {
    const { api, db } = await seeded();
    const r = await api.post<ImportResponse>('/api/import', { ...payload, contribs: null, goals: null });
    expect(r.body).toEqual({ months: ['2026-10', '2026-11'], contributions: 0 });
    const after = await loadState(db, F);
    expect(after.contribs).toEqual(seedState().contribs);
    expect(after.goals).toEqual(seedState().goals);
  });

  it('an invalid body returns 400 and changes nothing', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const month = payload.months[0]!;
    const goal = payload.goals![0]!;
    const bad: unknown[] = [
      {},
      { ...payload, months: 'x' },
      { ...payload, extra: 1 },
      // The previous format (parameters of a single goal) no longer exists.
      { months: payload.months, contribs: payload.contribs, turkey: { monthlyUSD: 3200, start: null, end: null } },
      { months: payload.months, contribs: payload.contribs },
      { ...payload, months: [month, month] },
      { ...payload, months: [{ ...month, key: 'October 2026' }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], date: '' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], amount: '250' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], id: 'x' }] }] },
      { ...payload, months: [{ ...month, fixed: [{ ...month.fixed[0], cur: 'EUR' }] }] },
      // The workbook only knows DOP and USD, and it carries no accounts or budget parts.
      { ...payload, months: [{ ...month, fixed: [{ ...month.fixed[0], cur: 'TRY' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], accountId: 'dr' }] }] },
      { ...payload, months: [{ ...month, budgets: { dr: 1 } }] },
      { ...payload, accounts: [] },
      { ...payload, months: [{ ...month, transfers: [{ ...month.transfers[0], usd: -1 }] }] },
      { ...payload, contribs: [{ date: '2026-10-05', goalName: '', amount: 1, cur: 'USD' }] },
      { ...payload, goals: [{ ...goal, name: '' }] },
      { ...payload, goals: [{ ...goal, start: 'agosto' }] },
      { ...payload, goals: [{ ...goal, id: 'turkey' }] },
      // Half a plan means nothing: the file is rejected instead of deleting or inventing the target.
      { ...payload, goals: [{ ...goal, monthlyUSD: null }] },
      { ...payload, goals: [{ ...goal, end: null }] },
      { ...payload, goals: [{ ...goal, monthlyUSD: 0 }] },
      { ...payload, goals: [{ ...goal, start: '2027-11' }] },
      { ...payload, goals: [{ name: 'Car' }] },
    ];
    for (const body of bad) {
      const r = await api.post('/api/import', body);
      expect(r.status, JSON.stringify(body).slice(0, 160)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    expect(await loadState(db, F)).toEqual(before);
  });

  it('accepts what the prototype importer accepts: amount 0, empty description, numeric day', async () => {
    const { api, db } = fresh();
    const r = await api.post('/api/import', {
      months: [
        {
          key: '2026-10',
          closed: false,
          budget: 0,
          incomeUSD: 0,
          accounts: { usd: 0, dop: 0 },
          fixed: [{ name: 'Claude', day: 5, amount: 0, cur: 'USD', paid: false }],
          transfers: [{ date: '2026-10-02', via: '', usd: 100, rate: 0 }],
          tx: [{ date: '2026-10-03', desc: '', place: '', cat: '', method: '', amount: 0, cur: 'DOP', notes: '' }],
        },
      ],
      contribs: null,
      goals: null,
    });
    expect(r.status).toBe(200);
    const state = await loadState(db, F);
    const m = state.months['2026-10']!;
    expect(m.fixed[0]).toMatchObject({ name: 'Claude', day: '5', amount: 0, cur: 'USD', accountId: 'us' });
    expect(m.transfers).toEqual([expect.objectContaining({ via: '', amount: 100, rate: 0 })]);
    expect(m.tx).toHaveLength(1);
    // With no budget or income in the workbook, no part and no income are left.
    expect(m.budgets).toEqual({});
    expect(state.incomes).toEqual([]);
  });

  it('the validation message says where the problem is, in English', async () => {
    const { api } = fresh();
    const month = payload.months[0]!;
    const r = await api.post('/api/import', { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], date: '3 de octubre' }] }] });
    expect(r.error?.message).toBe('Invalid data: months.0.tx.0.date: is not a valid date (YYYY-MM-DD)');
    const plan = await api.post('/api/import', { ...payload, goals: [payload.goals![1], { ...payload.goals![0], end: null }] });
    expect(plan.error?.message).toBe(
      'Invalid data: goals.1.monthlyUSD: monthlyUSD, start and end go together: set all three, or leave all three null',
    );
  });

  it('a user who imports before opening the app does not end up with duplicated initial goals', async () => {
    const { api } = fresh();
    await api.post('/api/import', {
      months: [],
      contribs: [{ date: '2026-10-05', goalName: 'Emergency fund', amount: 100, cur: 'USD' }],
      goals: [{ name: 'Emergency fund', monthlyUSD: null, start: null, end: null }],
    });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect(state.goals.map((g) => g.name)).toEqual(['Emergency fund', 'Personal savings']);
    expect(state.contribs).toHaveLength(1);
    expect(state.accounts).toEqual([...DEFAULT_ACCOUNTS]);
  });
});

describe('development routes', () => {
  it('without ALLOW_DEV_RESET=1 they answer 404 (with or without X-User) and touch nothing', async () => {
    for (const flag of [undefined, '', '0', 'true']) {
      const { api, sqlite, env } = await seeded(flag === undefined ? {} : { ALLOW_DEV_RESET: flag });
      for (const path of ['/api/dev/seed', '/api/dev/reset']) {
        for (const r of [await api.post(path), await client(env, null).post(path)]) {
          expect(r.status).toBe(404);
          expect(r.body).toEqual({ error: { code: 'not_found', message: 'Route not found.' } });
        }
      }
      expect(count(sqlite, 'months', F)).toBe(3);
      expect(count(sqlite, 'contributions', F)).toBe(8);
    }
  });

  it('seed loads the sample data only for that user and keeps their language and colors', async () => {
    const { api, eda, db } = fresh({ ALLOW_DEV_RESET: '1' });
    const ocean = { accent: '#2a6f97', header: '#16202a', background: '#eef1f4' };
    await api.get('/api/state');
    await api.patch('/api/settings', { language: 'tr', theme: ocean, mainCurrency: 'USD', secondCurrency: 'TRY', defaultAccountId: 'us' });
    await api.post('/api/goals', { id: 'extra', name: 'Extra' });
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'TRY' });
    await eda.get('/api/state');
    await eda.post('/api/goals', { id: 'extra', name: 'De Eda' });
    const edaBefore = await loadState(db, E);

    const seed = await api.post<OkResponse>('/api/dev/seed');
    expect(seed.status).toBe(200);
    expect(seed.body).toEqual({ ok: true });
    // The currencies and default account are those of the sample data (they go with its accounts): DOP, USD and 'dr'.
    const expected: AppState = { ...seedState(), language: 'tr', theme: ocean };
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);
    expect(await loadState(db, E)).toEqual(edaBefore);
    // Repeating it leaves the same result.
    await api.post('/api/goals', { id: 'extra', name: 'Extra' });
    await api.post('/api/incomes', { date: '2026-10-07', amount: 1, cur: 'USD' });
    await api.post('/api/dev/seed');
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);

    // Both can have the sample data at the same time (same ids).
    expect((await eda.post('/api/dev/seed')).status).toBe(200);
    expect(withoutTimestamps(await loadState(db, E))).toEqual(seedState());
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);
  });

  it('reset leaves that user as newly arrived: initial accounts and goals, current month, and their settings', async () => {
    const { api, db, sqlite } = await seeded({ ALLOW_DEV_RESET: '1' });
    await api.patch('/api/settings', { language: 'es' });
    await api.post('/api/goals', { id: 'extra', name: 'Extra' });
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'TRY' });

    const reset = await api.post<OkResponse>('/api/dev/reset');
    expect(reset.body).toEqual({ ok: true });
    const state = await loadState(db, F);
    // The default account of the sample data ('dr') is not kept: the accounts are different ones, newly created.
    expect(state).toEqual(arrivedState('es'));
    for (const table of ['incomes', 'transactions', 'transfers', 'fixed_expenses', 'contributions', 'month_budget_log', 'month_rates']) {
      expect(count(sqlite, table, F), table).toBe(0);
    }
    // Opening the app afterwards adds nothing.
    expect((await api.get<StateResponse>('/api/state')).body.state).toEqual(state);
  });

  it('reset also works for a user who had never visited', async () => {
    const { api, sqlite } = fresh({ ALLOW_DEV_RESET: '1' });
    expect((await api.post('/api/dev/reset')).status).toBe(200);
    expect((await api.get<StateResponse>('/api/state')).body.state).toEqual(arrivedState());
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'accounts')).toBe(2);
  });
});

describe('errors and headers', () => {
  it('unknown route: 404 not_found with an ApiErrorBody body', async () => {
    const { api } = fresh();
    const unknown = [
      await api.get('/api/nada'),
      await api.post('/api/state'),
      await api.del('/api/state'),
      await api.get('/api/settings'),
      await api.put('/api/months/2026-10', { budgets: {} }),
      await api.post('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 1 }),
      await api.put('/api/accounts/us', { name: 'x' }),
      await api.get('/api/incomes/seed-in-1'),
    ];
    for (const r of unknown) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'not_found', message: 'Route not found.' } });
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('malformed or missing JSON: 400 validation', async () => {
    const { api } = await seeded();
    for (const body of ['{"budget": 1', '', 'budget=1', '￾']) {
      const res = await api.raw('/api/months/2026-10', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The request body is not valid JSON.' } });
    }
    expect((await api.raw('/api/settings', { method: 'PATCH', body: '' })).status).toBe(400);
  });

  it('a body that is too large: 413', async () => {
    const { api } = await seeded();
    const big = JSON.stringify({ monthKey: '2026-10', name: 'x'.repeat(MAX_JSON_BYTES), amount: 1, cur: 'DOP' });
    const res = await api.raw('/api/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The request body is too large.' } });
    // Also when Content-Length declares it, without reading the body.
    const declared = await api.raw('/api/fixed', { method: 'POST', headers: { 'Content-Length': String(MAX_JSON_BYTES + 1) }, body: '{}' });
    expect(declared.status).toBe(413);
  });

  it('an unexpected failure returns 500 internal without leaking details, and it is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      prepare: () => {
        throw new Error('D1_ERROR: no such table: secreto_interno');
      },
      batch: () => {
        throw new Error('D1_ERROR: no such table: secreto_interno');
      },
    } as unknown as D1Database;
    const api = client({ DB: broken, USERS });
    const replies = [
      await api.get('/api/state'),
      await api.get('/api/goals'),
      await api.post('/api/goals', { name: 'x' }),
      await api.patch('/api/settings', { language: 'es' }),
    ];
    for (const r of replies) {
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: 'internal', message: 'Internal server error.' } });
      expect(JSON.stringify(r.body)).not.toContain('secreto');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(log).toHaveBeenCalledTimes(replies.length);
  });

  it('expected errors do not pollute the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { api, env } = await seeded();
    await api.get('/api/months/2031-01');
    await api.post('/api/fixed', {});
    await api.del('/api/fixed/seed-fx-2026-08-1');
    await api.post('/api/goals', { name: 'Emergency fund' });
    await api.post('/api/accounts', { name: 'US account', currency: 'USD' });
    await api.del('/api/accounts/us');
    await api.patch('/api/accounts/dr', { currency: 'TRY' });
    await api.post('/api/incomes', { date: '2026-10-07', amount: 1, cur: 'USD', accountId: 'no-existe' });
    await api.post('/api/transfers', { monthKey: '2026-10', date: '2026-10-07', via: 'x', fromAccountId: 'us', toAccountId: 'us', amount: 1 });
    await api.patch('/api/months/2026-08', { budgets: { dr: 1 } });
    await api.del('/api/months/2031-01');
    await api.patch('/api/settings', { mainCurrency: 'USD' });
    await api.patch('/api/settings', {});
    await client(env, null).get('/api/state');
    await client(env, 'pedro').get('/api/state');
    expect(log).not.toHaveBeenCalled();
  });

  it('all JSON responses carry Cache-Control: no-store', async () => {
    const { api } = await seeded();
    const replies = [
      await api.get('/api/session'),
      await api.get('/api/state'),
      await api.get('/api/months'),
      await api.get('/api/accounts'),
      await api.get('/api/incomes'),
      await api.get('/api/goals'),
      await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-06' }),
      await api.del('/api/months/2026-10/rates/USD/DOP?date=2026-10-06'),
      await api.del('/api/accounts/us'),
      await api.patch('/api/settings', { language: 'en' }),
      await api.post('/api/fixed', { monthKey: '2026-10', name: 'Agua', amount: 1, cur: 'DOP' }),
      await api.post('/api/fixed', {}),
      await api.del('/api/fixed/no-existe'),
      await api.post('/api/ingest/transaction', { description: 'x', amount: 1 }),
    ];
    for (const r of replies) expect(r.headers.get('Cache-Control'), String(r.status)).toBe('no-store');
  });

  it('rejects writes sent from another site (CSRF), but not reads or same-origin writes', async () => {
    const { api, sqlite } = await seeded();
    const cross = { 'Sec-Fetch-Site': 'cross-site' };
    const blocked = await api.post('/api/months/2026-10/close', undefined, cross);
    expect(blocked.status).toBe(403);
    expect(blocked.error).toEqual({ code: 'forbidden', message: 'Request rejected: it comes from another site.' });
    expect((await api.del('/api/transactions/seed-tx-2026-10-1', cross)).status).toBe(403);
    expect((await api.patch('/api/settings', { language: 'es' }, cross)).status).toBe(403);
    expect((await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 1, date: '2026-10-06' }, cross)).status).toBe(403);
    expect((await api.del('/api/months/2026-10', cross)).status).toBe(403);
    expect((await api.post('/api/accounts', { name: 'PayPal', currency: 'USD' }, cross)).status).toBe(403);
    expect((await api.del('/api/incomes/seed-in-1', cross)).status).toBe(403);
    expect(count(sqlite, 'months', F)).toBe(3);
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect(count(sqlite, 'accounts', F)).toBe(2);
    expect(count(sqlite, 'incomes', F)).toBe(3);
    expect((await api.get<StateResponse>('/api/state')).body.state).toMatchObject({ language: 'en' });
    expect((await api.get<Month>('/api/months/2026-10')).body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
    ]);

    expect((await api.get('/api/state', cross)).status).toBe(200);
    expect((await api.get('/api/session', cross)).status).toBe(200);
    expect((await api.del('/api/transactions/seed-tx-2026-10-1', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });
});
