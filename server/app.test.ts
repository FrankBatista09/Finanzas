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

// `api` habla siempre como Frank. Eda está al lado con los mismos datos de ejemplo (mismos ids, mismos meses).
const F = FRANK.id;
const E = EDA.id;

let bystander: { db: D1Database; before: AppState } | null = null;

/** Los dos usuarios con los datos de ejemplo, sin vigilar a nadie: para las pruebas en las que actúan los dos. */
async function pair(extra: Partial<Env> = {}) {
  const t = makeEnv(extra);
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  return { ...t, api: client(t.env), eda: client(t.env, E) };
}

/** Como pair(), y al acabar la prueba se comprueba que nada de lo que hizo Frank tocó lo de Eda. */
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

/** Un usuario recién llegado: sus cuentas y metas iniciales y el mes actual, vacío. */
const arrivedState = (language: AppState['language'] = 'en'): AppState => ({
  months: { [currentMonthKey()]: emptyMonth(currentMonthKey()) },
  accounts: [...DEFAULT_ACCOUNTS],
  incomes: [],
  goals: [...DEFAULT_GOALS],
  contribs: [],
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

/** Saldo de una cuenta de Frank al final de `asOf`, como lo calcularía la web con lo que devuelve la API. */
async function balance(api: ReturnType<typeof client>, accountId: string, asOf = '2026-10'): Promise<number> {
  const { state } = (await api.get<StateResponse>('/api/state')).body;
  return balances(state, asOf).accounts.find((a) => a.account.id === accountId)!.balance;
}

describe('GET /api/session', () => {
  it('lista los usuarios configurados, en su orden, sin pedir X-User', async () => {
    const { env, sqlite } = makeEnv();
    const r = await client(env, null).get<SessionResponse>('/api/session');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ users: [FRANK, EDA], devTools: false });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    // Con la cabecera responde lo mismo, y no prepara a nadie en la base.
    expect((await client(env, E).get<SessionResponse>('/api/session')).body).toEqual(r.body);
    expect(count(sqlite, 'settings')).toBe(0);
  });

  it('devTools refleja ALLOW_DEV_RESET', async () => {
    const session = async (flag: string) => (await fresh({ ALLOW_DEV_RESET: flag }).api.get<SessionResponse>('/api/session')).body;
    expect((await session('1')).devTools).toBe(true);
    expect((await session('true')).devTools).toBe(false);
  });

  it('USERS: nombre por defecto, espacios y, si no está definida, un solo usuario', async () => {
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

  it('USERS mal escrita es un error de configuración: 500 en toda la API, con el motivo en el log y no en la respuesta', async () => {
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
    // No se cae en silencio a otra lista: nadie llegó a escribir nada.
    for (const table of ['months', 'accounts', 'goals', 'settings', 'transactions']) expect(count(sqlite, table)).toBe(0);
  });
});

describe('cabecera X-User', () => {
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

  it('sin ella, toda ruta salvo /api/session y /api/ingest/* responde 400 validation y no toca nada', async () => {
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

  it('con un usuario que no está configurado: 400 validation con los ids válidos, y no se le crea nada', async () => {
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
    // El nombre que se muestra no es el id; y un valor larguísimo no se devuelve entero.
    expect((await client(t.env, 'Frank Reyes').get('/api/state')).status).toBe(400);
    const long = await client(t.env, 'x'.repeat(500)).get('/api/state');
    expect(long.error?.message).toHaveLength('Unknown user "" in the X-User header (valid ids: frank, eda).'.length + 40);
    for (const table of ['months', 'accounts', 'goals', 'settings', 'transactions', 'incomes']) expect(count(t.sqlite, table)).toBe(0);
  });

  it('con un usuario configurado pasa; el id no distingue mayúsculas ni espacios y el nombre de la cabecera tampoco', async () => {
    const { env } = makeEnv();
    const variants: Record<string, string>[] = [{ 'X-User': 'eda' }, { 'x-user': ' Eda ' }, { 'X-USER': 'EDA' }];
    for (const headers of variants) {
      const r = await client(env, null).get<StateResponse>('/api/state', headers);
      expect(r.status, JSON.stringify(headers)).toBe(200);
      expect(r.body.user).toEqual(EDA);
    }
  });

  it('una ruta que no existe sigue siendo 404 para un usuario válido', async () => {
    const { api } = fresh();
    expect((await api.get('/api/nada')).status).toBe(404);
    // /api/session solo es esa ruta exacta.
    expect((await client(makeEnv().env, null).get('/api/session/otra')).status).toBe(400);
  });
});

describe('GET /api/state', () => {
  it('la primera vez de un usuario le crea sus cuentas y metas iniciales y el mes actual', async () => {
    const { api, sqlite } = fresh();
    const r = await api.get<StateResponse>('/api/state');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.body).toEqual({ user: FRANK, state: arrivedState() });
    // Pedirlo otra vez no crea nada más, y a Eda nadie le ha creado nada todavía.
    expect((await api.get<StateResponse>('/api/state')).body).toEqual(r.body);
    expect(count(sqlite, 'months')).toBe(1);
    expect(count(sqlite, 'accounts')).toBe(2);
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'accounts', E)).toBe(0);
    expect(count(sqlite, 'goals', E)).toBe(0);
  });

  it('cada usuario recibe lo suyo, con su nombre', async () => {
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

  it('quien borra sus cuentas o metas iniciales no las recupera al volver a entrar', async () => {
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

  it('con datos no crea nada y devuelve todo el histórico', async () => {
    const { api, sqlite } = await seeded();
    const r = await api.get<StateResponse>('/api/state');
    expect(r.body.user).toEqual(FRANK);
    expect(withoutTimestamps(r.body.state)).toEqual(seedState());
    expect(count(sqlite, 'months', F)).toBe(3);
    expect(count(sqlite, 'accounts', F)).toBe(2);
    expect(count(sqlite, 'goals', F)).toBe(3);
  });

  it('quien se queda sin meses encuentra otra vez el actual, vacío, con todo lo demás como estaba', async () => {
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

  it('idioma: se guarda por usuario y sale en /api/state', async () => {
    const { api, eda } = fresh();
    const r = await api.patch<SettingsResponse>('/api/settings', { language: 'tr' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...DEFAULT_SETTINGS, language: 'tr' });
    expect((await api.get<StateResponse>('/api/state')).body.state.language).toBe('tr');
    expect((await eda.get<StateResponse>('/api/state')).body.state.language).toBe('en');
    expect((await eda.patch<SettingsResponse>('/api/settings', { language: 'es' })).body.language).toBe('es');
    expect((await api.get<StateResponse>('/api/state')).body.state.language).toBe('tr');
  });

  it('colores: se normalizan, cambian sin tocar el idioma y null los restablece', async () => {
    const { api } = fresh();
    await api.patch('/api/settings', { language: 'es' });
    const set = await api.patch<SettingsResponse>('/api/settings', { theme: { accent: '#2A6F97', header: ' #16202A ', background: '#ABC' } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ...DEFAULT_SETTINGS, theme: { accent: '#2a6f97', header: '#16202a', background: '#aabbcc' }, language: 'es' });
    expect((await api.get<StateResponse>('/api/state')).body.state.theme).toEqual(set.body.theme);

    // Solo cambia lo que viene.
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

  it('la paleta original se guarda (y se devuelve) como null', async () => {
    const { api, sqlite } = fresh();
    await api.patch('/api/settings', { theme: ocean });
    const r = await api.patch<SettingsResponse>('/api/settings', { theme: { accent: '#2F7D52', header: '#1d1f1c', background: '#efeee8' } });
    expect(r.body.theme).toBeNull();
    expect(sqlite.sqlite.prepare("SELECT value FROM settings WHERE user_id = 'frank' AND key = 'theme'").get()?.value).toBeNull();
  });

  it('monedas: principal y segunda son de cada usuario; para intercambiarlas van las dos en la misma petición', async () => {
    const { api, eda } = await pair();
    const swapped = await api.patch<SettingsResponse>('/api/settings', { mainCurrency: 'USD', secondCurrency: 'DOP' });
    expect(swapped.status).toBe(200);
    expect(swapped.body).toEqual({ ...DEFAULT_SETTINGS, mainCurrency: 'USD', secondCurrency: 'DOP', defaultAccountId: 'dr' });
    const state = (await api.get<StateResponse>('/api/state')).body.state;
    expect([state.mainCurrency, state.secondCurrency]).toEqual(['USD', 'DOP']);
    // Todo lo que se resume sale ya en la nueva moneda principal.
    expect((await api.get<MonthSummary[]>('/api/months')).body[2]).toMatchObject({ main: 'USD' });
    expect((await eda.get<MonthSummary[]>('/api/months')).body[2]).toMatchObject({ main: 'DOP', budget: 70000 });

    // Una sola, si no choca con la que ya tiene.
    expect((await api.patch<SettingsResponse>('/api/settings', { secondCurrency: 'TRY' })).body).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY' });
    expect((await api.patch<SettingsResponse>('/api/settings', { mainCurrency: 'DOP' })).body).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'TRY' });
    expect((await eda.get<StateResponse>('/api/state')).body.state).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'USD' });
  });

  it('monedas iguales: 400, vengan las dos o solo una que coincide con la otra que ya tiene', async () => {
    const { api } = await seeded();
    const same = { code: 'validation', message: 'Invalid data: secondCurrency: must be different from mainCurrency' };
    for (const body of [{ mainCurrency: 'USD' }, { secondCurrency: 'DOP' }, { mainCurrency: 'TRY', secondCurrency: 'TRY' }, { mainCurrency: 'USD', secondCurrency: 'USD' }]) {
      const r = await api.patch('/api/settings', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error, JSON.stringify(body)).toEqual(same);
    }
    // Ni se guarda lo demás que viniera con ellas.
    expect((await api.patch('/api/settings', { language: 'tr', mainCurrency: 'USD' })).status).toBe(400);
    expect((await api.get<StateResponse>('/api/state')).body.state).toMatchObject({ mainCurrency: 'DOP', secondCurrency: 'USD', language: 'en' });
  });

  it('cuenta por defecto: una cuenta del usuario o null; una que no existe o es de otro, 400', async () => {
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
    // null vuelve a la automática.
    expect((await api.patch<SettingsResponse>('/api/settings', { defaultAccountId: null })).body.defaultAccountId).toBeNull();
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
  });

  it('un cuerpo vacío, con claves desconocidas o con valores inválidos: 400 y no cambia nada', async () => {
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
      { secondCurrency: null },
      { defaultAccountId: '' },
      { defaultAccountId: 7 },
      { defaultRate: 60 },
      // Una parte válida no se guarda si la otra no lo es.
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

describe('cuentas', () => {
  it('listar, crear, renombrar, corregir el saldo inicial, ocultar y borrar', async () => {
    const { api } = fresh();
    // Un usuario que todavía no abrió la app no tiene cuentas: se las crea su primera visita.
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
    // Sin nada que la use, la moneda todavía se puede cambiar.
    expect((await api.patch<Account>(`/api/accounts/${id}`, { currency: 'DOP' })).body.currency).toBe('DOP');
    // GET /api/accounts y el estado las traen todas (también las ocultas), en su orden.
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

  it('el nombre de una cuenta es dato del usuario: se guarda tal cual, y es único sin distinguir mayúsculas (409)', async () => {
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
    // Reescribir su propio nombre (o solo cambiarle las mayúsculas) no es un conflicto.
    expect((await api.patch<Account>('/api/accounts/dr', { name: 'DR ACCOUNT' })).body.name).toBe('DR ACCOUNT');
    // Renombrada, el nombre anterior queda libre; y otra persona puede tener una cuenta que se llame igual.
    expect((await api.patch<Account>('/api/accounts/us', { name: 'Chase' })).status).toBe(200);
    expect((await api.post('/api/accounts', { name: 'US account', currency: 'USD' })).status).toBe(201);
    expect((await eda.post('/api/accounts', { id: 'ah', name: 'Ahorros en dólares 💵', currency: 'DOP' })).status).toBe(201);
    // El id del cliente, repetido: 409.
    expect((await api.post('/api/accounts', { id: 'ah', name: 'Otra', currency: 'USD' })).error).toEqual({
      code: 'conflict',
      message: 'A record with that id already exists.',
    });
  });

  it('la moneda no se puede cambiar una vez que la cuenta tiene movimientos (409)', async () => {
    const { api } = await seeded();
    const r = await api.patch('/api/accounts/dr', { currency: 'USD' });
    expect(r.status).toBe(409);
    expect(r.error).toEqual({ code: 'conflict', message: 'The account is in use: its currency cannot be changed.' });
    expect((await api.patch('/api/accounts/us', { name: 'Chase', currency: 'TRY' })).status).toBe(409);
    expect((await api.get<Account[]>('/api/accounts')).body).toEqual([...SEED_ACCOUNTS]);
    // La que ya tiene sí se puede "escribir", junto con otros cambios.
    expect((await api.patch<Account>('/api/accounts/us', { name: 'Chase', currency: 'USD' })).body).toMatchObject({ name: 'Chase', currency: 'USD' });
  });

  it('una cuenta que algo usa no se borra (409: se oculta); la última, tampoco', async () => {
    const { api } = await seeded();
    const inUse = { code: 'conflict', message: 'The account is in use: hide it instead of deleting it.' };
    for (const id of ['us', 'dr']) {
      const r = await api.del(`/api/accounts/${id}`);
      expect(r.status).toBe(409);
      expect(r.error).toEqual(inUse);
    }
    // Basta una parte del presupuesto, un ingreso o un envío para que esté en uso.
    await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' });
    await api.patch('/api/months/2026-10', { budgets: { pp: 10 } });
    expect((await api.del('/api/accounts/pp')).error).toEqual(inUse);
    // Dejar la parte en 0 no basta: el registro del presupuesto conserva sus movimientos. Hay que borrarlos.
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
    // Ocultarla sí se puede: deja de sumar al dinero total, pero sigue ahí.
    expect((await api.patch<Account>('/api/accounts/pp', { hidden: true })).body.hidden).toBe(true);
    await api.del(`/api/transfers/${transfer.body.id}`);
    expect((await api.del('/api/accounts/pp')).status).toBe(200);

    // La última: un usuario siempre tiene al menos una cuenta.
    const lonely = fresh();
    await lonely.api.get('/api/state');
    expect((await lonely.api.del('/api/accounts/us')).status).toBe(200);
    const last = await lonely.api.del('/api/accounts/dr');
    expect(last.status).toBe(409);
    expect(last.error).toEqual({ code: 'conflict', message: 'The last account cannot be deleted: there must always be one.' });
    expect((await lonely.api.get<Account[]>('/api/accounts')).body.map((a) => a.id)).toEqual(['dr']);
  });

  it('borrar la cuenta por defecto la deja en la automática', async () => {
    const { api } = fresh();
    await api.get('/api/state');
    await api.patch('/api/settings', { defaultAccountId: 'us' });
    expect((await api.del('/api/accounts/us')).status).toBe(200);
    expect((await api.get<StateResponse>('/api/state')).body.state.defaultAccountId).toBeNull();
  });

  it('corregir un saldo es ajustar el saldo inicial: el saldo no viaja ni se guarda', async () => {
    const { api } = await seeded();
    const before = await balance(api, 'dr');
    expect(before).toBeCloseTo(220641.93, 6);
    // Para que la cuenta muestre 200,000 hay que bajar el inicial lo mismo que sobra.
    const opening = 60000 + (200000 - before);
    expect((await api.patch<Account>('/api/accounts/dr', { opening })).body.opening).toBe(opening);
    expect(await balance(api, 'dr')).toBeCloseTo(200000, 6);
    expect((await api.patch('/api/accounts/dr', { balance: 200000 })).status).toBe(400);
  });

  it('valida y da 404', async () => {
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

describe('meses', () => {
  it('GET /api/months lista los resúmenes, en la moneda principal del usuario', async () => {
    const { api } = await seeded();
    const r = await api.get<MonthSummary[]>('/api/months');
    expect(r.status).toBe(200);
    expect(r.body.map((m) => [m.key, m.closed, m.txCount, m.main])).toEqual([
      ['2026-08', true, 10, 'DOP'],
      ['2026-09', true, 10, 'DOP'],
      ['2026-10', false, 7, 'DOP'],
    ]);
    expect(r.body[2]).toEqual({ key: '2026-10', closed: false, closedAt: null, main: 'DOP', budget: 70000, used: expect.any(Number), txCount: 7 });
    // Octubre: 6 fijos pagados (Claude en USD a 58.76) + 7 transacciones.
    expect(r.body[2]!.used).toBeCloseTo(1337.15 + 2699 + 5640 + 15000 + 106 * 58.76 + 7400 + 10845, 6);
  });

  it('GET /api/months/:key devuelve el mes completo; 404 si no existe o la clave no es un mes', async () => {
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

  it('PATCH /api/months/:key cambia las partes del presupuesto que vengan; 0 quita la parte', async () => {
    const { api } = await seeded();
    const r = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 58248.5, us: 200 } });
    expect(r.status).toBe(200);
    expect(r.body.budgets).toEqual({ dr: 58248.5, us: 200 });
    expect(r.body.fixed).toHaveLength(11);
    // El total es la suma convertida a la moneda principal: 58,248.50 + 200 USD a 58.76.
    expect((await api.get<MonthSummary[]>('/api/months')).body[2]!.budget).toBeCloseTo(58248.5 + 200 * 58.76, 8);

    // Las cuentas que no vienen conservan su parte.
    const one = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 0 } });
    expect(one.body.budgets).toEqual({ us: 200 });
    // Un patch vacío devuelve el mes sin cambios.
    expect((await api.patch<Month>('/api/months/2026-10', {})).body).toEqual(one.body);
    expect((await api.patch<Month>('/api/months/2026-10', { budgets: {} })).body).toEqual(one.body);
    expect((await api.patch<Month>('/api/months/2026-10', { budgets: { us: 0 } })).body.budgets).toEqual({});
  });

  it('PATCH /api/months/:key valida, exige que la cuenta exista y da 404 si el mes no existe', async () => {
    const { api } = await seeded();
    const bad: unknown[] = [
      { budgets: { dr: -1 } },
      { budgets: { dr: '70000' } },
      { budgets: { dr: null } },
      { budgets: { dr: 1e13 } },
      { budgets: 70000 },
      { budgets: [70000] },
      { budgets: { 'con espacios': 1 } },
      // El formato anterior (un solo presupuesto, el ingreso y los saldos del mes) ya no existe.
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
    // Una cuenta que no existe: 400, y no se aplica ninguna parte.
    const unknown = await api.patch('/api/months/2026-10', { budgets: { us: 5, 'no-existe': 10 } });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toEqual(unknownAccount('no-existe'));
    expect((await api.get<Month>('/api/months/2026-10')).body.budgets).toEqual({ dr: 70000 });
    expect((await api.patch('/api/months/2031-01', { budgets: { dr: 1 } })).status).toBe(404);
    expect((await api.patch('/api/months/2031-01', {})).status).toBe(404);
  });
});

describe('tasas del mes', () => {
  it('PUT /api/months/:key/rates escribe la tasa de un par desde una fecha: una por par y fecha, también si llega al revés', async () => {
    const { api, sqlite } = await seeded();
    // Octubre ya tiene dos (día 1 y día 6). Escribir la del día 6 otra vez la sustituye.
    const r = await api.put<Month>('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-06' });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe('2026-10');
    expect(r.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-06' },
    ]);
    expect(r.body.fixed).toHaveLength(11);

    // Escribir DOP → USD sustituye a la USD → DOP de esa fecha: es el mismo par.
    const inverse = await api.put<Month>('/api/months/2026-10/rates', { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' });
    expect(inverse.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
    ]);
    // Otra fecha del mismo par se añade; otro par, también.
    await api.put<Month>('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    const third = await api.put<Month>('/api/months/2026-10/rates', { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-02' });
    expect(third.body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-02' },
      { from: 'DOP', to: 'USD', rate: 0.0168, date: '2026-10-06' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' },
    ]);
    expect(count(sqlite, 'month_rates', F)).toBe(4);
    // La tasa del mes es la última; lo de cada día, la vigente ese día.
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').rate).toEqual({ rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-08' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-07')).toEqual({ rate: 1 / 0.0168, source: 'month', monthKey: '2026-10', date: '2026-10-06' });
    expect(rateFor(state, '2026-10', 'USD', 'DOP', '2026-10-05').rate).toBe(58.76);
    // Un mes sin tasa escrita también la admite (septiembre, reabierto).
    await api.post('/api/months/2026-09/reopen');
    expect((await api.put<Month>('/api/months/2026-09/rates', { from: 'USD', to: 'DOP', rate: 58.6, date: '2026-09-15' })).body.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.6, date: '2026-09-15' },
    ]);
  });

  it('escribir hoy una tasa nueva no cambia lo convertido en las transacciones anteriores', async () => {
    const { api } = await seeded();
    // Dos gastos de 10 USD pagados desde la cuenta en DOP: el día 2 y el día 8.
    const usd = { monthKey: '2026-10', desc: 'Domain', cat: 'Subscriptions', method: 'Debit card', amount: 10, cur: 'USD', accountId: 'dr' };
    await api.post('/api/transactions', { ...usd, id: 'early', date: '2026-10-02' });
    const before = (await api.get<StateResponse>('/api/state')).body.state;
    expect(monthCalc(before, '2026-10').varSpent).toBeCloseTo(10845 + 587.6, 8);
    const drBefore = await balance(api, 'dr');
    expect(drBefore).toBeCloseTo(220641.93 - 587.6, 6);

    // El día 8 se escribe 60.
    expect((await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' })).status).toBe(200);
    const after = (await api.get<StateResponse>('/api/state')).body.state;
    // El gasto del día 2 sigue valiendo 587.60 en el mes y en el saldo de la cuenta.
    expect(monthCalc(after, '2026-10').varSpent).toBeCloseTo(10845 + 587.6, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(drBefore, 8);
    // Uno del día 8 ya va a 60.
    await api.post('/api/transactions', { ...usd, id: 'late', date: '2026-10-08' });
    expect(monthCalc((await api.get<StateResponse>('/api/state')).body.state, '2026-10').varSpent).toBeCloseTo(10845 + 587.6 + 600, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(drBefore - 600, 8);
    // Lo que es del mes entero sí sigue a la última: la tasa del mes y el fijo en USD.
    expect(monthCalc(after, '2026-10').rate.rate).toBe(60);
    expect(monthCalc(after, '2026-10').fixedPaid).toBeCloseTo(32076.15 + 106 * 60, 6);
  });

  it('DELETE /api/months/:key/rates/:from/:to?date= quita la de esa fecha, esté guardada en un sentido o en el otro', async () => {
    const { api, sqlite } = await seeded();
    // Octubre las tiene escritas como USD → DOP; se pide al revés. Solo se va la de la fecha pedida.
    const one = await api.del<Month>('/api/months/2026-10/rates/DOP/USD?date=2026-10-06');
    expect(one.status).toBe(200);
    expect(one.body.key).toBe('2026-10');
    expect(one.body.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' }]);
    const r = await api.del<Month>('/api/months/2026-10/rates/USD/DOP?date=2026-10-01');
    expect(r.body.rates).toEqual([]);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    // Sin tasa escrita, la app la saca de los envíos del mes (aquí, la misma cifra).
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').rate).toEqual({ rate: 58.76, source: 'transfers', monthKey: '2026-10', date: null });
    // Quitar la de un par o una fecha que no tiene tasa escrita no es un error: el mes queda igual.
    expect((await api.del<Month>('/api/months/2026-10/rates/USD/DOP?date=2026-10-01')).body).toEqual(r.body);
    expect((await api.del<Month>('/api/months/2026-10/rates/TRY/USD?date=2026-10-03')).status).toBe(200);
    // Sin fecha (o con una que no lo es) no se sabe cuál quitar: 400.
    for (const path of ['/api/months/2026-10/rates/USD/DOP', '/api/months/2026-10/rates/USD/DOP?date=', '/api/months/2026-10/rates/USD/DOP?date=2026-10', '/api/months/2026-10/rates/USD/DOP?date=2026-02-30']) {
      const bad = await api.del(path);
      expect(bad.status, path).toBe(400);
      expect(bad.error?.code, path).toBe('validation');
    }
    expect((await api.del('/api/months/2026-10/rates/USD/DOP')).error?.message).toBe('Invalid data: date: is required');
  });

  it('valida el par y la tasa, y da 404 si el mes no existe', async () => {
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
      // La fecha: obligatoria, una fecha de verdad y dentro del mes de la ruta.
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
    // Solo existen esas dos rutas.
    expect((await api.get('/api/months/2026-10/rates')).status).toBe(404);
    expect((await api.del('/api/months/2026-10/rates/USD')).status).toBe(404);
  });
});

describe('borrar un mes', () => {
  it('DELETE /api/months/:key borra el mes con todo lo suyo, abierto o cerrado, y los saldos cambian en consecuencia', async () => {
    const { api, sqlite } = await seeded();
    expect(await balance(api, 'us')).toBeCloseTo(13482, 8);
    // Septiembre está cerrado.
    const r = await api.del<OkResponse>('/api/months/2026-09');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect((await api.get('/api/months/2026-09')).status).toBe(404);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.key)).toEqual(['2026-08', '2026-10']);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(22);
    expect(count(sqlite, 'transactions', F)).toBe(17);
    expect(count(sqlite, 'transfers', F)).toBe(3);
    expect(count(sqlite, 'month_budget_log', F)).toBe(3);
    // Ya no cuentan sus envíos (2,300 USD) ni su Claude (106 USD); el sueldo de septiembre sí: es un ingreso.
    expect(await balance(api, 'us')).toBeCloseTo(13482 + 2300 + 106, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(60000 + 104730 + 88140 - 27850 - 10845 - 35750.26 - 32076.15, 6);
    expect((await api.get<Income[]>('/api/incomes')).body).toHaveLength(3);
    expect((await api.get<Contribution[]>('/api/contributions')).body).toHaveLength(8);

    // Octubre está abierto y tiene una tasa escrita.
    expect((await api.del('/api/months/2026-10')).status).toBe(200);
    expect(count(sqlite, 'month_rates', F)).toBe(0);
    expect(count(sqlite, 'transactions', F)).toBe(10);
  });

  it('404 si el mes no existe o la clave no es un mes', async () => {
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

describe('cerrar y reabrir', () => {
  it('cerrar crea el mes siguiente con los fijos sin pagar (con su cuenta) y las mismas partes del presupuesto; las tasas no se copian', async () => {
    const { api, sqlite } = await seeded();
    await api.patch('/api/months/2026-10', { budgets: { us: 150 } });
    const october = (await api.get<Month>('/api/months/2026-10')).body;
    const r = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(r.status).toBe(200);

    const { closed, next } = r.body;
    expect(closed.key).toBe('2026-10');
    expect(closed.closed).toBe(true);
    expect(Date.parse(closed.closedAt!)).toBeGreaterThan(Date.now() - 60_000);
    // El mes cerrado conserva todo lo suyo.
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
    // El presupuesto del mes nuevo arranca con un movimiento inicial por cuenta, del día 1.
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
    // Cerrar no mueve ningún saldo: los fijos del mes nuevo nacen sin pagar.
    expect(await balance(api, 'dr', '2026-11')).toBeCloseTo(220641.93, 6);
    // Y sin tasa propia, en noviembre sigue vigente la última escrita.
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-11').rate).toEqual({ rate: 58.76, source: 'previous', monthKey: '2026-10', date: '2026-10-06' });
  });

  it('si el mes siguiente ya existe, cerrar no lo toca ni duplica sus fijos', async () => {
    const { api, sqlite } = await seeded();
    await api.post('/api/months/2026-10/close');
    await api.post('/api/months/2026-10/reopen');

    // Noviembre ya tiene vida propia.
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

  it('cerrar un mes ya cerrado no cambia nada (un reintento no falla)', async () => {
    const { api, sqlite } = await seeded();
    const first = await api.post<CloseResponse>('/api/months/2026-10/close');
    const again = await api.post<CloseResponse>('/api/months/2026-10/close');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(count(sqlite, 'fixed_expenses', F)).toBe(44);
  });

  it('reabrir vuelve a dejar el mes editable', async () => {
    const { api } = await seeded();
    const r = await api.post<Month>('/api/months/2026-08/reopen');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: '2026-08', closed: false, closedAt: null });
    expect(r.body.tx).toHaveLength(10);
    expect((await api.patch('/api/fixed/seed-fx-2026-08-1', { paid: false })).status).toBe(200);
  });

  it('404 si el mes no existe', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/months/2031-01/close')).error?.code).toBe('not_found');
    expect((await api.post('/api/months/2031-01/reopen')).error?.code).toBe('not_found');
    expect((await api.post('/api/months/nada/close')).status).toBe(404);
  });
});

describe('gastos fijos', () => {
  it('crear, editar y borrar', async () => {
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
      // Sin `accountId` se paga de la cuenta por defecto del usuario, sea cual sea la moneda del gasto.
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

  it('acepta el id del cliente y rechaza uno repetido con 409', async () => {
    const { api } = await seeded();
    const body = { id: 'fx_cliente-1', monthKey: '2026-10', name: 'Agua', day: '3', amount: 500, cur: 'DOP', paid: true, accountId: 'us' };
    const r = await api.post<FixedExpense>('/api/fixed', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'fx_cliente-1', day: '3', paid: true, accountId: 'us' });
    const dup = await api.post('/api/fixed', body);
    expect(dup.status).toBe(409);
    expect(dup.error).toEqual({ code: 'conflict', message: 'A record with that id already exists.' });
  });

  it('valida el cuerpo', async () => {
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
      // El usuario va en la cabecera, no en el cuerpo.
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
    // La cuenta tiene que ser una del usuario, al crear y al editar.
    expect((await api.post('/api/fixed', { ...ok, accountId: 'no-existe' })).error).toEqual(unknownAccount('no-existe'));
    const moved = await api.patch('/api/fixed/seed-fx-2026-10-1', { accountId: 'no-existe', paid: false });
    expect(moved.status).toBe(400);
    expect(moved.error).toEqual(unknownAccount('no-existe'));
    expect((await api.get<Month>('/api/months/2026-10')).body.fixed[0]).toMatchObject({ paid: true, accountId: 'dr' });
    expect(count(sqlite, 'fixed_expenses', F)).toBe(33);
  });

  it('un fijo resta de su cuenta solo mientras está marcado como pagado', async () => {
    const { api } = await seeded();
    const dr = await balance(api, 'dr');
    // Netflix: 1,137.30 DOP, sin pagar en octubre.
    const netflix = (await api.get<Month>('/api/months/2026-10')).body.fixed.find((f) => f.name === 'Netflix')!;
    expect(netflix).toMatchObject({ paid: false, accountId: 'dr' });
    await api.patch(`/api/fixed/${netflix.id}`, { paid: true });
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 1137.3, 6);
    await api.patch(`/api/fixed/${netflix.id}`, { paid: false });
    expect(await balance(api, 'dr')).toBeCloseTo(dr, 6);
  });

  it('404 si el mes o el fijo no existen', async () => {
    const { api } = await seeded();
    const noMonth = await api.post('/api/fixed', { monthKey: '2031-01', name: 'Agua', amount: 500, cur: 'DOP' });
    expect(noMonth.status).toBe(404);
    expect(noMonth.error?.code).toBe('not_found');
    expect((await api.patch('/api/fixed/no-existe', { paid: true })).error).toEqual({ code: 'not_found', message: 'Monthly expense not found.' });
    expect((await api.patch('/api/fixed/no-existe', {})).status).toBe(404);
    expect((await api.del('/api/fixed/no-existe')).status).toBe(404);
  });
});

describe('transacciones', () => {
  const tx = { monthKey: '2026-10', date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Debit card', amount: 850, cur: 'DOP' };

  it('crear, editar y borrar', async () => {
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

    // Categoría y método son texto libre: lo que no es de las listas se guarda tal cual, sin traducir.
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

  it('los campos opcionales quedan vacíos; la fecha puede ser de otro mes', async () => {
    const { api } = await seeded();
    const r = await api.post<Transaction>('/api/transactions', { ...tx, date: '2026-11-01' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ monthKey: '2026-10', date: '2026-11-01', place: '', notes: '', accountId: 'dr' });
  });

  it('sale de la cuenta que se indique (o de la de por defecto) y le resta, convertido a la moneda de la cuenta', async () => {
    const { api } = await seeded();
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];
    // 850 DOP desde la cuenta por defecto ('dr').
    await api.post('/api/transactions', tx);
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 850, 6);
    // 1,000 TRY pagados desde la cuenta en USD: sin tasa escrita para TRY, vale la de respaldo (42 por USD).
    const lira = await api.post<Transaction>('/api/transactions', { ...tx, amount: 1000, cur: 'TRY', accountId: 'us' });
    expect(lira.body).toMatchObject({ amount: 1000, cur: 'TRY', accountId: 'us' });
    expect(await balance(api, 'us')).toBeCloseTo(us - 1000 / 42, 6);
    // Cambiarla de cuenta mueve el gasto de un saldo al otro.
    await api.patch(`/api/transactions/${lira.body.id}`, { accountId: 'dr' });
    expect(await balance(api, 'us')).toBeCloseTo(us, 6);
    expect(await balance(api, 'dr')).toBeCloseTo(dr - 850 - (1000 * 58.76) / 42, 6);
    // Si el usuario cambia su cuenta por defecto, lo siguiente sale de ella.
    await api.patch('/api/settings', { defaultAccountId: 'us' });
    expect((await api.post<Transaction>('/api/transactions', tx)).body.accountId).toBe('us');
  });

  it('acepta el id del cliente y rechaza uno repetido con 409', async () => {
    const { api } = await seeded();
    expect((await api.post<Transaction>('/api/transactions', { ...tx, id: 'tx-optimista' })).body.id).toBe('tx-optimista');
    const dup = await api.post('/api/transactions', { ...tx, id: 'tx-optimista' });
    expect(dup.status).toBe(409);
    expect(dup.error?.code).toBe('conflict');
    // También contra un id que ya existía.
    expect((await api.post('/api/transactions', { ...tx, id: 'seed-tx-2026-08-1' })).status).toBe(409);
  });

  it('valida el cuerpo', async () => {
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

  it('un monto no finito no pasa (JSON admite 1e999)', async () => {
    const { api } = await seeded();
    const res = await api.raw('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tx).replace('850', '1e999'),
    });
    expect(res.status).toBe(400);
  });

  it('404 si el mes o la transacción no existen', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/transactions', { ...tx, monthKey: '2031-01' })).error?.code).toBe('not_found');
    expect((await api.patch('/api/transactions/no-existe', { amount: 1 })).error).toEqual({ code: 'not_found', message: 'Transaction not found.' });
    expect((await api.del('/api/transactions/no-existe')).status).toBe(404);
  });
});

describe('envíos', () => {
  const transfer = { monthKey: '2026-10', date: '2026-10-05', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 300, rate: 57.9 };

  it('crear, editar y borrar', async () => {
    const { api } = await seeded();
    const created = await api.post<Transfer>('/api/transfers', transfer);
    expect(created.status).toBe(201);
    // Sin `budget` el envío no mueve presupuesto; sin `fee`, no lleva comisión.
    expect(created.body).toEqual({ id: expect.any(String), ...transfer, budget: false, fee: 0 });
    const id = created.body.id;

    const patched = await api.patch<Transfer>(`/api/transfers/${id}`, { date: '2026-10-06', via: 'Remitly', amount: 350.5, rate: 58.1 });
    expect(patched.body).toEqual({ ...transfer, id, date: '2026-10-06', via: 'Remitly', amount: 350.5, rate: 58.1, budget: false, fee: 0 });
    // También las cuentas: en sentido contrario, con su tasa.
    const reversed = await api.patch<Transfer>(`/api/transfers/${id}`, { fromAccountId: 'dr', toAccountId: 'us', amount: 5810, rate: 1 / 58.1 });
    expect(reversed.body).toEqual({ ...patched.body, fromAccountId: 'dr', toAccountId: 'us', amount: 5810, rate: 1 / 58.1 });
    expect((await api.patch<Transfer>(`/api/transfers/${id}`, {})).body).toEqual(reversed.body);

    expect((await api.del<OkResponse>(`/api/transfers/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/transfers/${id}`)).status).toBe(404);
  });

  it('mueve los dos saldos: de la cuenta de origen sale el monto y a la de destino le entra monto × tasa', async () => {
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

  it('sin `rate` lleva la tasa vigente en su fecha para las monedas de las dos cuentas; entre cuentas de la misma moneda, 1', async () => {
    const { api } = await seeded();
    const { rate: _rate, ...noRate } = transfer;
    // Octubre tiene escrita 1 USD = 58.76 DOP.
    expect((await api.post<Transfer>('/api/transfers', noRate)).body.rate).toBe(58.76);
    const back = await api.post<Transfer>('/api/transfers', { ...noRate, fromAccountId: 'dr', toAccountId: 'us' });
    expect(back.body.rate).toBeCloseTo(1 / 58.76, 12);
    // Se escribe 60 desde el día 6: un envío del día 5 sigue con 58.76; uno del día 6, con 60.
    await api.put('/api/months/2026-10/rates', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-06' });
    expect((await api.post<Transfer>('/api/transfers', noRate)).body.rate).toBe(58.76);
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, date: '2026-10-06' })).body.rate).toBe(60);

    await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' });
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, toAccountId: 'pp' })).body.rate).toBe(1);
    // La que venga se respeta, aunque no sea la del mes.
    expect((await api.post<Transfer>('/api/transfers', { ...noRate, toAccountId: 'pp', rate: 0.97 })).body.rate).toBe(0.97);
  });

  it('`fee`: se guarda y se edita con el envío, le resta a la cuenta de origen y una negativa responde 400', async () => {
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

  it('con `budget: true` mueve presupuesto del mes de la cuenta de origen a la de destino, sin escribir en el registro ni cambiar los saldos', async () => {
    const { api, db } = await seeded();
    const budget = async () => monthCalc(await loadState(db, FRANK.id), '2026-10').budget;
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];

    // 300 USD a 57.9: +17,370 DOP en la DR account y −300 USD (17,628 DOP a la tasa del mes, 58.76) en la US account.
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
    // Los saldos se mueven como con cualquier envío.
    expect(await balance(api, 'us')).toBeCloseTo(us - 300, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(dr + 17370, 6);

    // PATCH { budgets } fija lo que suma el registro: lo del envío va aparte, igual que lo de un ingreso.
    const patched = await api.patch<Month>('/api/months/2026-10', { budgets: { dr: 72000 } });
    expect(patched.body.budgets).toEqual({ dr: 72000 });
    expect(await budget()).toBeCloseTo(72000 + moved, 8);

    // La casilla se quita y se pone con PATCH; lo demás de la fila no cambia.
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

  it('la vía es texto libre: Remitly y PayPal son solo sugerencias', async () => {
    const { api } = await seeded();
    const created = await api.post<Transfer>('/api/transfers', { ...transfer, via: '  Western Union ' });
    expect(created.status).toBe(201);
    expect(created.body.via).toBe('Western Union');
    expect((await api.patch<Transfer>(`/api/transfers/${created.body.id}`, { via: 'Banco Popular (ventanilla)' })).body.via).toBe(
      'Banco Popular (ventanilla)',
    );
    // Lo único que se exige es que no esté vacía ni pase de 60 caracteres.
    expect((await api.post('/api/transfers', { ...transfer, via: 'x'.repeat(61) })).status).toBe(400);
    expect((await api.post('/api/transfers', { ...transfer, via: 'x'.repeat(60) })).status).toBe(201);
  });

  it('dos cuentas distintas y que existan', async () => {
    const { api, sqlite } = await seeded();
    const same = { code: 'validation', message: 'Invalid data: toAccountId: must be different from fromAccountId' };
    const r = await api.post('/api/transfers', { ...transfer, toAccountId: 'us' });
    expect(r.status).toBe(400);
    expect(r.error).toEqual(same);
    // Al editar cuenta también la cuenta que no cambia: seed-tr-2026-10-1 va de 'us' a 'dr'.
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

  it('id del cliente, repetido 409, validación y 404', async () => {
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
      // El formato anterior: solo dólares, sin cuentas.
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

describe('ingresos', () => {
  const income = { date: '2026-10-15', desc: 'Freelance', accountId: 'us', amount: 400, cur: 'USD' };

  it('listar, crear, editar y borrar', async () => {
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
    // Sale en el estado, con los demás.
    expect((await api.get<StateResponse>('/api/state')).body.state.incomes).toHaveLength(4);

    expect((await api.del<OkResponse>(`/api/incomes/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/incomes/${id}`)).status).toBe(404);
    expect((await api.get<Income[]>('/api/incomes')).body).toHaveLength(3);
  });

  it('el ingreso del mes es la suma de los de su fecha, y cada uno entra al saldo de su cuenta', async () => {
    const { api } = await seeded();
    const us = await balance(api, 'us');
    await api.post('/api/incomes', income);
    // Sin cuenta entra a la de por defecto ('dr'); en otra moneda, convertido con la tasa de su mes.
    const extra = await api.post<Income>('/api/incomes', { date: '2026-10-20', amount: 100, cur: 'USD' });
    expect(extra.body).toMatchObject({ accountId: 'dr', desc: '' });
    const { state } = (await api.get<StateResponse>('/api/state')).body;
    expect(monthCalc(state, '2026-10').income).toBeCloseTo((5800 + 400 + 100) * 58.76, 6);
    expect(await balance(api, 'us')).toBeCloseTo(us + 400, 8);
    expect(await balance(api, 'dr')).toBeCloseTo(220641.93 + 5876, 6);
  });

  it('no pertenecen a un mes: valen con cualquier fecha, esté ese mes cerrado o no exista', async () => {
    const { api, sqlite } = await seeded();
    // Agosto está cerrado; 2031 no tiene mes.
    const closed = await api.post<Income>('/api/incomes', { ...income, date: '2026-08-15' });
    expect(closed.status).toBe(201);
    expect((await api.post('/api/incomes', { ...income, date: '2031-01-01' })).status).toBe(201);
    expect((await api.patch<Income>('/api/incomes/seed-in-1', { amount: 6100 })).body).toMatchObject({ date: '2026-08-01', amount: 6100 });
    expect((await api.patch<Income>(`/api/incomes/${closed.body.id}`, { date: '2026-09-15' })).status).toBe(200);
    expect((await api.del(`/api/incomes/${closed.body.id}`)).status).toBe(200);
    expect((await api.del('/api/incomes/seed-in-2')).status).toBe(200);
    // Ni crean el mes de su fecha ni cambian el estado de ninguno.
    expect(count(sqlite, 'months', F)).toBe(3);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.closed)).toEqual([true, true, false]);
  });

  it('id del cliente, repetido 409, validación y 404', async () => {
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
    // La cuenta tiene que existir, al crear y al cambiarla.
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

describe('mes cerrado = solo lectura', () => {
  it('no se pueden crear, editar ni borrar fijos, transacciones ni envíos, ni cambiar su presupuesto o sus tasas', async () => {
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
      // El mensaje va en inglés, con el nombre del mes en inglés; la web lo traduce por el código.
      expect(r.error).toEqual({ code: 'month_closed', message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' });
    }
    expect(await loadState(db, F)).toEqual(before);
  });

  it('el mensaje no depende del idioma del usuario', async () => {
    const { api } = await seeded();
    await api.patch('/api/settings', { language: 'es' });
    expect((await api.del('/api/fixed/seed-fx-2026-09-1')).error?.message).toMatch(/^September 2026 is closed/);
  });

  it('lo que no es del mes sí se puede tocar: los ingresos y los aportes con fecha en él', async () => {
    const { api } = await seeded();
    expect((await api.patch<Income>('/api/incomes/seed-in-1', { amount: 6100 })).status).toBe(200);
    expect((await api.post('/api/incomes', { date: '2026-08-20', amount: 50, cur: 'USD' })).status).toBe(201);
    expect((await api.post('/api/contributions', { goalId: 'personal', date: '2026-08-20', amount: 50, cur: 'USD' })).status).toBe(201);
    // Y las cuentas, aunque sus movimientos estén en meses cerrados.
    expect((await api.patch('/api/accounts/dr', { opening: 61000, name: 'Popular' })).status).toBe(200);
    expect((await api.get<Month>('/api/months/2026-08')).body.closed).toBe(true);
  });

  it('reabrir, y entonces sí se puede escribir', async () => {
    const { api } = await seeded();
    expect((await api.post('/api/months/2026-08/reopen')).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', { budgets: { dr: 1 } })).status).toBe(200);
    expect((await api.put('/api/months/2026-08/rates', { from: 'USD', to: 'DOP', rate: 58, date: '2026-08-01' })).status).toBe(200);
    expect((await api.del('/api/months/2026-08/rates/USD/DOP?date=2026-08-01')).status).toBe(200);
    expect((await api.del('/api/transactions/seed-tx-2026-08-1')).status).toBe(200);
    expect((await api.post('/api/fixed', { monthKey: '2026-08', name: 'Agua', amount: 500, cur: 'DOP' })).status).toBe(201);
  });

  it('un mes cerrado se puede borrar sin reabrirlo', async () => {
    const { api } = await seeded();
    expect((await api.del('/api/months/2026-08')).status).toBe(200);
    expect((await api.get<MonthSummary[]>('/api/months')).body.map((m) => m.key)).toEqual(['2026-09', '2026-10']);
  });

  it('un patch vacío sobre una fila de un mes cerrado solo la lee', async () => {
    const { api } = await seeded();
    expect((await api.patch('/api/transactions/seed-tx-2026-08-1', {})).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', {})).status).toBe(200);
  });
});

describe('metas', () => {
  it('listar, crear, editar y borrar', async () => {
    const { api } = fresh();
    // Un usuario que todavía no abrió la app no tiene metas: se las crea su primera visita.
    expect((await api.get<Goal[]>('/api/goals')).body).toEqual([]);
    await api.get('/api/state');
    expect((await api.get<Goal[]>('/api/goals')).body).toEqual([...DEFAULT_GOALS]);

    const created = await api.post<Goal>('/api/goals', { name: ' Car ' });
    expect(created.status).toBe(201);
    // Sin `cur`, la meta queda en la moneda principal del usuario (DOP).
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
    // null en los tres vuelve a "aportes variables".
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

  it('la moneda de una meta: la que venga o, si no, la principal del usuario en ese momento', async () => {
    const { api } = await seeded();
    expect((await api.post<Goal>('/api/goals', { name: 'A' })).body.cur).toBe('DOP');
    await api.patch('/api/settings', { mainCurrency: 'TRY' });
    expect((await api.post<Goal>('/api/goals', { name: 'B' })).body.cur).toBe('TRY');
    expect((await api.post<Goal>('/api/goals', { name: 'C', cur: 'USD' })).body.cur).toBe('USD');
    // Cambiar la moneda principal no cambia la de las metas que ya existen.
    expect((await api.get<Goal[]>('/api/goals')).body.map((g) => g.cur)).toEqual(['USD', 'USD', 'USD', 'DOP', 'TRY', 'USD']);
    for (const cur of ['EUR', 'usd', null, '']) {
      expect((await api.post('/api/goals', { name: 'D', cur })).status, String(cur)).toBe(400);
      expect((await api.patch('/api/goals/turkey', { cur })).status, String(cur)).toBe(400);
    }
  });

  it('el nombre de una meta es dato del usuario: se guarda tal cual, en cualquier idioma', async () => {
    const { api } = fresh();
    const r = await api.post<Goal>('/api/goals', { name: 'Türkiye tatili ✈️' });
    expect(r.body.name).toBe('Türkiye tatili ✈️');
    expect((await api.patch<Goal>(`/api/goals/${r.body.id}`, { name: 'Viaje a Turquía' })).body.name).toBe('Viaje a Turquía');
  });

  it('plan al crear: monthly, start y end van juntos (o ninguno)', async () => {
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

    // Un solo mes es un plan válido; y los tres null (o ausentes), una meta de aportes variables.
    expect((await api.post<Goal>('/api/goals', { name: 'a', monthly: 100, start: '2026-10', end: '2026-10' })).status).toBe(201);
    expect((await api.post<Goal>('/api/goals', { name: 'b', monthly: null, start: null, end: null })).body).toMatchObject({
      monthly: null,
      start: null,
      end: null,
    });
  });

  it('plan al editar: se valida la meta resultante, no solo lo que viene', async () => {
    const { api } = await seeded();
    // 'turkey' tiene plan: mandar solo `end` (o solo el mensual) vale.
    expect((await api.patch<Goal>('/api/goals/turkey', { end: '2028-01' })).body).toEqual({ ...SEED_PLANNED_GOAL, end: '2028-01' });
    expect((await api.patch<Goal>('/api/goals/turkey', { monthly: 2000 })).body).toMatchObject({ monthly: 2000, start: '2026-08', end: '2028-01' });
    // Lo que deja el plan a medias o al revés, no.
    for (const body of [{ monthly: null }, { start: null }, { end: null }, { start: null, end: null }, { start: '2028-02' }, { end: '2026-07' }]) {
      const r = await api.patch('/api/goals/turkey', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    // 'personal' no tiene plan: mandar solo una parte es un 400; los tres juntos, no.
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

  it('el nombre es único por usuario sin distinguir mayúsculas: 409 conflict', async () => {
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

    // Reescribir su propio nombre (o solo cambiarle las mayúsculas) no es un conflicto.
    expect((await api.patch<Goal>('/api/goals/personal', { name: 'PERSONAL SAVINGS' })).body.name).toBe('PERSONAL SAVINGS');
    // Con tildes también cuenta.
    expect((await api.post('/api/goals', { name: 'Educación' })).status).toBe(201);
    expect((await api.post('/api/goals', { name: 'EDUCACIÓN' })).status).toBe(409);
    // Borrada la meta, el nombre queda libre.
    for (const c of ['seed-ct-2', 'seed-ct-5', 'seed-ct-8']) await api.del(`/api/contributions/${c}`);
    expect((await api.del('/api/goals/emergency')).status).toBe(200);
    expect((await api.post('/api/goals', { name: 'emergency fund' })).status).toBe(201);
  });

  it('valida y da 404', async () => {
    const { api } = await seeded();
    // `monthlyUSD` era el nombre del mensual cuando todas las metas iban en dólares.
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

  it('no se puede borrar una meta con aportes (409)', async () => {
    const { api } = await seeded();
    const r = await api.del('/api/goals/turkey');
    expect(r.status).toBe(409);
    expect(r.error).toEqual({ code: 'conflict', message: 'The goal has contributions: delete or move them before deleting it.' });
    expect((await api.get<Goal[]>('/api/goals')).body).toHaveLength(3);
    // Sin aportes (borrados o movidos a otra meta) ya se puede.
    await api.del('/api/contributions/seed-ct-1');
    await api.patch('/api/contributions/seed-ct-4', { goalId: 'personal' });
    await api.patch('/api/contributions/seed-ct-7', { goalId: 'personal' });
    expect((await api.del('/api/goals/turkey')).status).toBe(200);
  });
});

describe('aportes', () => {
  const contribution = { goalId: 'emergency', date: '2026-10-07', amount: 150, cur: 'USD' };

  it('listar, crear, editar y borrar', async () => {
    const { api } = await seeded();
    expect((await api.get<Contribution[]>('/api/contributions')).body).toEqual(seedState().contribs);

    const created = await api.post<Contribution>('/api/contributions', contribution);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), ...contribution, rate: null, accountId: null });
    const id = created.body.id;

    const patched = await api.patch<Contribution>(`/api/contributions/${id}`, { goalId: 'personal', date: '2026-10-08', amount: 9000, cur: 'DOP' });
    expect(patched.body).toEqual({ id, goalId: 'personal', date: '2026-10-08', amount: 9000, cur: 'DOP', rate: null, accountId: null });
    expect((await api.patch<Contribution>(`/api/contributions/${id}`, { amount: 0 })).body.amount).toBe(0);
    // En cualquiera de las tres monedas.
    expect((await api.patch<Contribution>(`/api/contributions/${id}`, { amount: 4200, cur: 'TRY' })).body).toMatchObject({ amount: 4200, cur: 'TRY' });

    expect((await api.del<OkResponse>(`/api/contributions/${id}`)).body).toEqual({ ok: true });
    expect((await api.del(`/api/contributions/${id}`)).status).toBe(404);
    expect((await api.get<Contribution[]>('/api/contributions')).body).toHaveLength(8);
  });

  it('los aportes no dependen de que el mes esté cerrado, y no mueven el saldo de ninguna cuenta', async () => {
    const { api } = await seeded();
    const [us, dr] = [await balance(api, 'us'), await balance(api, 'dr')];
    expect((await api.post('/api/contributions', { ...contribution, date: '2026-08-15' })).status).toBe(201);
    expect((await api.post('/api/contributions', { ...contribution, amount: 5000, cur: 'DOP' })).status).toBe(201);
    expect((await api.del('/api/contributions/seed-ct-1')).status).toBe(200);
    expect([await balance(api, 'us'), await balance(api, 'dr')]).toEqual([us, dr]);
  });

  it('id del cliente, repetido 409, validación y 404', async () => {
    const { api } = await seeded();
    expect((await api.post<Contribution>('/api/contributions', { ...contribution, id: 'ct-1' })).body.id).toBe('ct-1');
    expect((await api.post('/api/contributions', { ...contribution, id: 'ct-1' })).error?.code).toBe('conflict');

    for (const body of [{ ...contribution, amount: 0 }, { ...contribution, cur: 'EUR' }, { ...contribution, date: '2026-10-32' }, { ...contribution, goalId: '' }, { ...contribution, goal: 'emergency' }]) {
      expect((await api.post('/api/contributions', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await api.patch('/api/contributions/ct-1', { amount: -1 })).status).toBe(400);

    // La meta tiene que existir, al crear y al mover.
    const noGoal = await api.post('/api/contributions', { ...contribution, goalId: 'no-existe' });
    expect(noGoal.status).toBe(404);
    expect(noGoal.error).toEqual({ code: 'not_found', message: 'Goal not found.' });
    expect((await api.patch('/api/contributions/ct-1', { goalId: 'no-existe' })).error?.message).toBe('Goal not found.');
    expect((await api.patch('/api/contributions/no-existe', { goalId: 'emergency' })).error?.message).toBe('Contribution not found.');
    expect((await api.patch('/api/contributions/no-existe', { amount: 1 })).status).toBe(404);
    expect((await api.del('/api/contributions/no-existe')).status).toBe(404);
  });
});

describe('dos usuarios por la API', () => {
  it('cada uno lee y cambia solo lo suyo, aunque los ids, las cuentas y los meses coincidan', async () => {
    const { api, eda, db } = await pair();
    const before = await loadState(db, E);

    // Frank cambia filas cuyos ids también tiene Eda.
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
    // Frank ve lo suyo en su moneda principal (USD): 1 DOP a 60 más 2 USD.
    const mine = (await api.get<MonthSummary[]>('/api/months')).body[2]!;
    expect(mine).toMatchObject({ main: 'USD', txCount: 6 });
    expect(mine.budget).toBeCloseTo(1 / 60 + 2, 10);
    // Y el saldo de la cuenta 'dr' de Eda sigue siendo el de los datos de ejemplo.
    expect(await balance(eda, 'dr')).toBeCloseTo(220641.93, 6);

    // Y Eda cambia las suyas sin deshacer lo de Frank.
    const frank = await loadState(db, F);
    await eda.patch('/api/transactions/seed-tx-2026-10-1', { amount: 999 });
    await eda.patch('/api/accounts/us', { name: 'De Eda' });
    await eda.post('/api/incomes', { id: 'seed-in-2', date: '2026-10-09', amount: 5, cur: 'TRY' });
    await eda.post('/api/months/2026-10/close');
    expect(await loadState(db, F)).toEqual(frank);
    expect((await api.get<Month>('/api/months/2026-10')).body.closed).toBe(false);
    expect((await api.get('/api/months/2026-11')).status).toBe(404);
    expect((await eda.get<Month>('/api/months/2026-11')).body.fixed).toHaveLength(11);
    // Borrar un mes es solo de quien lo borra.
    expect((await api.del('/api/months/2026-10')).status).toBe(200);
    expect((await eda.get<Month>('/api/months/2026-10')).body.tx).toHaveLength(7);
  });

  it('un id que existe pero es de otro usuario responde 404, igual que uno que no existe', async () => {
    const { api, eda, db } = await pair();
    // Filas que solo tiene Frank.
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
      // Ni el estado ni el mensaje delatan que el id existe en las finanzas de otro.
      if (!what.endsWith('mes')) expect(foreign.error, what).toEqual(missing.error);
    }
    expect([await loadState(db, F), await loadState(db, E)]).toEqual(before);
  });

  it('una cuenta de otro usuario no sirve para pagar, cobrar, enviar ni presupuestar: 400, como una que no existe', async () => {
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
    // Para su dueño sí es una cuenta.
    expect((await api.post('/api/transactions', { ...tx, accountId: 'acc-frank' })).status).toBe(201);
  });

  it('el mismo id del cliente vale para una fila de cada usuario; repetido en el mismo, 409', async () => {
    const { api, eda } = await pair();
    const tx = { id: 'tx-igual', monthKey: '2026-10', date: '2026-10-07', desc: 'x', cat: 'Food', method: 'Debit card', amount: 1, cur: 'DOP' };
    expect((await api.post('/api/transactions', tx)).status).toBe(201);
    expect((await eda.post('/api/transactions', { ...tx, amount: 2 })).status).toBe(201);
    expect((await api.post('/api/transactions', tx)).status).toBe(409);
    expect((await api.post('/api/goals', { id: 'g', name: 'Car' })).status).toBe(201);
    // Mismo id y mismo nombre de meta (y de cuenta), pero de otra persona.
    expect((await eda.post('/api/goals', { id: 'g', name: 'Car' })).status).toBe(201);
    expect((await api.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'USD' })).status).toBe(201);
    expect((await eda.post('/api/accounts', { id: 'pp', name: 'PayPal', currency: 'TRY' })).status).toBe(201);
    expect((await api.post('/api/accounts', { id: 'pp', name: 'Otra', currency: 'USD' })).status).toBe(409);
    expect((await api.patch<Transaction>('/api/transactions/tx-igual', {})).body.amount).toBe(1);
    expect((await eda.patch<Transaction>('/api/transactions/tx-igual', {})).body.amount).toBe(2);
    expect((await api.patch<Account>('/api/accounts/pp', {})).body.currency).toBe('USD');
    expect((await eda.patch<Account>('/api/accounts/pp', {})).body.currency).toBe('TRY');
  });

  it('un mes cerrado para uno no es de solo lectura para el otro', async () => {
    const { api, eda } = await pair();
    expect((await api.post('/api/months/2026-08/reopen')).status).toBe(200);
    expect((await api.del('/api/transactions/seed-tx-2026-08-1')).status).toBe(200);
    expect((await api.patch('/api/months/2026-08', { budgets: { dr: 1 } })).status).toBe(200);
    expect((await eda.del('/api/transactions/seed-tx-2026-08-1')).error?.code).toBe('month_closed');
    expect((await eda.patch('/api/months/2026-08', { budgets: { dr: 1 } })).error?.code).toBe('month_closed');
  });
});

describe('importar (JSON)', () => {
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

  it('upsert por mes; aportes sustituidos; metas creadas por nombre y plan actualizado', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const r = await api.post<ImportResponse>('/api/import', payload);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ months: ['2026-10', '2026-11'], contributions: 1 });

    const after = await loadState(db, F);
    expect(Object.keys(after.months)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(after.months['2026-08']).toEqual(before.months['2026-08']);
    expect(after.months['2026-09']).toEqual(before.months['2026-09']);

    // El libro solo conoce dos cuentas: todo cae en la cuenta en USD y en la de DOP del usuario.
    const oct = after.months['2026-10']!;
    expect(oct).toMatchObject({ closed: true, budgets: { dr: 60000 }, rates: [] });
    expect(oct.closedAt).not.toBeNull();
    expect(oct.fixed.map((f) => [f.name, f.accountId])).toEqual([['Luz', 'dr']]);
    expect(oct.transfers.map((t) => [t.via, t.fromAccountId, t.toAccountId, t.amount, t.rate])).toEqual([['Remitly', 'us', 'dr', 1000, 59]]);
    expect(oct.tx.map((t) => [t.desc, t.accountId, t.source])).toEqual([['Café', 'dr', 'import']]);
    expect(after.months['2026-11']).toMatchObject({ closed: false, closedAt: null, budgets: { dr: 60000 }, fixed: [], transfers: [], tx: [] });
    // El ingreso del libro es el total del mes: octubre ya tenía registrados 5,800 USD (más que los 5,000 del
    // libro) y no recibe ninguno; noviembre, que no tenía, recibe el suyo. Los saldos del último mes son los del libro.
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
    // Los ajustes no vienen en el libro: se quedan como estaban.
    expect([after.mainCurrency, after.secondCurrency, after.defaultAccountId, after.language]).toEqual(['DOP', 'USD', 'dr', 'en']);
  });

  it('contribs y goals en null dejan los aportes y las metas como estaban', async () => {
    const { api, db } = await seeded();
    const r = await api.post<ImportResponse>('/api/import', { ...payload, contribs: null, goals: null });
    expect(r.body).toEqual({ months: ['2026-10', '2026-11'], contributions: 0 });
    const after = await loadState(db, F);
    expect(after.contribs).toEqual(seedState().contribs);
    expect(after.goals).toEqual(seedState().goals);
  });

  it('un cuerpo inválido da 400 y no cambia nada', async () => {
    const { api, db } = await seeded();
    const before = await loadState(db, F);
    const month = payload.months[0]!;
    const goal = payload.goals![0]!;
    const bad: unknown[] = [
      {},
      { ...payload, months: 'x' },
      { ...payload, extra: 1 },
      // El formato anterior (parámetros de una sola meta) ya no existe.
      { months: payload.months, contribs: payload.contribs, turkey: { monthlyUSD: 3200, start: null, end: null } },
      { months: payload.months, contribs: payload.contribs },
      { ...payload, months: [month, month] },
      { ...payload, months: [{ ...month, key: 'October 2026' }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], date: '' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], amount: '250' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], id: 'x' }] }] },
      { ...payload, months: [{ ...month, fixed: [{ ...month.fixed[0], cur: 'EUR' }] }] },
      // El libro solo conoce DOP y USD, y no trae cuentas ni partes del presupuesto.
      { ...payload, months: [{ ...month, fixed: [{ ...month.fixed[0], cur: 'TRY' }] }] },
      { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], accountId: 'dr' }] }] },
      { ...payload, months: [{ ...month, budgets: { dr: 1 } }] },
      { ...payload, accounts: [] },
      { ...payload, months: [{ ...month, transfers: [{ ...month.transfers[0], usd: -1 }] }] },
      { ...payload, contribs: [{ date: '2026-10-05', goalName: '', amount: 1, cur: 'USD' }] },
      { ...payload, goals: [{ ...goal, name: '' }] },
      { ...payload, goals: [{ ...goal, start: 'agosto' }] },
      { ...payload, goals: [{ ...goal, id: 'turkey' }] },
      // Medio plan no significa nada: se rechaza el archivo en vez de borrar o inventar el objetivo.
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

  it('acepta lo que acepta el importador del prototipo: monto 0, descripción vacía, día numérico', async () => {
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
    // Sin presupuesto ni ingreso en el libro no queda ninguna parte ni ningún ingreso.
    expect(m.budgets).toEqual({});
    expect(state.incomes).toEqual([]);
  });

  it('el mensaje de validación dice dónde está el problema, en inglés', async () => {
    const { api } = fresh();
    const month = payload.months[0]!;
    const r = await api.post('/api/import', { ...payload, months: [{ ...month, tx: [{ ...month.tx[0], date: '3 de octubre' }] }] });
    expect(r.error?.message).toBe('Invalid data: months.0.tx.0.date: is not a valid date (YYYY-MM-DD)');
    const plan = await api.post('/api/import', { ...payload, goals: [payload.goals![1], { ...payload.goals![0], end: null }] });
    expect(plan.error?.message).toBe(
      'Invalid data: goals.1.monthlyUSD: monthlyUSD, start and end go together: set all three, or leave all three null',
    );
  });

  it('quien importa antes de abrir la app no acaba con las metas iniciales repetidas', async () => {
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

describe('rutas de desarrollo', () => {
  it('sin ALLOW_DEV_RESET=1 responden 404 (con o sin X-User) y no tocan nada', async () => {
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

  it('seed carga los datos de ejemplo solo para ese usuario y conserva su idioma y sus colores', async () => {
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
    // Las monedas y la cuenta por defecto son las de los datos de ejemplo (van con sus cuentas): DOP, USD y 'dr'.
    const expected: AppState = { ...seedState(), language: 'tr', theme: ocean };
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);
    expect(await loadState(db, E)).toEqual(edaBefore);
    // Repetirlo deja lo mismo.
    await api.post('/api/goals', { id: 'extra', name: 'Extra' });
    await api.post('/api/incomes', { date: '2026-10-07', amount: 1, cur: 'USD' });
    await api.post('/api/dev/seed');
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);

    // Los dos pueden tener los datos de ejemplo a la vez (mismos ids).
    expect((await eda.post('/api/dev/seed')).status).toBe(200);
    expect(withoutTimestamps(await loadState(db, E))).toEqual(seedState());
    expect(withoutTimestamps(await loadState(db, F))).toEqual(expected);
  });

  it('reset deja a ese usuario como recién llegado: cuentas y metas iniciales, mes actual, y sus ajustes', async () => {
    const { api, db, sqlite } = await seeded({ ALLOW_DEV_RESET: '1' });
    await api.patch('/api/settings', { language: 'es' });
    await api.post('/api/goals', { id: 'extra', name: 'Extra' });
    await api.post('/api/accounts', { id: 'extra', name: 'Extra', currency: 'TRY' });

    const reset = await api.post<OkResponse>('/api/dev/reset');
    expect(reset.body).toEqual({ ok: true });
    const state = await loadState(db, F);
    // La cuenta por defecto de los datos de ejemplo ('dr') no se conserva: las cuentas son otras, recién creadas.
    expect(state).toEqual(arrivedState('es'));
    for (const table of ['incomes', 'transactions', 'transfers', 'fixed_expenses', 'contributions', 'month_budget_log', 'month_rates']) {
      expect(count(sqlite, table, F), table).toBe(0);
    }
    // Abrir la app después no añade nada.
    expect((await api.get<StateResponse>('/api/state')).body.state).toEqual(state);
  });

  it('reset también vale para quien nunca había entrado', async () => {
    const { api, sqlite } = fresh({ ALLOW_DEV_RESET: '1' });
    expect((await api.post('/api/dev/reset')).status).toBe(200);
    expect((await api.get<StateResponse>('/api/state')).body.state).toEqual(arrivedState());
    expect(count(sqlite, 'goals')).toBe(2);
    expect(count(sqlite, 'accounts')).toBe(2);
  });
});

describe('errores y cabeceras', () => {
  it('ruta desconocida: 404 not_found con cuerpo ApiErrorBody', async () => {
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

  it('JSON mal formado o ausente: 400 validation', async () => {
    const { api } = await seeded();
    for (const body of ['{"budget": 1', '', 'budget=1', '￾']) {
      const res = await api.raw('/api/months/2026-10', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The request body is not valid JSON.' } });
    }
    expect((await api.raw('/api/settings', { method: 'PATCH', body: '' })).status).toBe(400);
  });

  it('un cuerpo demasiado grande: 413', async () => {
    const { api } = await seeded();
    const big = JSON.stringify({ monthKey: '2026-10', name: 'x'.repeat(MAX_JSON_BYTES), amount: 1, cur: 'DOP' });
    const res = await api.raw('/api/fixed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'validation', message: 'The request body is too large.' } });
    // También si Content-Length lo declara, sin leer el cuerpo.
    const declared = await api.raw('/api/fixed', { method: 'POST', headers: { 'Content-Length': String(MAX_JSON_BYTES + 1) }, body: '{}' });
    expect(declared.status).toBe(413);
  });

  it('un fallo inesperado da 500 internal sin filtrar detalles, y queda en el log', async () => {
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

  it('los errores esperados no ensucian el log', async () => {
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

  it('todas las respuestas JSON llevan Cache-Control: no-store', async () => {
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

  it('rechaza escrituras lanzadas desde otro sitio (CSRF), pero no las lecturas ni las del mismo origen', async () => {
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
