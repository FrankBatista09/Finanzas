import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { balances, monthCalc } from '../shared/calc';
import { CATS, METHODS, TIMEZONE, VIAS } from '../shared/constants';
import { f2 } from '../shared/format';
import { seedState } from '../shared/seed';
import type { AppState, FixedExpense, Income, MonthKey, Transaction, Transfer } from '../shared/types';
import {
  closeMonth,
  addBudgetEntry,
  addLeftover,
  createAccount,
  createCard,
  createFixed,
  getMonth,
  listIncomes,
  loadState,
  patchAccount,
  patchMonth,
  payCardPurchases,
  replaceAll,
  setCardOther,
  setMonthRate,
  updateSettings,
} from './db';
import type { Env } from './env';
import { INTERNAL_MESSAGE } from './errors';
import {
  handleMcp,
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  MAX_BATCH,
  MAX_BODY_BYTES,
  MODERN_PROTOCOL_VERSIONS,
  PROTOCOL_VERSIONS,
  SERVER_INFO,
} from './mcp';
import { count, EDA, FRANK, makeEnv, TOKEN } from './test-util';
import type { TestEnv } from './test-util';

const URL_MCP = 'https://finanzas.example/mcp';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
/** Noon on October 7, 2026 in Santo Domingo: the current month of the sample data. */
const NOW = new Date('2026-10-07T16:00:00Z');
const F = FRANK.id;
const E = EDA.id;

const TOOL_NAMES = ['add_transaction', 'add_outside_expense', 'list_transactions', 'month_summary', 'add_transfer', 'mark_fixed_paid', 'add_income', 'list_accounts', 'pay_credit_card', 'list_credit_cards', 'add_budget_extra'];
const FIXED_NAMES = 'Electricity, Internet, Health insurance, Fridge payment, Claude, Google One, iCloud+, Cluely, Smartfit, Netflix, Unicaribe';
/** How an error names the test users: the id that goes in `user` and each one's name. */
const BOTH = 'frank (Frank), eda (Eda)';
const ASK = 'If it is not clear whose finances are meant, ask the person; do not guess.';
const SERVER = { name: 'fe-finance', title: 'FE Finance', version: SERVER_INFO.version };
/** Remnants of the Spanish version: nothing the model reads may carry them. */
const SPANISH = /[áéíóúñ¿¡«»]/i;
/** The usual transfer: from the dollar account to the peso account (the two accounts of the sample data). */
const US_TO_DR = { from_account: 'US account', to_account: 'DR account' };

interface RpcBody {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Reply {
  status: number;
  headers: Headers;
  /** The body as is ('' if there is none). */
  raw: string;
  /** The body as JSON, or null if it is not JSON. */
  body: unknown;
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Called {
  text: string;
  isError: boolean;
  data: Record<string, any> | undefined;
}

async function send(env: Env, init: RequestInit, now: Date = NOW): Promise<Reply> {
  const res = await handleMcp(new Request(URL_MCP, init), env, now);
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // No body (202).
  }
  return { status: res.status, headers: res.headers, raw, body };
}

function post(env: Env, payload: unknown, headers: Record<string, string> = AUTH, now: Date = NOW): Promise<Reply> {
  return send(
    env,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    },
    now,
  );
}

let nextId = 1;

async function rpc(env: Env, method: string, params?: unknown, now: Date = NOW): Promise<RpcBody> {
  const id = nextId++;
  const r = await post(env, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, AUTH, now);
  expect(r.status).toBe(200);
  expect(r.headers.get('Content-Type')).toBe('application/json');
  const body = r.body as RpcBody;
  expect(body).toMatchObject({ jsonrpc: '2.0', id });
  return body;
}

/** Calls a tool with the arguments as is (without `user` if they do not include it). */
async function callRaw(env: Env, name: string, args?: Record<string, unknown>, now: Date = NOW): Promise<Called> {
  const body = await rpc(env, 'tools/call', args === undefined ? { name } : { name, arguments: args }, now);
  expect(body.error).toBeUndefined();
  const result = body.result as ToolResult;
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return { text: result.content[0]!.text, isError: result.isError === true, data: result.structuredContent };
}

/** Calls as Frank, who is the one speaking in these tests unless the arguments say otherwise. */
function call(env: Env, name: string, args: Record<string, unknown> = {}, now: Date = NOW): Promise<Called> {
  return callRaw(env, name, { user: F, ...args }, now);
}

/** A call (with the arguments as is) that must fail as a tool error: returns the message. */
async function failsRaw(env: Env, name: string, args?: Record<string, unknown>, now: Date = NOW): Promise<string> {
  const r = await callRaw(env, name, args, now);
  expect(r.isError, r.text).toBe(true);
  expect(r.data).toBeUndefined();
  return r.text;
}

/** A call by Frank that must fail as a tool error: returns the message. */
function fails(env: Env, name: string, args: Record<string, unknown> = {}, now: Date = NOW): Promise<string> {
  return failsRaw(env, name, { user: F, ...args }, now);
}

let bystander: { db: D1Database; before: AppState } | null = null;

/**
 * Both users with the same sample data (and therefore the same ids). In the tests that use it only Frank
 * acts: when each one ends, it is checked that Eda's data is still exactly the same.
 */
async function seeded(): Promise<TestEnv> {
  const t = makeEnv();
  // The same instant for both: some tests compare one state with the other, createdAt included.
  const at = new Date();
  await replaceAll(t.db, F, seedState(), at);
  await replaceAll(t.db, E, seedState(), at);
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

/** A database that stops answering batch reads as soon as `table` has one more row. */
function failsAfterWrite(t: TestEnv, table: string): Env {
  const before = count(t.sqlite, table);
  const DB = new Proxy(t.db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) =>
          count(t.sqlite, table) > before ? Promise.reject(new Error('D1 no responde')) : target.batch(statements);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...t.env, DB };
}

/**
 * The balance of an account according to shared/calc.ts at the end of `asOf`: what each tool reports after
 * writing must be exactly this.
 */
async function balanceOf(db: D1Database, accountId: string, user: string = F, asOf: MonthKey = '2026-10'): Promise<number> {
  return balances(await loadState(db, user), asOf).accounts.find((a) => a.account.id === accountId)!.balance;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const watched = bystander;
  bystander = null;
  if (watched) expect(await loadState(watched.db, E)).toEqual(watched.before);
});

describe('/mcp: authentication', () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  it('401 without a token, with a wrong token or with another scheme', async () => {
    const { env, sqlite } = await seeded();
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer otro-token' },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { Authorization: 'Bearer ' },
      { Authorization: TOKEN },
      { Authorization: `Basic ${TOKEN}` },
      // Saying who you are does not replace the token.
      { 'X-User': F },
    ];
    for (const headers of attempts) {
      const r = await post(
        env,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850 } } },
        headers,
      );
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      // The same body as the rest of the API.
      expect(r.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid or missing token.' } });
    }
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('always 401 if API_TOKEN is not configured', async () => {
    const { db } = makeEnv();
    for (const env of [{ DB: db }, { DB: db, API_TOKEN: '' }] satisfies Env[]) {
      for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }, AUTH]) {
        const r = await post(env, ping, headers);
        expect(r.status).toBe(401);
        expect(r.headers.get('WWW-Authenticate')).toBe('Bearer');
      }
    }
  });

  it('the token is checked before looking at the body, the method or the configuration', async () => {
    const { env } = makeEnv();
    expect((await post(env, '{"jsonrpc":', {})).status).toBe(401);
    expect((await send(env, { method: 'GET' })).status).toBe(401);
    expect((await send(env, { method: 'DELETE' })).status).toBe(401);
    // Not even a malformed USERS shows through without the token.
    expect((await post(makeEnv({ USERS: 'Frank Reyes' }).env, ping, {})).status).toBe(401);
  });

  it('with the right token it answers (the scheme is case-insensitive)', async () => {
    const { env } = makeEnv();
    for (const headers of [AUTH, { Authorization: `bearer ${TOKEN}` }]) {
      const r = await post(env, ping, headers);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    }
  });
});

describe('/mcp: transport', () => {
  it('GET and DELETE answer 405 with Allow: POST (no SSE or sessions)', async () => {
    const { env } = makeEnv();
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const r = await send(env, { method, headers: { ...AUTH, Accept: 'text/event-stream' } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('Allow')).toBe('POST');
      expect(r.headers.get('Mcp-Session-Id')).toBeNull();
      expect(r.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    }
  });

  it('malformed JSON: 400 with error -32700', async () => {
    const { env } = makeEnv();
    const bodies: (string | Uint8Array)[] = ['{"jsonrpc":', '', 'ping', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])];
    for (const body of bodies) {
      const r = await send(env, { method: 'POST', headers: AUTH, body });
      expect(r.status).toBe(400);
      expect(r.headers.get('Content-Type')).toBe('application/json');
      expect(r.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The request body is not valid JSON.' } });
    }
  });

  it('invalid JSON-RPC request: 400 with error -32600 (and the id, if it could be read)', async () => {
    const { env } = makeEnv();
    const bad: [unknown, string | number | null][] = [
      // (post sends text as is: this is the JSON of a string)
      ['"hola"', null],
      [42, null],
      [null, null],
      [{}, null],
      [{ jsonrpc: '2.0', id: 7 }, 7],
      [{ jsonrpc: '1.0', id: 7, method: 'ping' }, 7],
      [{ id: 'a', method: 'ping' }, 'a'],
      [{ jsonrpc: '2.0', id: 7, method: 5 }, 7],
      [{ jsonrpc: '2.0', id: null, method: 'ping' }, null],
      [{ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }, null],
      [{ jsonrpc: '2.0', id: null, result: {} }, null],
    ];
    for (const [payload, id] of bad) {
      const r = await post(env, payload);
      expect(r.status, JSON.stringify(payload)).toBe(400);
      expect(r.body).toEqual({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
    }
  });

  it('a notification or a response from the client: 202 with no body', async () => {
    const { env } = makeEnv();
    const accepted: unknown[] = [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'x' } },
      // Without an id there is nobody to answer, not even with "method not found".
      { jsonrpc: '2.0', method: 'no/existe' },
      { jsonrpc: '2.0', id: 9, result: {} },
      { jsonrpc: '2.0', id: 9, error: { code: -1, message: 'x' } },
      [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 9, result: {} }],
    ];
    for (const payload of accepted) {
      const r = await post(env, payload);
      expect(r.status, JSON.stringify(payload)).toBe(202);
      expect(r.raw).toBe('');
      expect(r.headers.get('Mcp-Session-Id')).toBeNull();
    }
  });

  it('a batch is handled in order and only requests get a response', async () => {
    const { env, sqlite } = await seeded();
    const r = await post(env, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'alta', method: 'tools/call', params: { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850 } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'month_summary', arguments: { user: F } } },
      5,
      { jsonrpc: '2.0', id: 3, method: 'no/existe' },
    ]);
    expect(r.status).toBe(200);
    const out = r.body as RpcBody[];
    expect(out.map((x) => x.id)).toEqual([1, 'alta', 2, null, 3]);
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect((out[1]!.result as ToolResult).isError).toBe(false);
    // The summary already sees the transaction recorded by the previous message of the same batch.
    expect((out[2]!.result as ToolResult).structuredContent).toMatchObject({ transactions: { count: 8, total: 11695 } });
    expect(out[3]!.error?.code).toBe(-32600);
    expect(out[4]!.error?.code).toBe(-32601);
    expect(count(sqlite, 'transactions', F)).toBe(28);

    // Whatever fails inside a batch goes in its own response: the whole batch is always a 200.
    const mixed = await post(env, [5, { jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(mixed.status).toBe(200);
    expect((mixed.body as RpcBody[]).map((x) => x.error?.code)).toEqual([-32600, undefined]);
  });

  it('an empty or too long batch is an invalid request', async () => {
    const { env } = makeEnv();
    const empty = await post(env, []);
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ id: null, error: { code: -32600 } });

    const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
    const full = await post(env, Array.from({ length: MAX_BATCH }, (_, i) => ping(i)));
    expect(full.status).toBe(200);
    expect(full.body).toHaveLength(MAX_BATCH);
    const tooMany = await post(env, Array.from({ length: MAX_BATCH + 1 }, (_, i) => ping(i)));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('413 if the body exceeds the limit, whether Content-Length says so or not', async () => {
    const { env } = makeEnv();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { relleno: 'x'.repeat(MAX_BODY_BYTES) } });
    const streamed = await post(env, big);
    expect(streamed.status).toBe(413);
    expect(streamed.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });

    const declared = await post(env, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...AUTH, 'Content-Length': String(MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);
  });

  it('MCP-Protocol-Version: 400 if unsupported, saying which ones exist; without the header it is not required', async () => {
    const { env } = makeEnv();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect((await post(env, ping, { ...AUTH, 'MCP-Protocol-Version': version })).status).toBe(200);
    }
    expect((await post(env, ping)).status).toBe(200);

    for (const requested of ['1999-01-01', '2031-01-01', 'x'.repeat(80)]) {
      const r = await post(env, ping, { ...AUTH, 'MCP-Protocol-Version': requested });
      expect(r.status).toBe(400);
      // UnsupportedProtocolVersionError: with it a client retries with a version from the list.
      expect(r.body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32022, message: `Unsupported protocol version: ${requested}.`, data: { supported: [...PROTOCOL_VERSIONS], requested } },
      });
    }
    const notification = await post(env, { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...AUTH, 'MCP-Protocol-Version': '1999-01-01' });
    expect(notification.status).toBe(400);
    expect(notification.body).toMatchObject({ id: null, error: { code: -32022 } });
    const long = await post(env, ping, { ...AUTH, 'MCP-Protocol-Version': 'x'.repeat(5000) });
    expect(long.raw.length).toBeLessThan(600);

    // In initialize nothing has been negotiated yet: the header does not count.
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2031-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    expect((await post(env, init, { ...AUTH, 'MCP-Protocol-Version': '2031-01-01' })).status).toBe(200);
  });

  it('responses are not cached', async () => {
    const { env } = makeEnv();
    expect((await post(env, { jsonrpc: '2.0', id: 1, method: 'ping' })).headers.get('Cache-Control')).toBe('no-store');
    expect((await post(env, { jsonrpc: '2.0', method: 'notifications/initialized' })).headers.get('Cache-Control')).toBe('no-store');
  });

  it('a malformed USERS is an internal error: nothing is handled and the reason is not leaked', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = ['Frank Reyes:Frank', 'frank:Frank,frank:Otro', 'frank:Frank,EDA:Eda'];
    for (const USERS of bad) {
      const { env, sqlite } = makeEnv({ USERS });
      const messages: unknown[] = [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850 } } },
      ];
      for (const message of messages) {
        const r = await post(env, message);
        expect(r.status, USERS).toBe(500);
        expect(r.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: INTERNAL_MESSAGE } });
        expect(r.raw).not.toContain('USERS');
      }
      expect(count(sqlite, 'transactions')).toBe(0);
    }
    // The reason stays in the log, which is where whoever configures it looks for it.
    expect(log).toHaveBeenCalledTimes(bad.length * 2);
    expect(String(log.mock.calls[0]![1])).toContain('USERS');
  });
});

describe('/mcp: initialize and basic methods', () => {
  const client = { capabilities: {}, clientInfo: { name: 'prueba', version: '1.0.0' } };
  const instructionsOf = async (env: Env) =>
    ((await rpc(env, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, ...client })).result as { instructions: string }).instructions;

  it('initialize describes the server and opens no session', async () => {
    const { env } = makeEnv();
    const r = await post(env, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', ...client } });
    expect(r.status).toBe(200);
    expect(r.headers.get('Mcp-Session-Id')).toBeNull();
    const result = (r.body as RpcBody).result as Record<string, any>;
    expect(result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions: expect.any(String),
    });
  });

  it('the server version is the one in package.json', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version: string };
    expect(SERVER_INFO.version).toBe(pkg.version);
    expect(SERVER_INFO.name).toBe('fe-finance');
  });

  it('the instructions explain the domain, in English', async () => {
    const text = await instructionsOf(makeEnv().env);
    for (const word of [...CATS, ...METHODS, ...VIAS, TIMEZONE, 'FE Finance', 'USD', 'DOP', 'closed', 'read-only', 'confirm', 'Spanish or Turkish', 'free text']) {
      expect(text, word).toContain(word);
    }
    expect(text).not.toMatch(SPANISH);
    // "Card" on its own is the debit card, which is also the default method.
    expect(text).toContain('Payment methods: Debit card, Credit card, Transfer, Bank app, Cash. If none is given it is Debit card.');
    expect(text).toContain('A plain "card" ("tarjeta", "kart") is stored as Debit card');
  });

  it('the instructions explain the money model: accounts, main currency and what each record moves', async () => {
    const text = await instructionsOf(makeEnv().env);
    for (const phrase of [
      'their own accounts',
      'their own main currency',
      'DOP, USD, TRY',
      'An expense is subtracted from the account it is paid from',
      "the person's default account unless they name another one",
      'An income adds to an account',
      'A transfer moves money from one account to another',
      'record the amount in the currency they said',
      'Never convert an amount yourself',
      'list_accounts',
      'default value',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // It no longer assumes that everyone earns in dollars and spends in pesos.
    expect(text).not.toContain('earn in USD');
    expect(text).not.toContain('DOP by default');
  });

  it('the instructions say that each person has their own finances, who they are and to ask when in doubt', async () => {
    const text = await instructionsOf(makeEnv().env);
    for (const phrase of ['separate finances', `Configured users: ${BOTH}.`, '`user`', 'required', 'conversation', 'project instructions', 'ask before calling a tool', 'never guess']) {
      expect(text, phrase).toContain(phrase);
    }

    // The list is the one from each request's environment, not a fixed one.
    const three = await instructionsOf(makeEnv({ USERS: 'frank:Frank,eda:Eda,leo' }).env);
    expect(three).toContain('Configured users: frank (Frank), eda (Eda), leo (Leo).');

    // With a single user there is nobody to mix up: it names them and says that `user` can be omitted.
    const single = await instructionsOf(makeEnv({ USERS: 'ana:Ana María' }).env);
    expect(single).toContain('only one user is configured, ana (Ana María)');
    expect(single).toContain('can be omitted');
    expect(single).not.toContain('frank');
    expect(await instructionsOf(makeEnv({ USERS: undefined }).env)).toContain('only one user is configured, me (Me)');
  });

  it('negotiates the version: the one from the client if supported; otherwise, the newest of those that use a handshake', async () => {
    const { env } = makeEnv();
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(expect.arrayContaining(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']));
    expect(PROTOCOL_VERSIONS).toEqual([...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]);
    expect(LATEST_PROTOCOL_VERSION).toBe([...PROTOCOL_VERSIONS].sort().at(-1));
    const latestWithHandshake = [...LEGACY_PROTOCOL_VERSIONS].sort().at(-1);

    const negotiate = async (protocolVersion: unknown) =>
      (await rpc(env, 'initialize', { protocolVersion, ...client })).result as { protocolVersion: string };
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect((await negotiate(version)).protocolVersion).toBe(version);
    }
    // Versions without a handshake cannot be agreed on with initialize.
    for (const version of ['2031-01-01', '2024-10-07', '1.0', '', ...MODERN_PROTOCOL_VERSIONS]) {
      expect((await negotiate(version)).protocolVersion, version).toBe(latestWithHandshake);
    }
  });

  it('initialize without protocolVersion: -32602', async () => {
    const { env } = makeEnv();
    for (const params of [undefined, {}, { protocolVersion: 20250618 }, client]) {
      expect((await rpc(env, 'initialize', params)).error?.code).toBe(-32602);
    }
  });

  it('ping answers with an empty result', async () => {
    const { env } = makeEnv();
    expect((await rpc(env, 'ping')).result).toEqual({});
    expect((await rpc(env, 'ping', {})).result).toEqual({});
  });

  it('unknown method: -32601; params that are not an object: -32602', async () => {
    const { env } = makeEnv();
    for (const method of ['resources/list', 'prompts/list', 'tools/borrar', 'notifications/initialized', '']) {
      const body = await rpc(env, method);
      expect(body.error?.code, method).toBe(-32601);
      expect(body.error?.message).toBe(`Method not found: ${method}`);
      expect(body.result).toBeUndefined();
    }
    const long = await rpc(env, 'x'.repeat(5000));
    expect(long.error!.message.length).toBeLessThan(200);

    for (const params of [[1, 2], 'texto', 5]) {
      expect((await rpc(env, 'tools/list', params)).error?.code).toBe(-32602);
    }
  });
});

describe('/mcp: protocol without a handshake (2026-07-28)', () => {
  const MODERN = '2026-07-28';
  const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
  const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
  const META = { [VERSION_KEY]: MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'prueba', version: '1.0.0' }, [CAPABILITIES_KEY]: {} };
  const SERVER_META = { 'io.modelcontextprotocol/serverInfo': SERVER };

  interface Options {
    /** Headers that differ from the correct ones; null removes one. */
    headers?: Record<string, string | null>;
    /** `_meta` of the request; null removes it. */
    meta?: Record<string, unknown> | null;
    now?: Date;
  }

  /** A well-formed request from a 2026-07-28 client, except for whatever `options` changes. */
  function modern(env: Env, method: string, params: Record<string, unknown> = {}, options: Options = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...AUTH, 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method };
    if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    const meta = options.meta === undefined ? META : options.meta;
    const body = { jsonrpc: '2.0', id: 'm1', method, params: meta === null ? params : { ...params, _meta: meta } };
    return post(env, body, headers, options.now ?? NOW);
  }

  const result = (r: Reply) => (r.body as RpcBody).result as Record<string, any>;
  const error = (r: Reply) => (r.body as RpcBody).error!;
  const summary = { name: 'month_summary', arguments: { user: F } };

  it('server/discover describes the server: versions, capabilities, identity and instructions', async () => {
    const { env } = makeEnv();
    const r = await modern(env, 'server/discover');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('application/json');
    expect(r.headers.get('Mcp-Session-Id')).toBeNull();
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 'm1',
      result: {
        resultType: 'complete',
        supportedVersions: [...PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        instructions: expect.any(String),
        ttlMs: 300000,
        cacheScope: 'public',
        _meta: SERVER_META,
      },
    });
    // The same instructions initialize gives, with the configured users.
    const legacy = (await rpc(env, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result;
    expect(result(r).instructions).toBe((legacy as { instructions: string }).instructions);
    expect(result(r).instructions).toContain(BOTH);
    expect(result(await modern(makeEnv({ USERS: 'ana:Ana' }).env, 'server/discover')).instructions).toContain('ana (Ana)');
  });

  it('tools/list carries the same tools, with resultType and cache hints', async () => {
    const { env } = makeEnv();
    const r = await modern(env, 'tools/list');
    expect(r.status).toBe(200);
    const legacy = (await rpc(env, 'tools/list')).result as { tools: unknown[] };
    expect(result(r)).toEqual({ resultType: 'complete', tools: legacy.tools, ttlMs: 300000, cacheScope: 'public', _meta: SERVER_META });
    expect(result(r).tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES);
    expect(result(r).tools[0].inputSchema.properties.user.enum).toEqual([F, E]);
    // With a handshake the result does not change shape.
    expect(Object.keys(legacy)).toEqual(['tools']);
  });

  it('tools/call records the expense and answers with resultType', async () => {
    const { env, sqlite } = await seeded();
    const r = await modern(env, 'tools/call', { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850, category: 'Transporte' } });
    expect(r.status).toBe(200);
    expect(result(r)).toEqual({
      resultType: 'complete',
      content: [
          {
            type: 'text',
            text: 'Recorded for Frank: Uber · 850.00 DOP · Transport · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
          },
        ],
      structuredContent: expect.objectContaining({ user: FRANK, monthCreated: false }),
      isError: false,
      _meta: SERVER_META,
    });
    expect(count(sqlite, 'transactions', F)).toBe(28);

    const legacy = (await rpc(env, 'tools/call', summary)).result as Record<string, unknown>;
    expect(Object.keys(legacy)).toEqual(['content', 'structuredContent', 'isError']);
  });

  it('a tool error is still a result (200, isError)', async () => {
    const { env } = await seeded();
    const r = await modern(env, 'tools/call', { name: 'add_transaction', arguments: { user: F, description: 'Tarde', amount: 1, date: '2026-08-15' } });
    expect(r.status).toBe(200);
    expect(result(r)).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'August 2026 is closed: it is read-only. Reopen it to make changes.' }],
      isError: true,
      _meta: SERVER_META,
    });

    // Also when it does not say whose it is.
    const nobody = await modern(env, 'tools/call', { name: 'add_transaction', arguments: { description: 'Uber', amount: 850 } });
    expect(nobody.status).toBe(200);
    expect(result(nobody)).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: `Invalid data: user: is required. Valid users: ${BOTH}. ${ASK}` }],
      isError: true,
      _meta: SERVER_META,
    });
  });

  it('unknown tool: -32602; unexpected failure: -32603 with no details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = makeEnv();
    const unknown = await modern(env, 'tools/call', { name: 'borrar_todo' });
    expect(unknown.status).toBe(200);
    expect(error(unknown).code).toBe(-32602);

    const broken = { ...env, DB: { prepare: () => { throw new Error('SQLITE_SECRETO'); }, batch: () => { throw new Error('SQLITE_SECRETO'); } } as unknown as D1Database };
    const failed = await modern(broken, 'tools/call', summary);
    expect(failed.body).toEqual({ jsonrpc: '2.0', id: 'm1', error: { code: -32603, message: INTERNAL_MESSAGE } });
  });

  it('Mcp-Name accepts the value encoded in base64', async () => {
    const { env } = await seeded();
    const encoded = (text: string) => `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
    const ok = await modern(env, 'tools/call', summary, { headers: { 'Mcp-Name': encoded('month_summary') } });
    expect(ok.status).toBe(200);
    expect(result(ok).isError).toBe(false);

    for (const value of [encoded('list_transactions'), '=?base64?%%%?=', '=?base64??=']) {
      const bad = await modern(env, 'tools/call', summary, { headers: { 'Mcp-Name': value } });
      expect(bad.status, value).toBe(400);
      expect(error(bad).code).toBe(-32020);
    }
  });

  it('headers that do not match the body: 400 HeaderMismatch, without running anything', async () => {
    const { env, sqlite } = await seeded();
    const add = { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850 } };
    const bad: [string, Record<string, unknown>, Options][] = [
      ['tools/list', {}, { headers: { 'Mcp-Method': null } }],
      ['tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } }],
      ['tools/list', {}, { headers: { 'Mcp-Method': 'Tools/List' } }],
      ['server/discover', {}, { headers: { 'Mcp-Method': null } }],
      ['tools/call', add, { headers: { 'Mcp-Method': 'tools/list' } }],
      ['tools/call', add, { headers: { 'Mcp-Name': null } }],
      ['tools/call', add, { headers: { 'Mcp-Name': 'month_summary' } }],
      ['tools/call', add, { headers: { 'Mcp-Name': 'ADD_TRANSACTION' } }],
      ['tools/call', add, { meta: { ...META, [VERSION_KEY]: '2025-11-25' } }],
      ['tools/list', {}, { meta: { ...META, [VERSION_KEY]: '2031-01-01' } }],
    ];
    for (const [method, params, options] of bad) {
      const r = await modern(env, method, params, options);
      expect(r.status, JSON.stringify(options)).toBe(400);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 'm1', error: { code: -32020, message: expect.stringContaining('The headers do not match the body') } });
    }
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('a required `_meta` field is missing: 400 with -32602', async () => {
    const { env, sqlite } = await seeded();
    const add = { name: 'add_transaction', arguments: { user: F, description: 'Uber', amount: 850 } };
    const withoutVersion = { [CAPABILITIES_KEY]: {} };
    const withoutCapabilities = { [VERSION_KEY]: MODERN };
    for (const meta of [null, {}, withoutVersion, withoutCapabilities, { ...META, [VERSION_KEY]: 20260728 }, { ...META, [CAPABILITIES_KEY]: 'todas' }]) {
      const r = await modern(env, 'tools/call', add, { meta });
      expect(r.status, JSON.stringify(meta)).toBe(400);
      expect(error(r).code).toBe(-32602);
      expect(error(r).message).toContain('_meta');
    }
    const array = await post(env, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: [1] }, { ...AUTH, 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' });
    expect(array.status).toBe(400);
    expect(error(array).code).toBe(-32602);
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('the version declared in `_meta` must also come in the header', async () => {
    const { env } = makeEnv();
    for (const headers of [{ 'MCP-Protocol-Version': null }, { 'MCP-Protocol-Version': '2025-11-25' }]) {
      const r = await modern(env, 'tools/list', {}, { headers });
      expect(r.status).toBe(400);
      expect(error(r).code).toBe(-32020);
    }
    // A client with a handshake declares nothing in `_meta`: its progressToken and the like do no harm.
    const legacy = await rpc(env, 'tools/list', { _meta: { progressToken: 7 } });
    expect(legacy.error).toBeUndefined();
  });

  it('a method that does not exist in this version: 404 with -32601', async () => {
    const { env } = makeEnv();
    for (const method of ['ping', 'resources/list', 'subscriptions/listen', 'no/existe']) {
      const r = await modern(env, method);
      expect(r.status, method).toBe(404);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 'm1', error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });

  it('initialize is still the handshake of the earlier versions, whatever the header says', async () => {
    const { env } = makeEnv();
    const r = await modern(env, 'initialize', { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.status).toBe(200);
    expect(result(r)).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'fe-finance' } });
    expect(result(r).resultType).toBeUndefined();
  });

  it('does not accept batches; a notification is accepted with 202', async () => {
    const { env } = makeEnv();
    const headers = { ...AUTH, 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' };
    const batch = await post(env, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }], headers);
    expect(batch.status).toBe(400);
    expect(batch.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });

    const notification = await post(env, { jsonrpc: '2.0', method: 'notifications/cancelled' }, { ...AUTH, 'MCP-Protocol-Version': MODERN });
    expect(notification.status).toBe(202);
    expect(notification.raw).toBe('');
  });

  it('"today" and the rest of the rules are the same in both eras', async () => {
    const { env } = await seeded();
    const r = await modern(env, 'tools/call', summary, { now: new Date('2026-11-02T16:00:00Z') });
    expect(result(r).structuredContent).toMatchObject({ user: FRANK, month: '2026-10', today: '2026-11-02' });
  });
});

describe('/mcp: tools/list', () => {
  async function tools(env: Env = makeEnv().env): Promise<Record<string, any>[]> {
    return ((await rpc(env, 'tools/list')).result as { tools: Record<string, any>[] }).tools;
  }

  it('lists the eleven tools, with or without params', async () => {
    const { env } = makeEnv();
    expect((await tools()).map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const params of [{}, { cursor: 'x' }, null]) {
      const result = (await rpc(env, 'tools/list', params)).result as { tools: unknown[]; nextCursor?: string };
      expect(result.tools).toHaveLength(11);
      expect(result.nextCursor).toBeUndefined();
    }
  });

  it('each one comes with a description, a closed input schema and annotations', async () => {
    for (const tool of await tools()) {
      expect(Object.keys(tool).sort(), tool.name).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title']);
      expect(tool.description.length, tool.name).toBeGreaterThan(80);
      expect(tool.title.length).toBeGreaterThan(5);

      const schema = tool.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toBeUndefined();
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(Object.keys(props).length).toBeGreaterThan(0);
      for (const [key, prop] of Object.entries(props)) {
        expect(prop.type, `${tool.name}.${key}`).toMatch(/^(string|number|integer|boolean)$/);
        expect(String(prop.description).length, `${tool.name}.${key}`).toBeGreaterThan(10);
      }
      for (const key of (schema.required as string[] | undefined) ?? []) expect(props).toHaveProperty(key);

      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: expect.any(Boolean),
        destructiveHint: false,
        idempotentHint: expect.any(Boolean),
        openWorldHint: false,
      });
    }
  });

  it('everything that describes the tools is in English', async () => {
    const all = await tools();
    expect(JSON.stringify(all)).not.toMatch(SPANISH);
    expect(all.map((t) => t.title)).toEqual([
      'Record transaction',
      'Record outside-budget expense',
      'List transactions',
      'Month summary',
      'Record transfer between accounts',
      'Mark fixed expense as paid',
      'Record income',
      'List accounts',
      'Pay credit card',
      'List credit cards',
      'Add extra budget',
    ]);
    // Each description says whose finances it touches.
    for (const tool of all) expect(tool.description, tool.name).toContain('in the finances of `user`');
  });

  it('the read tools are announced as such and only mark_fixed_paid, among the write tools, is idempotent', async () => {
    const hints = Object.fromEntries((await tools()).map((t) => [t.name, [t.annotations.readOnlyHint, t.annotations.idempotentHint]]));
    expect(hints).toEqual({
      add_transaction: [false, false],
      add_outside_expense: [false, false],
      list_transactions: [true, true],
      month_summary: [true, true],
      add_transfer: [false, false],
      mark_fixed_paid: [false, true],
      add_income: [false, false],
      list_accounts: [true, true],
      pay_credit_card: [false, false],
      list_credit_cards: [true, true],
      add_budget_extra: [false, false],
    });
  });

  it('the schemas declare required fields, lists and default values', async () => {
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t.inputSchema]));

    const tx = byName.add_transaction;
    expect(Object.keys(tx.properties)).toEqual(['user', 'description', 'amount', 'currency', 'account', 'date', 'place', 'category', 'method', 'card', 'notes']);
    expect(tx.required).toEqual(['user', 'description', 'amount']);
    expect(tx.properties.amount).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    // No default value: the currency that applies is the account's, and the description says so.
    expect(tx.properties.currency).toMatchObject({ type: 'string', enum: ['DOP', 'USD', 'TRY'] });
    expect(tx.properties.currency.default).toBeUndefined();
    expect(tx.properties.currency.description).toContain('the currency of the account is used');
    // The account is free text: its name or its id.
    expect(tx.properties.account).toMatchObject({ type: 'string', maxLength: 120 });
    expect(tx.properties.account.enum).toBeUndefined();
    expect(tx.properties.account.description).toContain('default account');
    // The lists are the canonical English ones, even though Spanish and Turkish are accepted too.
    expect(tx.properties.category).toMatchObject({ type: 'string', enum: [...CATS], default: 'Food' });
    expect(tx.properties.method).toMatchObject({ type: 'string', enum: [...METHODS], default: 'Debit card' });
    expect(tx.properties.date).toMatchObject({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
    expect(tx.properties.description).toMatchObject({ minLength: 1, maxLength: 200 });

    const list = byName.list_transactions;
    expect(Object.keys(list.properties)).toEqual(['user', 'month', 'limit']);
    expect(list.required).toEqual(['user']);
    expect(list.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200, default: 20 });
    expect(list.properties.month.pattern).toBe('^\\d{4}-(0[1-9]|1[0-2])$');

    expect(Object.keys(byName.month_summary.properties)).toEqual(['user', 'month']);
    expect(byName.month_summary.required).toEqual(['user']);

    const transfer = byName.add_transfer;
    expect(Object.keys(transfer.properties)).toEqual([
      'user',
      'from_account',
      'to_account',
      'amount',
      'rate',
      'via',
      'date',
      'fee',
      'move_budget',
      'add_to_budget',
    ]);
    // `add_to_budget` is the former name of `move_budget` and is still accepted; neither is required.
    expect(transfer.properties.move_budget).toMatchObject({ type: 'boolean' });
    expect(transfer.properties.add_to_budget).toMatchObject({ type: 'boolean' });
    expect(transfer.properties.fee).toMatchObject({ type: 'number', minimum: 0 });
    // The rate is optional: without it the month rate applies.
    expect(transfer.required).toEqual(['user', 'from_account', 'to_account', 'amount']);
    expect(transfer.properties.from_account).toMatchObject({ type: 'string', minLength: 1, maxLength: 120 });
    expect(transfer.properties.amount).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    expect(transfer.properties.rate).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    // The via is free text: Remitly and PayPal are only suggestions.
    expect(transfer.properties.via).toMatchObject({ type: 'string', default: 'Remitly', minLength: 1, maxLength: 60 });
    expect(transfer.properties.via.enum).toBeUndefined();
    for (const via of VIAS) expect(transfer.properties.via.description).toContain(via);

    const paid = byName.mark_fixed_paid;
    expect(Object.keys(paid.properties)).toEqual(['user', 'name', 'month', 'paid', 'on_card']);
    expect(paid.required).toEqual(['user', 'name']);
    expect(paid.properties.paid).toMatchObject({ type: 'boolean', default: true });

    const income = byName.add_income;
    expect(Object.keys(income.properties)).toEqual(['user', 'amount', 'currency', 'account', 'date', 'description', 'add_to_budget', 'rate', 'recurring']);
    expect(income.properties.add_to_budget).toMatchObject({ type: 'boolean', default: false });
    expect(income.required).toEqual(['user', 'amount']);
    expect(income.properties.currency).toMatchObject({ type: 'string', enum: ['DOP', 'USD', 'TRY'] });
    expect(income.properties.description).toMatchObject({ type: 'string', maxLength: 200 });

    // list_accounts takes no argument other than whose.
    expect(Object.keys(byName.list_accounts.properties)).toEqual(['user']);
    expect(byName.list_accounts.required).toEqual(['user']);
  });

  it('list_accounts tells the model when to call it', async () => {
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(byName.list_accounts.description).toContain('Call it when you need to know which accounts exist');
    // And whoever names an account knows where to look them up.
    for (const [name, field] of [
      ['add_transaction', 'account'],
      ['add_income', 'account'],
      ['add_transfer', 'from_account'],
      ['add_transfer', 'to_account'],
    ] as const) {
      expect(byName[name].inputSchema.properties[field].description, `${name}.${field}`).toContain('list_accounts');
    }
  });

  it('`user` reflects the configured users: their ids, and required only if there is more than one', async () => {
    // Two users (wrangler.toml): you have to say who.
    for (const tool of await tools()) {
      expect(tool.inputSchema.properties.user, tool.name).toEqual({ type: 'string', enum: [F, E], description: expect.stringContaining(BOTH) });
      expect(tool.inputSchema.properties.user.description).toContain('ask instead of guessing');
      expect(tool.inputSchema.required[0], tool.name).toBe('user');
    }

    // The list comes from each request's environment: the same database with another USERS announces other users.
    const { env } = makeEnv();
    const three = await tools({ ...env, USERS: 'frank:Frank,eda:Eda,leo' });
    for (const tool of three) {
      expect(tool.inputSchema.properties.user.enum).toEqual(['frank', 'eda', 'leo']);
      expect(tool.inputSchema.properties.user.description).toContain('frank (Frank), eda (Eda), leo (Leo)');
      expect(tool.inputSchema.required).toContain('user');
    }

    // A single user: it is announced, it is the default value and it is not required.
    const single = Object.fromEntries((await tools({ ...env, USERS: 'ana:Ana María' })).map((t) => [t.name, t.inputSchema]));
    for (const name of TOOL_NAMES) {
      expect(single[name].properties.user, name).toEqual({ type: 'string', enum: ['ana'], default: 'ana', description: expect.stringContaining('ana (Ana María)') });
      expect(single[name].properties.user.description).toContain('can be omitted');
      expect(Object.keys(single[name].properties)[0]).toBe('user');
    }
    expect(single.add_transaction.required).toEqual(['description', 'amount']);
    expect(single.add_transfer.required).toEqual(['from_account', 'to_account', 'amount']);
    expect(single.mark_fixed_paid.required).toEqual(['name']);
    expect(single.add_income.required).toEqual(['amount']);
    expect(single.list_transactions.required).toBeUndefined();
    expect(single.month_summary.required).toBeUndefined();
    expect(single.list_accounts.required).toBeUndefined();

    // Without USERS, the app is single-user.
    const unset = await tools({ ...env, USERS: undefined });
    expect(unset[0]!.inputSchema.properties.user).toMatchObject({ enum: ['me'], default: 'me' });
    expect(unset[0]!.inputSchema.required).toEqual(['description', 'amount']);
  });
});

describe('/mcp: tools/call', () => {
  it('unknown tool or malformed call: -32602, not a result', async () => {
    const { env } = makeEnv();
    const bad: unknown[] = [
      { name: 'borrar_todo' },
      { name: 'borrar_todo', arguments: { user: F } },
      { name: 'add_transaction', arguments: [1] },
      { name: 'add_transaction', arguments: 'Uber' },
      { arguments: {} },
      { name: 5 },
      undefined,
    ];
    for (const params of bad) {
      const body = await rpc(env, 'tools/call', params);
      expect(body.error?.code, JSON.stringify(params)).toBe(-32602);
      expect(body.result).toBeUndefined();
    }
    expect((await rpc(env, 'tools/call', { name: 'borrar_todo' })).error?.message).toBe('Unknown tool: borrar_todo');
  });

  it('an unexpected failure is -32603 and leaks no internal details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      prepare() {
        throw new Error('SQLITE_SECRETO en la tabla months');
      },
      batch() {
        throw new Error('SQLITE_SECRETO en la tabla months');
      },
    } as unknown as D1Database;
    const env: Env = { ...makeEnv().env, DB: broken };

    for (const [name, args] of [
      ['month_summary', { user: F }],
      ['add_transaction', { user: F, description: 'Uber', amount: 850 }],
      ['mark_fixed_paid', { user: E, name: 'Luz' }],
      ['add_transfer', { user: F, ...US_TO_DR, amount: 100, rate: 58 }],
      ['add_income', { user: F, amount: 100 }],
      ['list_accounts', { user: E }],
    ] as const) {
      const r = await post(env, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32603, message: INTERNAL_MESSAGE } });
      expect(r.raw).not.toContain('SECRETO');
    }
    expect(log).toHaveBeenCalledTimes(6);
  });
});

describe('whose finances they are: `user`', () => {
  /** A valid call of each tool, missing only whose it is. */
  const CALLS: [string, Record<string, unknown>][] = [
    ['add_transaction', { description: 'Uber', amount: 850 }],
    ['list_transactions', {}],
    ['month_summary', {}],
    ['add_transfer', { ...US_TO_DR, amount: 100, rate: 58 }],
    ['mark_fixed_paid', { name: 'Netflix' }],
    ['add_income', { amount: 100 }],
    ['list_accounts', {}],
  ];

  it('with several users, a call without `user` is a tool error that says who the users are', async () => {
    const { env, db } = await seeded();
    const before = await loadState(db, F);
    const expected = `Invalid data: user: is required. Valid users: ${BOTH}. ${ASK}`;
    for (const [name, args] of CALLS) {
      expect(await failsRaw(env, name, args), name).toBe(expected);
      // A model often sends null or '' for what it does not know: it is still "not given".
      expect(await failsRaw(env, name, { ...args, user: null }), name).toBe(expected);
      expect(await failsRaw(env, name, { ...args, user: '   ' }), name).toBe(expected);
    }
    // Without arguments it does not say whose.
    expect(await failsRaw(env, 'month_summary')).toBe(expected);
    // It is not attributed to anyone: not even to the first on the list.
    expect(await loadState(db, F)).toEqual(before);
  });

  it('a user that does not exist is a tool error that says who the users are', async () => {
    const { env, db, sqlite } = await seeded();
    const before = await loadState(db, F);
    for (const [name, args] of CALLS) {
      expect(await failsRaw(env, name, { ...args, user: 'pedro' }), name).toBe(`Invalid data: user: unknown user "pedro". Valid users: ${BOTH}. ${ASK}`);
    }
    const add = { description: 'Uber', amount: 850 };
    // The full name is not the id, and the id is not a number.
    expect(await failsRaw(env, 'add_transaction', { ...add, user: 'Frank Reyes' })).toContain('unknown user "Frank Reyes"');
    expect(await failsRaw(env, 'add_transaction', { ...add, user: 7 })).toBe(`Invalid data: user: must be text. Valid users: ${BOTH}. ${ASK}`);
    expect(await failsRaw(env, 'add_transaction', { ...add, user: [F] })).toContain('user: must be text');
    // What the client sent comes back truncated.
    expect((await failsRaw(env, 'add_transaction', { ...add, user: 'x'.repeat(5000) })).length).toBeLessThan(300);
    // The user error comes before any other: without knowing whose it is there is nothing to validate.
    expect(await failsRaw(env, 'add_transaction', { user: 'pedro' })).not.toContain('description');

    expect(await loadState(db, F)).toEqual(before);
    expect(count(sqlite, 'months')).toBe(6);
    expect(count(sqlite, 'transactions', 'pedro')).toBe(0);
  });

  it('the id is accepted in a different case or with extra spaces', async () => {
    const { env, sqlite } = makeEnv();
    for (const user of [' Frank ', 'FRANK', 'frank']) {
      const r = await callRaw(env, 'add_transaction', { user, description: 'Uber', amount: 850 });
      expect(r.isError, user).toBe(false);
      expect(r.data!.user).toEqual(FRANK);
    }
    expect(count(sqlite, 'transactions', F)).toBe(3);
    expect(count(sqlite, 'transactions')).toBe(3);
  });

  it('the same expense dictated by each user lands in their own finances', async () => {
    const { env, db, sqlite } = makeEnv();
    await replaceAll(db, F, seedState());
    const expense = { description: 'Uber', amount: 850, category: 'Transport' };

    const frank = await callRaw(env, 'add_transaction', { ...expense, user: F });
    const eda = await callRaw(env, 'add_transaction', { ...expense, user: E });
    // Frank has three months and a budget; for Eda it is her first record.
    expect(frank.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Transport · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
    );
    // Eda gets her own brand-new accounts (the initial ones, at zero): hers is also called "DR account", but it is a different one.
    expect(eda.text).toBe(
      'Recorded for Eda: Uber · 850.00 DOP · Transport · Debit card · 2026-10-07 (October 2026) · paid from DR account. The month October 2026 was created. Used so far: 850.00 DOP (no budget set). DR account balance: -850.00 DOP.',
    );
    expect(frank.data).toMatchObject({ user: FRANK, monthCreated: false, month: { budget: 70000 }, account: { id: 'dr' } });
    expect(eda.data).toMatchObject({ user: EDA, monthCreated: true, month: { budget: 0, used: 850 }, account: { id: 'dr', balance: -850 } });
    expect(frank.data!.account.balance).toBeCloseTo(await balanceOf(db, 'dr', F), 8);
    expect(await balanceOf(db, 'dr', E)).toBe(-850);
    expect(eda.data!.transaction.id).not.toBe(frank.data!.transaction.id);

    expect((await getMonth(db, F, '2026-10'))!.tx.filter((t) => t.desc === 'Uber')).toEqual([frank.data!.transaction]);
    expect((await getMonth(db, E, '2026-10'))!.tx).toEqual([eda.data!.transaction]);
    expect(count(sqlite, 'transactions', F)).toBe(28);
    expect(count(sqlite, 'transactions', E)).toBe(1);
    expect(count(sqlite, 'months', E)).toBe(1);
    // Eda's month is her own: it does not inherit Frank's fixed expenses.
    expect((await getMonth(db, E, '2026-10'))!.fixed).toEqual([]);
  });

  it('each user queries and changes only their own data, and the response says whose it is', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, seedState());

    // Eda has nothing yet.
    expect(await failsRaw(env, 'month_summary', { user: E })).toBe('Eda has no months yet. Record a transaction to create the current month.');
    expect(await failsRaw(env, 'list_transactions', { user: E })).toBe('Eda has no months yet. Record a transaction to create the current month.');

    // Her transfer creates her October with her rate; Frank's does not move.
    const transfer = await callRaw(env, 'add_transfer', { user: E, ...US_TO_DR, amount: 200, rate: 60, via: 'Wise' });
    expect(transfer.text).toBe(
      'Transfer recorded for Eda: 200.00 USD left US account, 12,000.00 DOP arrived in DR account (1 USD = 60.00 DOP) · Wise · 2026-10-07 (October 2026). The month October 2026 was created. US account balance: -200.00 USD. DR account balance: 12,000.00 DOP.',
    );
    expect(transfer.data).toMatchObject({ user: EDA, monthCreated: true });
    const edaSummary = (await callRaw(env, 'month_summary', { user: E })).text.split('\n');
    const frankSummary = (await callRaw(env, 'month_summary', { user: F })).text.split('\n');
    expect(edaSummary[0]).toBe('Eda · October 2026 · amounts in DOP');
    expect(edaSummary).toContain("Month rates: USD to DOP: 60.00 (from this month's transfers)");
    expect(frankSummary[0]).toBe('Frank · October 2026 · amounts in DOP');
    expect(frankSummary).toContain('Month rates: USD to DOP: 58.76 (typed on 2026-10-06)');
    expect((await getMonth(db, F, '2026-10'))!.transfers).toHaveLength(1);

    const edaList = await callRaw(env, 'list_transactions', { user: E });
    expect(edaList.text).toBe('Eda · October 2026: no transactions recorded.');
    expect(edaList.data).toMatchObject({ user: EDA, count: 0 });
    const frankList = await callRaw(env, 'list_transactions', { user: F, limit: 1 });
    expect(frankList.text.split('\n')[0]).toBe('Frank · October 2026: 7 transactions · 10,845.00 DOP in total. Showing the most recent one.');
    expect(frankList.data).toMatchObject({ user: FRANK, count: 7 });

    // Netflix is a fixed expense of Frank's; Eda has none.
    expect(await failsRaw(env, 'mark_fixed_paid', { user: E, name: 'Netflix' })).toBe('Eda has no fixed expenses in October 2026.');
    await createFixed(db, E, { monthKey: '2026-10', name: 'Kira', amount: 20000, cur: 'DOP' });
    expect(await failsRaw(env, 'mark_fixed_paid', { user: E, name: 'Netflix' })).toBe(
      'No fixed expense for Eda in October 2026 matches "Netflix". Fixed expenses in October 2026: Kira.',
    );
    const paid = await callRaw(env, 'mark_fixed_paid', { user: E, name: 'kira' });
    expect(paid.text).toBe(
      'Paid for Eda: Kira · 20,000.00 DOP · October 2026 · paid from DR account. Monthly expenses: 1 of 1 paid · Fixed pending: 0.00 DOP. Used so far: 20,000.00 DOP (no budget set). DR account balance: -8,000.00 DOP.',
    );
    expect(paid.data).toMatchObject({ user: EDA, changed: true });
    expect((await getMonth(db, F, '2026-10'))!.fixed.find((f) => f.name === 'Netflix')!.paid).toBe(false);

    // A closed month of Frank's closes nothing for Eda (nor does it exist for her).
    expect(await failsRaw(env, 'list_transactions', { user: E, month: '2026-08' })).toBe('August 2026 does not exist for Eda. Existing months: 2026-10.');
    expect((await callRaw(env, 'list_transactions', { user: F, month: '2026-08' })).data).toMatchObject({ user: FRANK, closed: true, count: 10 });

    // Accounts and incomes are also each user's own: Frank's balances did not move with Eda's records.
    const income = await callRaw(env, 'add_income', { user: E, amount: 5000, account: 'DR account', description: 'Maaş' });
    expect(income.text).toBe(
      'Income recorded for Eda: Maaş · 5,000.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: -3,000.00 DOP. Income in October 2026 so far: 5,000.00 DOP.',
    );
    expect(await listIncomes(db, F)).toHaveLength(3);
    expect(await listIncomes(db, E)).toHaveLength(1);
    const edaAccounts = await callRaw(env, 'list_accounts', { user: E });
    const frankAccounts = await callRaw(env, 'list_accounts', { user: F });
    expect(edaAccounts.text.split('\n').slice(0, 4)).toEqual([
      'Eda · 2 accounts · main currency DOP, second currency USD',
      'US account · USD · balance -200.00 USD (-12,000.00 DOP)',
      'DR account · DOP · balance -3,000.00 DOP · default account',
      'Total money: -15,000.00 DOP (-250.00 USD)',
    ]);
    expect(frankAccounts.text).toContain('DR account · DOP · balance 220,641.93 DOP · default account');
    expect(frankAccounts.data).toMatchObject({ user: FRANK });
    expect(edaAccounts.data).toMatchObject({ user: EDA });
  });

  it('with a single configured user, `user` can be omitted', async () => {
    const { env, db, sqlite } = makeEnv({ USERS: 'frank:Frank' });
    await replaceAll(db, F, seedState());

    const added = await callRaw(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(added.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
    );
    expect(added.data!.user).toEqual(FRANK);
    expect(count(sqlite, 'transactions', F)).toBe(28);

    // Every tool, and also without arguments or with a blank `user`.
    expect((await callRaw(env, 'list_transactions')).data).toMatchObject({ user: FRANK, count: 8 });
    expect((await callRaw(env, 'month_summary', { user: null })).data).toMatchObject({ user: FRANK, month: '2026-10' });
    expect((await callRaw(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, user: '' })).text).toContain('Transfer recorded for Frank:');
    expect((await callRaw(env, 'mark_fixed_paid', { name: 'Netflix' })).text).toContain('Paid for Frank: Netflix');
    expect((await callRaw(env, 'add_income', { amount: 100 })).text).toContain('Income recorded for Frank:');
    expect((await callRaw(env, 'list_accounts')).data).toMatchObject({ user: FRANK, defaultAccountId: 'dr' });

    // Saying it still works, but it has to be that one.
    expect((await callRaw(env, 'month_summary', { user: 'Frank' })).isError).toBe(false);
    expect(await failsRaw(env, 'month_summary', { user: E })).toBe('Invalid data: user: unknown user "eda". Valid users: frank (Frank).');
    expect(count(sqlite, 'months', E)).toBe(0);
  });

  it('without USERS there is a single user, "me", and there is no need to say it either', async () => {
    const { env, sqlite } = makeEnv({ USERS: undefined });
    const r = await callRaw(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(r.text).toBe(
      'Recorded for Me: Uber · 850.00 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. The month October 2026 was created. Used so far: 850.00 DOP (no budget set). DR account balance: -850.00 DOP.',
    );
    expect(r.data!.user).toEqual({ id: 'me', name: 'Me' });
    expect(count(sqlite, 'transactions', 'me')).toBe(1);
    expect(await failsRaw(env, 'month_summary', { user: F })).toBe('Invalid data: user: unknown user "frank". Valid users: me (Me).');
  });
});

describe('add_transaction', () => {
  it('"I spent 850 on Uber today by card"', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 850, category: 'Transport', method: 'Card' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Transport · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
    );

    const stored = (await getMonth(db, F, '2026-10'))!.tx.at(-1)!;
    expect(stored).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      monthKey: '2026-10',
      date: '2026-10-07',
      desc: 'Uber',
      place: '',
      cat: 'Transport',
      method: 'Debit card',
      amount: 850,
      cur: 'DOP',
      // With no account given, it comes out of the user's default account.
      accountId: 'dr',
      notes: '',
      source: 'claude',
      createdAt: NOW.toISOString(),
    } satisfies Record<Exclude<keyof Transaction, 'cardId' | 'cardPaymentId'>, unknown>);
    expect(r.data).toEqual({
      user: FRANK,
      transaction: stored,
      monthCreated: false,
      account: { id: 'dr', name: 'DR account', currency: 'DOP', balance: expect.closeTo(219791.93, 6) },
      month: { key: '2026-10', label: 'October 2026', closed: false, currency: 'DOP', budget: 70000, used: expect.closeTo(49999.71, 6), available: expect.closeTo(20000.29, 6) },
    });
    // The balance it reports is the one from shared/calc.ts with the expense already subtracted.
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('with only a description and an amount it applies the default values the schema announces', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: '  Empanadas  ', amount: 150.5 });
    expect(r.text).toBe(
      'Recorded for Frank: Empanadas · 150.50 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,300.21 of 70,000 DOP. DR account balance: 220,491.43 DOP.',
    );
    expect(r.data!.transaction).toMatchObject({ desc: 'Empanadas', cat: 'Food', method: 'Debit card', cur: 'DOP', accountId: 'dr', date: '2026-10-07', place: '', notes: '' });
  });

  it('honors every field; an amount in another currency is also shown in the main currency and in the account currency', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', {
      description: 'Vuelo',
      amount: 320.45,
      currency: 'USD',
      date: '2026-10-06',
      place: 'JetBlue',
      category: 'Travel',
      method: 'Transfer',
      notes: 'ida',
    });
    // What the person dictated (description, place, notes) stays as is, in their language.
    expect(r.text).toBe(
      'Recorded for Frank: Vuelo · JetBlue · 320.45 USD (18,829.64 DOP) · Travel · Transfer · 2026-10-06 (October 2026) · paid from DR account (18,829.64 DOP). Used so far: 67,979.35 of 70,000 DOP. DR account balance: 201,812.29 DOP.',
    );
    expect(r.data!.transaction).toMatchObject({ desc: 'Vuelo', amount: 320.45, cur: 'USD', place: 'JetBlue', cat: 'Travel', method: 'Transfer', notes: 'ida', date: '2026-10-06' });
  });

  it('a category and a method said in Spanish or Turkish are stored under their canonical name', async () => {
    const { env, db } = await seeded();
    // With "Credit card" there has to be a credit card to charge it to.
    await createCard(db, F, { name: 'Visa' });
    const cases: [category: string, method: string, cat: string, stored: string][] = [
      // "Tarjeta", "Kart" or "card" on its own: the debit card.
      ['Transporte', 'Tarjeta', 'Transport', 'Debit card'],
      ['Ulaşım', 'Kart', 'Transport', 'Debit card'],
      ['Transport', 'card', 'Transport', 'Debit card'],
      ['Transporte', 'Tarjeta de débito', 'Transport', 'Debit card'],
      ['Ulaşım', 'Banka kartı', 'Transport', 'Debit card'],
      ['Ropa', 'Tarjeta de crédito', 'Clothing', 'Credit card'],
      ['Giyim', 'Kredi kartı', 'Clothing', 'Credit card'],
      ['Clothing', 'credit card', 'Clothing', 'Credit card'],
      ['Ropa', 'tarjeta de credito', 'Clothing', 'Credit card'],
      ['Comida', 'Efectivo', 'Food', 'Cash'],
      ['Yemek', 'Nakit', 'Food', 'Cash'],
      ['Food', 'cash', 'Food', 'Cash'],
      ['supermercado', 'app del banco', 'Groceries', 'Bank app'],
      ['Market', 'Banka uygulaması', 'Groceries', 'Bank app'],
      [' YEMEK ', 'Havale', 'Food', 'Transfer'],
      ['Educación', 'TRANSFERENCIA', 'Education', 'Transfer'],
      ['Eğlence', 'kart', 'Entertainment', 'Debit card'],
      // In English, also regardless of case.
      ['travel', 'bank APP', 'Travel', 'Bank app'],
    ];
    for (const [category, method, cat, stored] of cases) {
      const r = await call(env, 'add_transaction', { description: 'Algo', amount: 10, category, method });
      expect(r.isError, `${category} / ${method}`).toBe(false);
      expect(r.text, `${category} / ${method}`).toContain(`Algo · 10.00 DOP · ${cat} · ${stored} · 2026-10-07`);
      expect(r.data!.transaction).toMatchObject({ cat, method: stored });
    }
    const saved = (await getMonth(db, F, '2026-10'))!.tx.slice(-cases.length);
    expect(saved.map((t) => [t.cat, t.method])).toEqual(cases.map(([, , cat, stored]) => [cat, stored]));
    // What is stored is always a value from the canonical lists.
    for (const t of saved) {
      expect(CATS).toContain(t.cat);
      expect(METHODS).toContain(t.method);
    }
    // And the summary groups them with the existing ones, not as separate categories.
    const names = ((await call(env, 'month_summary')).data!.categories as { name: string }[]).map((c) => c.name);
    expect(names).not.toContain('Transporte');
    expect(names).not.toContain('Ulaşım');
    expect(names.filter((n) => n === 'Transport')).toHaveLength(1);
  });

  it('null or empty text in an optional argument counts as "not given"', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Pan', amount: 90, currency: null, date: '', place: null, category: '  ', method: null, notes: '' });
    expect(r.isError).toBe(false);
    expect(r.data!.transaction).toMatchObject({ date: '2026-10-07', place: '', cat: 'Food', method: 'Debit card', cur: 'DOP', notes: '' });
  });

  it('"today" is the date in the Dominican Republic, not in UTC', async () => {
    const { env } = await seeded();
    // 02:30 UTC on November 1 is 22:30 on October 31 in Santo Domingo.
    const r = await call(env, 'add_transaction', { description: 'Cena', amount: 1200 }, new Date('2026-11-01T02:30:00Z'));
    expect(r.data!.transaction).toMatchObject({ date: '2026-10-31', monthKey: '2026-10' });
    expect(r.data!.monthCreated).toBe(false);
  });

  it('warns when the expense leaves the month over budget', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Sofá', amount: 25000, category: 'Home' });
    expect(r.text).toContain('Used so far: 74,149.71 of 70,000 DOP. Over budget by 4,149.71 DOP.');
  });

  it('on an empty database it creates the month of today; with no budget it says so', async () => {
    const { env, sqlite } = makeEnv();
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(r.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. The month October 2026 was created. Used so far: 850.00 DOP (no budget set). DR account balance: -850.00 DOP.',
    );
    expect(r.data!.monthCreated).toBe(true);
    expect(count(sqlite, 'months')).toBe(1);
    expect(count(sqlite, 'months', F)).toBe(1);
  });

  it('creates the next month with the fixed expenses of the previous one, unpaid', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect(r.text).toBe(
      'Recorded for Frank: Regalo · 1,500.00 DOP · Food · Debit card · 2026-11-03 (November 2026) · paid from DR account. The month November 2026 was created. Used so far: 1,500.00 of 70,000 DOP. DR account balance: 219,141.93 DOP.',
    );
    // The balance is the current one: it already counts the expense, even though it is dated in the next month.
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
    const november = (await getMonth(db, F, '2026-11'))!;
    expect(november.fixed).toHaveLength(11);
    expect(november.fixed.every((f) => !f.paid)).toBe(true);
  });

  it('closed month: tool error, without saving anything', async () => {
    const { env, sqlite } = await seeded();
    const text = await fails(env, 'add_transaction', { description: 'Tarde', amount: 100, date: '2026-08-15' });
    expect(text).toBe('August 2026 is closed: it is read-only. Reopen it to make changes.');
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('invalid arguments: tool error with the reason, without saving anything', async () => {
    const { env, sqlite } = await seeded();
    const bad: [Record<string, unknown>, string][] = [
      [{}, 'description: is required'],
      [{ description: 'x' }, 'amount: is required'],
      [{ description: '   ', amount: 10 }, 'description: is required'],
      [{ description: 'x', amount: 0 }, 'amount: must be greater than 0'],
      [{ description: 'x', amount: -3 }, 'amount: must be greater than 0'],
      [{ description: 'x', amount: '850' }, 'amount: must be a number'],
      [{ description: 'x', amount: 10, currency: 'EUR' }, 'currency: must be DOP, USD or TRY'],
      [{ description: 'x', amount: 10, currency: 'pesos' }, 'currency: must be DOP, USD or TRY'],
      [{ description: 'x', amount: 10, account: 5 }, 'account: must be text'],
      [{ description: 'x', amount: 10, account: 'x'.repeat(121) }, 'account: allows up to 120 characters'],
      [{ description: 'x', amount: 10, date: '2026-02-30' }, 'date: is not a valid date (YYYY-MM-DD)'],
      [{ description: 'x', amount: 10, date: 'ayer' }, 'date: is not a valid date (YYYY-MM-DD)'],
      [{ description: 'x', amount: 10, date: '07/10/2026' }, 'date: is not a valid date (YYYY-MM-DD)'],
      // Outside the lists nothing is accepted in any language: it could not be chosen in the app afterwards.
      [{ description: 'x', amount: 10, category: 'Gasolina' }, `category: must be one of: ${CATS.join(', ')}`],
      [{ description: 'x', amount: 10, category: 5 }, `category: must be one of: ${CATS.join(', ')}`],
      [{ description: 'x', amount: 10, method: 'Cheque' }, `method: must be one of: ${METHODS.join(', ')}`],
      [{ description: 'x', amount: 10, method: 'Çek' }, `method: must be one of: ${METHODS.join(', ')}`],
      [{ description: 'x', amount: 10, monthKey: '2026-10' }, 'monthKey'],
      [{ description: 'x'.repeat(201), amount: 10 }, 'description: allows up to 200 characters'],
    ];
    for (const [args, reason] of bad) {
      const text = await fails(env, 'add_transaction', args);
      expect(text, JSON.stringify(args)).toContain('Invalid data');
      expect(text, JSON.stringify(args)).toContain(reason);
      expect(text, JSON.stringify(args)).not.toMatch(SPANISH);
    }
    // The same problem is not repeated in the message.
    expect(await fails(env, 'add_transaction', { description: 'x', amount: 10, date: 'ayer' })).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('does not create a month far from today: a wrong year leaves no ghost month', async () => {
    const { env, sqlite } = await seeded();
    for (const date of ['2025-10-07', '2027-10-07', '2026-03-31', '2026-12-01']) {
      const text = await fails(env, 'add_transaction', { description: 'Uber', amount: 850, date });
      expect(text, date).toContain('is far from today (2026-10-07)');
      expect(text).toContain('Check the year');
    }
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, date: '2025-10-07' })).toBe(
      'The date 2025-10-07 falls in October 2025, a month that does not exist for Frank and is far from today (2026-10-07). Check the year of the date.',
    );
    expect(count(sqlite, 'months', F)).toBe(3);
    expect(count(sqlite, 'transactions', F)).toBe(27);

    // Within the margin it is created: six months back and the next month.
    expect((await call(env, 'add_transaction', { description: 'Viejo', amount: 10, date: '2026-04-15' })).data!.monthCreated).toBe(true);
    expect((await call(env, 'add_transaction', { description: 'Próximo', amount: 10, date: '2026-11-01' })).data!.monthCreated).toBe(true);
    expect(count(sqlite, 'months', F)).toBe(5);
  });

  it('a month that already exists can be written to even if it is far from today; the one of another user does not count', async () => {
    const t = makeEnv();
    const state = seedState();
    state.months['2025-01'] = { ...state.months['2026-10']!, key: '2025-01', budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    await replaceAll(t.db, F, state);
    const r = await call(t.env, 'add_transaction', { description: 'Atrasado', amount: 300, date: '2025-01-20' });
    expect(r.isError).toBe(false);
    expect(r.data!.transaction).toMatchObject({ monthKey: '2025-01', date: '2025-01-20' });
    expect(r.data!.monthCreated).toBe(false);

    // Frank having January 2025 does not make it exist for Eda.
    expect(await failsRaw(t.env, 'add_transaction', { user: E, description: 'Atrasado', amount: 300, date: '2025-01-20' })).toContain(
      'a month that does not exist for Eda and is far from today',
    );
    expect(count(t.sqlite, 'months', E)).toBe(0);
  });

  it('if the expense was saved but the summary could not be read, it confirms anyway (so that it is not repeated)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await seeded();
    const r = await call(failsAfterWrite(t, 'transactions'), 'add_transaction', { description: 'Uber', amount: 12, currency: 'USD' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Recorded for Frank: Uber · 12.00 USD · Food · Debit card · 2026-10-07 (October 2026).');
    expect(r.data).toMatchObject({ user: FRANK, transaction: { desc: 'Uber', amount: 12 }, month: null });
    expect(count(t.sqlite, 'transactions', F)).toBe(28);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('list_transactions', () => {
  it('by default it lists the current month, from the most recent to the oldest', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions');
    expect(r.isError).toBe(false);
    expect(r.text.split('\n')).toEqual([
      'Frank · October 2026: 7 transactions · 10,845.00 DOP in total.',
      '2026-10-07 · Coffee · Starbucks Ágora · 385.00 DOP · Food · Debit card · DR account',
      '2026-10-06 · Gas · Texaco · 2,000.00 DOP · Transport · Debit card · DR account',
      '2026-10-05 · Pharmacy · Farmacia Carol · 1,240.00 DOP · Health · Debit card · DR account',
      '2026-10-04 · Movies · Caribbean Cinemas · 900.00 DOP · Entertainment · Bank app · DR account',
      '2026-10-03 · Lunch · Adrian Tropical · 1,150.00 DOP · Food · Debit card · DR account',
      '2026-10-02 · Uber to work · Uber · 320.00 DOP · Transport · Debit card · DR account',
      '2026-10-01 · Weekly groceries · Supermercado Nacional · 4,850.00 DOP · Groceries · Debit card · DR account',
    ]);
    expect(r.data).toMatchObject({ user: FRANK, month: '2026-10', label: 'October 2026', closed: false, today: '2026-10-07', currency: 'DOP', count: 7, total: 10845, shown: 7 });
    const listed = r.data!.transactions as (Transaction & { inMain: number; account: string | null })[];
    expect(listed.map((t) => t.date)).toEqual(['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);
    expect(listed[0]).toMatchObject({ id: 'seed-tx-2026-10-7', desc: 'Coffee', amount: 385, cur: 'DOP', inMain: 385, accountId: 'dr', account: 'DR account', source: 'web' });
  });

  it('limit trims to the most recent ones and says so', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', { limit: 2 });
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('Frank · October 2026: 7 transactions · 10,845.00 DOP in total. Showing the 2 most recent.');
    expect(lines).toHaveLength(3);
    expect(r.data).toMatchObject({ count: 7, total: 10845, shown: 2 });
    expect(r.data!.transactions).toHaveLength(2);
  });

  it('on the same date the last one recorded goes first; the notes, another currency and the account of each one are shown', async () => {
    const { env } = await seeded();
    await call(env, 'add_transaction', { description: 'Primero', amount: 10 });
    await call(env, 'add_transaction', { description: 'Segundo', amount: 20, account: 'US account', notes: 'propina incluida' });
    const lines = (await call(env, 'list_transactions', { limit: 3 })).text.split('\n');
    expect(lines.slice(1)).toEqual([
      '2026-10-07 · Segundo · 20.00 USD (1,175.20 DOP) · Food · Debit card · US account · Notes: propina incluida',
      '2026-10-07 · Primero · 10.00 DOP · Food · Debit card · DR account',
      '2026-10-07 · Coffee · Starbucks Ágora · 385.00 DOP · Food · Debit card · DR account',
    ]);
    expect(lines[0]).toContain('9 transactions · 12,030.20 DOP in total.');
  });

  it('a closed month can be queried', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', { month: '2026-08', limit: 1 });
    expect(r.text.split('\n')).toEqual([
      'Frank · August 2026 · closed: 10 transactions · 27,850.00 DOP in total. Showing the most recent one.',
      '2026-08-29 · Gas · Shell · 2,000.00 DOP · Transport · Debit card · DR account',
    ]);
    expect(r.data).toMatchObject({ month: '2026-08', closed: true, count: 10 });
  });

  it('a month with no transactions, or with a single one, says so', async () => {
    const { env } = makeEnv();
    await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58 });
    const r = await call(env, 'list_transactions');
    expect(r.text).toBe('Frank · October 2026: no transactions recorded.');
    expect(r.data).toMatchObject({ count: 0, total: 0, shown: 0, transactions: [] });

    await call(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect((await call(env, 'list_transactions')).text.split('\n')).toEqual([
      'Frank · October 2026: 1 transaction · 850.00 DOP in total.',
      '2026-10-07 · Uber · 850.00 DOP · Food · Debit card · DR account',
    ]);
  });

  it('if the calendar month does not exist yet, it uses the current month of the app', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', {}, new Date('2026-11-02T16:00:00Z'));
    expect(r.data).toMatchObject({ month: '2026-10', today: '2026-11-02', count: 7 });
  });

  it('a month that does not exist or is malformed, or an invalid limit: tool error', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'list_transactions', { month: '2026-11' })).toBe(
      'November 2026 does not exist for Frank. Existing months: 2026-08 (closed), 2026-09 (closed), 2026-10.',
    );
    for (const month of ['octubre', 'October 2026', '2026-13', '2026-10-07', 202610]) {
      expect(await fails(env, 'list_transactions', { month })).toContain('month:');
    }
    for (const limit of [0, -1, 2.5, 201, '5']) {
      expect(await fails(env, 'list_transactions', { limit })).toContain('limit:');
    }
    expect(await fails(env, 'list_transactions', { limit: 0 })).toBe('Invalid data: limit: must be at least 1');
    expect(await fails(env, 'list_transactions', { limit: 201 })).toBe('Invalid data: limit: allows up to 200');
    expect(await fails(env, 'list_transactions', { mes: '2026-10' })).toContain('mes');
  });

  it('with no month recorded: tool error, without creating anything', async () => {
    const { env, sqlite } = makeEnv();
    expect(await fails(env, 'list_transactions')).toBe('Frank has no months yet. Record a transaction to create the current month.');
    expect(count(sqlite, 'months')).toBe(0);
  });
});

describe('month_summary', () => {
  it('summarizes the current month with the figures of the panel', async () => {
    const { env, db, sqlite } = await seeded();
    const r = await call(env, 'month_summary');
    expect(r.isError).toBe(false);
    expect(r.text.split('\n')).toEqual([
      'Frank · October 2026 · amounts in DOP',
      'Budget: 70,000.00 DOP (1,191.29 USD) · by account: DR account 70,000.00 DOP',
      // How it got to 70,000: an initial 65,000 and an adjustment of 5,000 on the 5th.
      'Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair)',
      // The same story in one line: the extra is an addition on top of the initial 65,000.
      'Budget summary: initial 65,000.00 DOP · added on 2026-10-05 (Car repair) to DR account +5,000.00 DOP · total budget 70,000.00 DOP · spent 49,149.71 DOP · remaining 20,850.29 DOP',
      // September: 70,000 − (35,872.66 + 106 USD × 58.57 + 24,555) used.
      "Leftover of September 2026: 3,363.46 DOP, not added to this month's budget.",
      'Used so far: 49,149.71 DOP (836.45 USD)',
      'Available: 20,850.29 DOP',
      'Available after pending fixed: 17,129.43 DOP',
      'Monthly expenses: 6 of 11 paid · Fixed paid: 38,304.71 DOP · Fixed pending: 3,720.86 DOP',
      'Still to pay: Google One 121.56 DOP, day 16; iCloud+ 604.00 DOP, day 17; Cluely 308.00 DOP; Smartfit 1,550.00 DOP, day 17; Netflix 1,137.30 DOP',
      'Transactions: 7 (10,845.00 DOP)',
      'By category: Fixed expenses 38,304.71 DOP · Groceries 4,850.00 DOP · Transport 2,320.00 DOP · Food 1,535.00 DOP · Health 1,240.00 DOP · Entertainment 900.00 DOP',
      'Month income: 340,808.00 DOP · Income − used: 291,658.29 DOP',
      'Account balances at the end of October 2026: US account 13,482.00 USD (792,202.32 DOP); DR account 220,641.93 DOP · Total money: 1,012,844.25 DOP (17,236.97 USD)',
      'Month rates: USD to DOP: 58.76 (typed on 2026-10-06)',
      'Rates typed in October 2026: 1 USD = 58.76 DOP from 2026-10-01; 1 USD = 58.76 DOP from 2026-10-06',
      'Today is 2026-10-07.',
    ]);

    const near = (n: number) => expect.closeTo(n, 6);
    expect(r.data).toEqual({
      user: FRANK,
      month: '2026-10',
      label: 'October 2026',
      closed: false,
      today: '2026-10-07',
      currency: 'DOP',
      secondCurrency: 'USD',
      budget: 70000,
      budgetSecond: near(70000 / 58.76),
      budgetParts: [{ accountId: 'dr', name: 'DR account', currency: 'DOP', amount: 70000, fromLog: 70000, fromIncomes: 0, fromTransfers: 0, inMain: 70000 }],
      budgetHistory: [
        { kind: 'initial', id: 'seed-bg-2026-10-1', date: '2026-10-01', accountId: 'dr', account: 'DR account', amount: 65000, currency: 'DOP', note: '', inMain: 65000, total: 65000 },
        { kind: 'adjust', id: 'seed-bg-2026-10-2', date: '2026-10-05', accountId: 'dr', account: 'DR account', amount: 5000, currency: 'DOP', note: 'Car repair', inMain: 5000, total: 70000 },
      ],
      budgetSummary: {
        currency: 'DOP',
        initial: 65000,
        initialLines: [{ id: 'seed-bg-2026-10-1', date: '2026-10-01', accountId: 'dr', account: 'DR account', amount: 65000, currency: 'DOP', inMain: 65000, note: '', incomeId: null, income: null }],
        leftover: 0,
        incomes: 0,
        transfers: 0,
        additions: [{ id: 'seed-bg-2026-10-2', date: '2026-10-05', accountId: 'dr', account: 'DR account', amount: 5000, currency: 'DOP', inMain: 5000, note: 'Car repair', incomeId: null, income: null }],
        added: 5000,
        additionDates: ['2026-10-05'],
        reductions: [],
        reduced: 0,
        total: 70000,
        spent: near(49149.71),
        remaining: near(20850.29),
        secondCurrency: 'USD',
        initialSecond: near(65000 / 58.76),
        addedSecond: near(5000 / 58.76),
        totalSecond: near(70000 / 58.76),
        spentSecond: near(49149.71 / 58.76),
        remainingSecond: near(20850.29 / 58.76),
      },
      leftover: { previousMonth: '2026-09', amount: near(70000 - (35872.66 + (106 * 134721) / 2300 + 24555)), added: false },
      used: near(49149.71),
      usedSecond: near(49149.71 / 58.76),
      available: near(20850.29),
      availableAfterPending: near(17129.43),
      fixed: {
        count: 11,
        paidCount: 6,
        paid: near(38304.71),
        pending: near(3720.86),
        pendingItems: [
          { name: 'Google One', day: '16', amount: 121.56, cur: 'DOP', inMain: 121.56 },
          { name: 'iCloud+', day: '17', amount: 604, cur: 'DOP', inMain: 604 },
          { name: 'Cluely', day: '', amount: 308, cur: 'DOP', inMain: 308 },
          { name: 'Smartfit', day: '17', amount: 1550, cur: 'DOP', inMain: 1550 },
          { name: 'Netflix', day: '', amount: 1137.3, cur: 'DOP', inMain: 1137.3 },
        ],
      },
      transactions: { count: 7, total: 10845 },
      creditCards: [],
      outsideBudget: { count: 0, total: 0, expenses: [] },
      transferFees: [],
      categories: [
        { name: 'Fixed expenses', value: near(38304.71) },
        { name: 'Groceries', value: 4850 },
        { name: 'Transport', value: 2320 },
        { name: 'Food', value: 1535 },
        { name: 'Health', value: 1240 },
        { name: 'Entertainment', value: 900 },
      ],
      income: { count: 1, total: near(340808), left: near(291658.29) },
      accounts: [
        { id: 'us', name: 'US account', currency: 'USD', balance: near(13482), inMain: near(13482 * 58.76) },
        { id: 'dr', name: 'DR account', currency: 'DOP', balance: near(220641.93), inMain: near(220641.93) },
      ],
      totalMoney: { main: near(1012844.25), second: near(13482 + 220641.93 / 58.76) },
      gold: { price: null, excludedFromTotal: false },
      rates: [{ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06', note: 'typed on 2026-10-06' }],
      typedRates: [
        { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
        { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-06' },
      ],
    });
    // The balances and the total are the ones from shared/calc.ts.
    const expected = balances(await loadState(db, F), '2026-10');
    expect(r.data!.accounts.map((a: { balance: number }) => a.balance)).toEqual(expected.accounts.map((a) => a.balance));
    expect(r.data!.totalMoney).toEqual({ main: expected.totalMain, second: expected.totalSecond });
    // It is read-only.
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('a closed month: everything paid and with the weighted rate of its transfers', async () => {
    const { env } = await seeded();
    const r = await call(env, 'month_summary', { month: '2026-08' });
    const lines = r.text.split('\n');
    // (1500 × 58.40 + 300 × 57.10) / 1800
    expect(lines[0]).toBe('Frank · August 2026 · closed · amounts in DOP');
    expect(lines).toContain("Month rates: USD to DOP: 58.18 (from this month's transfers)");
    // The balances are the ones at the end of that month, not today's.
    expect(lines.some((l) => l.startsWith('Account balances at the end of August 2026: US account 5,894.00 USD'))).toBe(true);
    expect(lines).toContain('Transactions: 10 (27,850.00 DOP)');
    expect(lines.some((l) => l.startsWith('Monthly expenses: 11 of 11 paid'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Still to pay'))).toBe(false);
    expect(r.data).toMatchObject({ month: '2026-08', closed: true, fixed: { count: 11, paidCount: 11, pending: expect.closeTo(0, 6), pendingItems: [] } });
    expect(r.data!.rates).toEqual([expect.objectContaining({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-08' })]);
    expect(r.data!.rates[0].rate).toBeCloseTo((1500 * 58.4 + 300 * 57.1) / 1800, 10);
  });

  it('a pending fixed expense in another currency is shown with its equivalent in the main currency', async () => {
    const { env } = await seeded();
    await call(env, 'mark_fixed_paid', { name: 'Claude', paid: false });
    const r = await call(env, 'month_summary');
    expect(r.text).toContain('Still to pay: Claude 106.00 USD (6,228.56 DOP), day 5; Google One 121.56 DOP, day 16;');
    expect(r.data!.fixed.pendingItems[0]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', inMain: expect.closeTo(6228.56, 6) });
  });

  it('a newly created month, with no expenses', async () => {
    const { env } = makeEnv();
    await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58 });
    const r = await call(env, 'month_summary');
    expect(r.text.split('\n')).toEqual([
      'Frank · October 2026 · amounts in DOP',
      'Budget: 0.00 DOP (no budget set)',
      'Used so far: 0.00 DOP (0.00 USD)',
      'Available: 0.00 DOP',
      'Available after pending fixed: 0.00 DOP',
      'Monthly expenses: 0 of 0 paid · Fixed paid: 0.00 DOP · Fixed pending: 0.00 DOP',
      'Transactions: 0 (0.00 DOP)',
      'By category: No expenses yet this month.',
      'Month income: 0.00 DOP · Income − used: 0.00 DOP',
      'Account balances at the end of October 2026: US account -100.00 USD (-5,800.00 DOP); DR account 5,800.00 DOP · Total money: 0.00 DOP (0.00 USD)',
      // With no typed rate, the month rate comes from its transfer.
      "Month rates: USD to DOP: 58.00 (from this month's transfers)",
      'Today is 2026-10-07.',
    ]);
  });

  it('if the calendar month does not exist yet, it summarizes the current month of the app', async () => {
    const { env } = await seeded();
    const r = await call(env, 'month_summary', {}, new Date('2026-11-02T16:00:00Z'));
    expect(r.text.split('\n')[0]).toBe('Frank · October 2026 · amounts in DOP');
    expect(r.text).toContain('Today is 2026-11-02.');
    expect(r.data).toMatchObject({ month: '2026-10', today: '2026-11-02' });
  });

  it('if the calendar month was closed early, it summarizes the next one (and the closed one, if asked)', async () => {
    const { env, db } = await seeded();
    await closeMonth(db, F, '2026-10', {}, NOW);
    const r = await call(env, 'month_summary');
    expect(r.data).toMatchObject({ month: '2026-11', closed: false, today: '2026-10-07', fixed: { count: 11, paidCount: 0 } });
    expect((await call(env, 'month_summary', { month: '2026-10' })).data).toMatchObject({ month: '2026-10', closed: true });
    expect((await call(env, 'list_transactions')).data).toMatchObject({ month: '2026-11', count: 0 });
    // Eda did not close her October: hers is still the current month.
    expect((await callRaw(env, 'month_summary', { user: E })).data).toMatchObject({ user: EDA, month: '2026-10', closed: false });
  });

  it('a later month already created does not displace the calendar month while it stays open', async () => {
    const { env } = await seeded();
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect((await call(env, 'month_summary')).data).toMatchObject({ month: '2026-10', transactions: { count: 7 } });
    expect((await call(env, 'list_transactions')).data).toMatchObject({ month: '2026-10', count: 7 });
    expect((await call(env, 'mark_fixed_paid', { name: 'Netflix' })).data!.fixed.monthKey).toBe('2026-10');
  });

  it('a month that does not exist, a malformed one or an empty database: tool error', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'month_summary', { month: '2027-01' })).toBe(
      'January 2027 does not exist for Frank. Existing months: 2026-08 (closed), 2026-09 (closed), 2026-10.',
    );
    expect(await fails(env, 'month_summary', { month: 'octubre 2026' })).toBe('Invalid data: month: is not a valid month (YYYY-MM)');
    expect(await fails(makeEnv().env, 'month_summary')).toBe('Frank has no months yet. Record a transaction to create the current month.');
  });
});

describe('add_transfer', () => {
  it('records the transfer: what goes out, what comes in and the new balance of both accounts', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 500, rate: 59.4, via: 'PayPal' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Transfer recorded for Frank: 500.00 USD left US account, 29,700.00 DOP arrived in DR account (1 USD = 59.40 DOP) · PayPal · 2026-10-07 (October 2026). US account balance: 12,982.00 USD. DR account balance: 250,341.93 DOP.',
    );

    const stored = (await getMonth(db, F, '2026-10'))!.transfers.at(-1)!;
    expect(stored).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      monthKey: '2026-10',
      date: '2026-10-07',
      via: 'PayPal',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 500,
      rate: 59.4,
      budget: false,
      fee: 0,
    } satisfies Record<keyof Transfer, unknown>);
    expect(r.data).toEqual({
      user: FRANK,
      transfer: stored,
      from: { id: 'us', name: 'US account', currency: 'USD', balance: await balanceOf(db, 'us') },
      to: { id: 'dr', name: 'DR account', currency: 'DOP', balance: await balanceOf(db, 'dr') },
      sent: { amount: 500, currency: 'USD' },
      fee: { amount: 0, currency: 'USD' },
      received: { amount: 29700, currency: 'DOP' },
      rateSource: 'given',
      // Without move_budget the month budget stays at its 70,000.
      month: { key: '2026-10', label: 'October 2026', currency: 'DOP', budget: 70000 },
      monthCreated: false,
    });
    expect(r.text).not.toContain('budget');
    expect(r.data!.from.balance).toBeCloseTo(12982, 8);
    expect(r.data!.to.balance).toBeCloseTo(250341.93, 6);
    // Not an expense: the month's used amount does not change (October's typed rate takes precedence over the transfers' rate).
    expect((await call(env, 'month_summary')).data).toMatchObject({ used: expect.closeTo(49149.71, 6), transactions: { count: 7 } });
  });

  it('accounts are given by their name, ignoring case and accents, by a beginning that matches only one, or by their id', async () => {
    const { env, db } = await seeded();
    for (const [from_account, to_account] of [
      ['us', 'dr'],
      ['us account', '  DR ACCOUNT '],
      ['US', 'dr acc'],
    ]) {
      const r = await call(env, 'add_transfer', { from_account, to_account, amount: 10, rate: 58 });
      expect(r.isError, `${from_account} → ${to_account}`).toBe(false);
      expect(r.data!.transfer).toMatchObject({ fromAccountId: 'us', toAccountId: 'dr' });
    }
    // And in the other direction: it leaves the peso account, in pesos, and the rate is what arrives for each peso.
    const back = await call(env, 'add_transfer', { from_account: 'DR account', to_account: 'US account', amount: 5876, rate: 1 / 58.76 });
    expect(back.text).toContain('5,876.00 DOP left DR account, 100.00 USD arrived in US account (1 USD = 58.76 DOP)');
    expect(back.data).toMatchObject({ sent: { amount: 5876, currency: 'DOP' }, received: { amount: expect.closeTo(100, 8), currency: 'USD' } });
    expect(back.data!.from.balance).toBe(await balanceOf(db, 'dr'));
    expect(back.data!.to.balance).toBe(await balanceOf(db, 'us'));
  });

  it('by default: via Remitly and the date of today', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 1500, rate: 58.76, via: null, date: '' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 1,500.00 USD left US account, 88,140.00 DOP arrived in DR account (1 USD = 58.76 DOP) · Remitly · 2026-10-07 (October 2026). US account balance: 11,982.00 USD. DR account balance: 308,781.93 DOP.',
    );
    expect(r.data!.transfer).toMatchObject({ via: 'Remitly', date: '2026-10-07', monthKey: '2026-10' });
  });

  it('without a rate it uses the month rate for those two currencies and says where it came from', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100 });
    expect(r.text).toBe(
      "Transfer recorded for Frank: 100.00 USD left US account, 5,876.00 DOP arrived in DR account (1 USD = 58.76 DOP) · Remitly · 2026-10-07 (October 2026). No rate was given: the rate in effect on that date was used (typed on 2026-10-06). US account balance: 13,382.00 USD. DR account balance: 226,517.93 DOP.",
    );
    expect(r.data).toMatchObject({ transfer: { rate: 58.76 }, rateSource: 'month', received: { amount: expect.closeTo(5876, 8), currency: 'DOP' } });

    // In November nobody has typed a rate: the last one from October is still in effect, and it says so.
    const november = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, date: '2026-11-02' });
    expect(november.text).toContain('No rate was given: the rate in effect on that date was used (typed on 2026-10-06, still in effect).');
    expect(november.data).toMatchObject({ transfer: { rate: 58.76 }, rateSource: 'previous' });

    // A rate nobody has ever set is a default value: what arrived is approximate and has to be asked about.
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    const lira = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'TR account', amount: 100 });
    expect(lira.text).toBe(
      "Transfer recorded for Frank: 100.00 USD left US account, 4,200.00 TRY arrived in TR account (1 USD = 42.00 TRY) · Remitly · 2026-10-07 (October 2026). No rate was given: the rate in effect on that date was used (default value, not set yet). Nobody has set that rate yet, so the amount that arrived is only approximate: ask the person how much arrived. US account balance: 13,182.00 USD. TR account balance: 4,200.00 TRY.",
    );
    expect(lira.data).toMatchObject({ rateSource: 'default', received: { amount: 4200, currency: 'TRY' } });
    expect(lira.data!.to.balance).toBe(await balanceOf(db, 'tr', F, '2026-11'));
  });

  it('between two accounts of the same currency what arrives equals what leaves', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'ahorro', name: 'Ahorro', currency: 'DOP' });
    const r = await call(env, 'add_transfer', { from_account: 'DR account', to_account: 'ahorro', amount: 5000, via: 'Bank app' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 5,000.00 DOP left DR account, 5,000.00 DOP arrived in Ahorro · Bank app · 2026-10-07 (October 2026). DR account balance: 215,641.93 DOP. Ahorro balance: 5,000.00 DOP.',
    );
    expect(r.data).toMatchObject({
      transfer: { fromAccountId: 'dr', toAccountId: 'ahorro', amount: 5000, rate: 1 },
      sent: { amount: 5000, currency: 'DOP' },
      received: { amount: 5000, currency: 'DOP' },
      rateSource: 'same',
    });
    expect(r.data!.from.balance).toBe(await balanceOf(db, 'dr'));
    expect(r.data!.to.balance).toBe(await balanceOf(db, 'ahorro'));
    // Moving money between one's own accounts changes neither the total nor the month rate.
    const summary = await call(env, 'month_summary');
    expect(summary.data!.totalMoney.main).toBeCloseTo(1012844.25, 6);
    expect(summary.text).toContain('Month rates: USD to DOP: 58.76 (typed on 2026-10-06)');

    // A rate other than 1 would make up or lose money: it is not accepted. Saying 1 does no harm.
    expect(await fails(env, 'add_transfer', { from_account: 'dr', to_account: 'ahorro', amount: 100, rate: 58.76 })).toBe(
      'Invalid data: rate: must be omitted between accounts of the same currency (both are in DOP)',
    );
    expect((await call(env, 'add_transfer', { from_account: 'dr', to_account: 'ahorro', amount: 100, rate: 1 })).data!.transfer.rate).toBe(1);
    expect((await getMonth(db, F, '2026-10'))!.transfers).toHaveLength(3);
  });

  it('a transfer in liras: from the peso account to the account in Turkey, with the rate the person gives', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'Türkiye hesabı', currency: 'TRY' });
    const r = await call(env, 'add_transfer', { from_account: 'DR account', to_account: 'turkiye', amount: 14000, rate: 0.7, via: 'Wise' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 14,000.00 DOP left DR account, 9,800.00 TRY arrived in Türkiye hesabı (1 TRY = 1.43 DOP) · Wise · 2026-10-07 (October 2026). DR account balance: 206,641.93 DOP. Türkiye hesabı balance: 9,800.00 TRY.',
    );
    expect(r.data!.to).toEqual({ id: 'tr', name: 'Türkiye hesabı', currency: 'TRY', balance: await balanceOf(db, 'tr') });
    // That transfer becomes the month rate between pesos and liras.
    expect((await call(env, 'month_summary')).text).toContain("TRY to DOP: 1.43 (from this month's transfers)");
  });

  it('the via is free text: whatever is said is stored, without extra spaces', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, via: '  Western Union ' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('100.00 USD left US account, 5,800.00 DOP arrived in DR account (1 USD = 58.00 DOP) · Western Union · 2026-10-07');
    expect(r.data!.transfer.via).toBe('Western Union');

    // As dictated, in any language, and up to the length the app allows.
    const longest = 'x'.repeat(60);
    for (const via of ['Banco Popular', 'Elden Havale', 'paypal', longest]) {
      expect((await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, via })).data!.transfer.via).toBe(via);
    }
    expect((await getMonth(db, F, '2026-10'))!.transfers.map((t) => t.via)).toEqual(['Remitly', 'Western Union', 'Banco Popular', 'Elden Havale', 'paypal', longest]);
  });

  it('goes to the month of its date and creates it if missing', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 200, rate: 59, date: '2026-11-02' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 200.00 USD left US account, 11,800.00 DOP arrived in DR account (1 USD = 59.00 DOP) · Remitly · 2026-11-02 (November 2026). The month November 2026 was created. US account balance: 13,282.00 USD. DR account balance: 232,441.93 DOP.',
    );
    expect(r.data!.monthCreated).toBe(true);
    const november = (await getMonth(db, F, '2026-11'))!;
    expect(november.transfers).toHaveLength(1);
    expect(november.fixed).toHaveLength(11);
    expect((await getMonth(db, F, '2026-10'))!.transfers).toHaveLength(1);
    // The balances are the current ones, with the November transfer already counted.
    expect(r.data!.to.balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
  });

  it('closed or far-off month: tool error, without saving anything', async () => {
    const { env, sqlite } = await seeded();
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, date: '2026-09-30' })).toBe(
      'September 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    // Not without a rate either, which is when the month rate has to be read.
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, date: '2026-09-30' })).toBe(
      'September 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, date: '2025-10-07' })).toContain('is far from today (2026-10-07)');
    expect(count(sqlite, 'transfers', F)).toBe(5);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('an account that does not exist, is ambiguous or is repeated: tool error that names the accounts, without saving anything', async () => {
    const { env, db, sqlite } = await seeded();
    expect(await fails(env, 'add_transfer', { from_account: 'Banco Popular', to_account: 'dr', amount: 100 })).toBe(
      'Invalid data: from_account: unknown account "Banco Popular" (accounts: US account, DR account)',
    );
    expect(await fails(env, 'add_transfer', { from_account: 'us', to_account: 'PayPal', amount: 100 })).toBe(
      'Invalid data: to_account: unknown account "PayPal" (accounts: US account, DR account)',
    );
    expect(await fails(env, 'add_transfer', { from_account: 'us', to_account: 'US account', amount: 100 })).toBe(
      'Invalid data: to_account: must be a different account from from_account (both are US account)',
    );

    await createAccount(db, F, { name: 'Savings USD', currency: 'USD' });
    await createAccount(db, F, { name: 'Savings DOP', currency: 'DOP' });
    expect(await fails(env, 'add_transfer', { from_account: 'us', to_account: 'savings', amount: 100 })).toBe(
      'Invalid data: to_account: "savings" matches several accounts; use the full name of one of: US account, DR account, Savings USD, Savings DOP',
    );
    // An unrecognized account never gets to create the month of the date.
    expect(await fails(env, 'add_transfer', { from_account: 'us', to_account: 'nada', amount: 100, date: '2026-11-02' })).toContain('unknown account "nada"');
    expect(count(sqlite, 'transfers', F)).toBe(5);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('invalid arguments: tool error with the reason', async () => {
    const { env, sqlite } = await seeded();
    const ok = { ...US_TO_DR, amount: 100, rate: 58 };
    const bad: [Record<string, unknown>, string][] = [
      [{}, 'from_account: is required'],
      [{}, 'to_account: is required'],
      [{ from_account: 'us', to_account: 'dr' }, 'amount: is required'],
      [{ ...ok, amount: 0 }, 'amount: must be greater than 0'],
      [{ ...ok, rate: -58 }, 'rate: must be greater than 0'],
      [{ ...ok, amount: '100' }, 'amount: must be a number'],
      [{ ...ok, from_account: 5 }, 'from_account: must be text'],
      [{ ...ok, via: 5 }, 'via: must be text'],
      [{ ...ok, via: 'x'.repeat(61) }, 'via: allows up to 60 characters'],
      [{ ...ok, date: '2026-10-32' }, 'date: is not a valid date (YYYY-MM-DD)'],
      // The arguments of the previous version no longer exist.
      [{ usd: 100, rate: 58 }, 'usd'],
      [{ ...ok, dop: 5800 }, 'dop'],
    ];
    for (const [args, reason] of bad) {
      const text = await fails(env, 'add_transfer', args);
      expect(text, JSON.stringify(args)).toContain(reason);
      expect(text, JSON.stringify(args)).not.toMatch(SPANISH);
    }
    expect(count(sqlite, 'transfers', F)).toBe(5);
  });

  it('if the transfer was saved but the balances could not be read, it confirms anyway', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await seeded();
    const r = await call(failsAfterWrite(t, 'transfers'), 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58 });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Transfer recorded for Frank: 100.00 USD left US account, 5,800.00 DOP arrived in DR account (1 USD = 58.00 DOP) · Remitly · 2026-10-07 (October 2026).');
    expect(r.data).toMatchObject({ from: { id: 'us', balance: null }, to: { id: 'dr', balance: null } });
    expect(count(t.sqlite, 'transfers', F)).toBe(6);
  });
});

describe('mark_fixed_paid', () => {
  const paidOf = async (db: D1Database, name: string, key = '2026-10') => (await getMonth(db, F, key))!.fixed.find((f) => f.name === name)!.paid;

  it('marks as paid by exact name, case-insensitively', async () => {
    // Eda has a Netflix with the same id: hers is not touched (afterEach checks it).
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: 'NETFLIX' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Paid for Frank: Netflix · 1,137.30 DOP · October 2026 · paid from DR account. Monthly expenses: 7 of 11 paid · Fixed pending: 2,583.56 DOP. Used so far: 50,287.01 of 70,000 DOP. DR account balance: 219,504.63 DOP.',
    );
    expect(await paidOf(db, 'Netflix')).toBe(true);
    expect(r.data).toEqual({
      user: FRANK,
      fixed: {
        id: 'seed-fx-2026-10-10',
        monthKey: '2026-10',
        name: 'Netflix',
        day: '',
        amount: 1137.3,
        cur: 'DOP',
        paid: true,
        accountId: 'dr',
        sort: 9,
      } satisfies Record<Exclude<keyof FixedExpense, 'onCard' | 'cardId'>, unknown>,
      changed: true,
      // While it is paid, it is subtracted from the account it is paid from.
      account: { id: 'dr', name: 'DR account', currency: 'DOP', balance: await balanceOf(db, 'dr') },
      month: {
        key: '2026-10',
        label: 'October 2026',
        closed: false,
        currency: 'DOP',
        budget: 70000,
        used: expect.closeTo(50287.01, 6),
        available: expect.closeTo(19712.99, 6),
        fixedCount: 11,
        paidCount: 7,
        pending: expect.closeTo(2583.56, 6),
      },
    });
    expect(r.data!.account.balance).toBeCloseTo(220641.93 - 1137.3, 6);
  });

  it('ignores extra spaces and accents; with paid: false it leaves it unpaid', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: '  health   INSURANCE ', paid: false });
    expect(r.text).toBe(
      'Marked as not paid for Frank: Health insurance · 5,640.00 DOP · October 2026 · paid from DR account. Monthly expenses: 5 of 11 paid · Fixed pending: 9,360.86 DOP. Used so far: 43,509.71 of 70,000 DOP. DR account balance: 226,281.93 DOP.',
    );
    expect(await paidOf(db, 'Health insurance')).toBe(false);

    // The name of a fixed expense is the person's own data, in their language: it is looked up as they say it.
    await createFixed(db, F, { monthKey: '2026-10', name: 'Seguro médico', amount: 2500, cur: 'DOP' });
    const accent = await call(env, 'mark_fixed_paid', { name: 'seguro medico' });
    expect(accent.text).toBe(
      'Paid for Frank: Seguro médico · 2,500.00 DOP · October 2026 · paid from DR account. Monthly expenses: 6 of 12 paid · Fixed pending: 9,360.86 DOP. Used so far: 46,009.71 of 70,000 DOP. DR account balance: 223,781.93 DOP.',
    );
    expect(await paidOf(db, 'Seguro médico')).toBe(true);
  });

  it('an expense in another currency is shown with its equivalent in the main currency; the balance that changes is the one of its account', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: 'claude', paid: false });
    expect(r.text).toBe(
      'Marked as not paid for Frank: Claude · 106.00 USD (6,228.56 DOP) · October 2026 · paid from US account. Monthly expenses: 5 of 11 paid · Fixed pending: 9,949.42 DOP. Used so far: 42,921.15 of 70,000 DOP. US account balance: 13,588.00 USD.',
    );
    expect(r.data!.account).toEqual({ id: 'us', name: 'US account', currency: 'USD', balance: await balanceOf(db, 'us') });

    // Paid from an account in another currency: it says how much it subtracts from that account.
    await createFixed(db, F, { monthKey: '2026-10', name: 'Spotify', amount: 10, cur: 'USD', accountId: 'dr' });
    const other = await call(env, 'mark_fixed_paid', { name: 'spotify' });
    expect(other.text).toContain('Paid for Frank: Spotify · 10.00 USD (587.60 DOP) · October 2026 · paid from DR account (587.60 DOP).');
    expect(other.text).toContain('DR account balance: 220,054.33 DOP.');
    expect(other.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('the beginning of the name or a part of it works, if it identifies only one', async () => {
    const { env, db } = await seeded();
    expect((await call(env, 'mark_fixed_paid', { name: 'goo' })).data!.fixed.name).toBe('Google One');
    expect((await call(env, 'mark_fixed_paid', { name: 'cloud' })).data!.fixed.name).toBe('iCloud+');
    expect((await call(env, 'mark_fixed_paid', { name: 'fit' })).data!.fixed.name).toBe('Smartfit');
    expect(await paidOf(db, 'Google One')).toBe(true);
    expect(await paidOf(db, 'iCloud+')).toBe(true);
    expect(await paidOf(db, 'Smartfit')).toBe(true);
  });

  it('the exact name beats the beginning, and the beginning beats the part', async () => {
    const { env, db } = await seeded();
    await createFixed(db, F, { monthKey: '2026-10', name: 'Claude Max', amount: 100, cur: 'USD' });
    await createFixed(db, F, { monthKey: '2026-10', name: 'Pet health plan', amount: 3000, cur: 'DOP' });
    expect((await call(env, 'mark_fixed_paid', { name: 'claude', paid: false })).data!.fixed.name).toBe('Claude');
    expect((await call(env, 'mark_fixed_paid', { name: 'health', paid: false })).data!.fixed.name).toBe('Health insurance');
    expect((await call(env, 'mark_fixed_paid', { name: 'plan' })).data!.fixed.name).toBe('Pet health plan');
  });

  it('if it was already in that state it changes nothing and says so', async () => {
    const { env, db } = await seeded();
    const again = await call(env, 'mark_fixed_paid', { name: 'fridge' });
    expect(again.isError).toBe(false);
    expect(again.text).toBe(
      'Fridge payment was already paid for Frank in October 2026: nothing was changed. Monthly expenses: 6 of 11 paid · Fixed pending: 3,720.86 DOP. Used so far: 49,149.71 of 70,000 DOP. DR account balance: 220,641.93 DOP.',
    );
    expect(again.data).toMatchObject({ user: FRANK, changed: false, fixed: { name: 'Fridge payment', paid: true } });

    const unpaid = await call(env, 'mark_fixed_paid', { name: 'Netflix', paid: false });
    expect(unpaid.text).toContain('Netflix was already not paid for Frank in October 2026: nothing was changed.');
    expect(await paidOf(db, 'Netflix')).toBe(false);

    // Repeating the same call gives the same state (it is idempotent).
    await call(env, 'mark_fixed_paid', { name: 'Netflix' });
    const repeated = await call(env, 'mark_fixed_paid', { name: 'Netflix' });
    expect(repeated.data).toMatchObject({ changed: false, month: { paidCount: 7 } });
  });

  it('ambiguous name: tool error with the names of the month, without changing anything', async () => {
    const { env, db } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'cl' })).toBe(
      `"cl" matches several fixed expenses for Frank in October 2026: Claude, Cluely. Repeat the call with the exact name. Fixed expenses in October 2026: ${FIXED_NAMES}.`,
    );
    // "t" does not start any name, but it is inside several.
    expect(await fails(env, 'mark_fixed_paid', { name: 't' })).toContain(
      'matches several fixed expenses for Frank in October 2026: Electricity, Internet, Health insurance, Fridge payment, Smartfit, Netflix.',
    );
    expect(await paidOf(db, 'Cluely')).toBe(false);

    await createFixed(db, F, { monthKey: '2026-10', name: 'netflix', amount: 500, cur: 'DOP' });
    expect(await fails(env, 'mark_fixed_paid', { name: 'Netflix' })).toContain('matches several fixed expenses for Frank in October 2026: Netflix, netflix.');
  });

  it('a name that matches none: tool error with the names of the month', async () => {
    const { env, sqlite } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'Gimnasio' })).toBe(
      `No fixed expense for Frank in October 2026 matches "Gimnasio". Fixed expenses in October 2026: ${FIXED_NAMES}.`,
    );
    // Names are not translated: "Luz" is not "Electricity".
    expect(await fails(env, 'mark_fixed_paid', { name: 'Luz' })).toContain('No fixed expense for Frank in October 2026 matches "Luz".');
    expect(await fails(env, 'mark_fixed_paid', { name: '´' })).toContain('No fixed expense for Frank in October 2026 matches');
    const paid = sqlite.sqlite.prepare("SELECT COUNT(*) AS n FROM fixed_expenses WHERE user_id = 'frank' AND month_key = '2026-10' AND paid = 1").get();
    expect(paid?.n).toBe(6);
  });

  it('closed month: it cannot be changed, but what was already there can be confirmed', async () => {
    const { env, db } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'Electricity', month: '2026-08', paid: false })).toBe(
      'August 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    expect(await paidOf(db, 'Electricity', '2026-08')).toBe(true);

    const same = await call(env, 'mark_fixed_paid', { name: 'Electricity', month: '2026-08' });
    expect(same.isError).toBe(false);
    expect(same.text).toContain('Electricity was already paid for Frank in August 2026: nothing was changed.');
  });

  it('uses the current month of the app if the calendar month does not exist yet', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: 'Smartfit' }, new Date('2026-11-02T16:00:00Z'));
    expect(r.text).toContain('Paid for Frank: Smartfit · 1,550.00 DOP · October 2026 · paid from DR account.');
    expect(await paidOf(db, 'Smartfit')).toBe(true);
  });

  it('if the calendar month was closed early, it marks the expense of the next month', async () => {
    const { env, db } = await seeded();
    await closeMonth(db, F, '2026-10', {}, NOW);
    const r = await call(env, 'mark_fixed_paid', { name: 'Electricity' });
    expect(r.text).toBe(
      'Paid for Frank: Electricity · 1,337.15 DOP · November 2026 · paid from DR account. Monthly expenses: 1 of 11 paid · Fixed pending: 40,688.42 DOP. Used so far: 1,337.15 of 70,000 DOP. DR account balance: 219,304.78 DOP.',
    );
    expect(await paidOf(db, 'Electricity', '2026-11')).toBe(true);
  });

  it('a month that does not exist, one with no fixed expenses or invalid arguments: tool error', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'Electricity', month: '2026-12' })).toContain('December 2026 does not exist for Frank');
    const bad: [Record<string, unknown>, string][] = [
      [{}, 'name: is required'],
      [{ name: '' }, 'name: is required'],
      [{ name: 5 }, 'name: must be text'],
      [{ name: 'Electricity', paid: 'sí' }, 'paid: must be true or false'],
      [{ name: 'Electricity', month: 'octubre' }, 'month: is not a valid month (YYYY-MM)'],
      [{ name: 'Electricity', amount: 1500 }, 'amount'],
    ];
    for (const [args, reason] of bad) {
      expect(await fails(env, 'mark_fixed_paid', args), JSON.stringify(args)).toContain(reason);
    }

    const empty = makeEnv();
    await call(empty.env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(await fails(empty.env, 'mark_fixed_paid', { name: 'Electricity' })).toBe('Frank has no fixed expenses in October 2026.');
  });

  it('touches nothing but `paid`', async () => {
    const { env, db } = await seeded();
    const before = await loadState(db, F);
    await call(env, 'mark_fixed_paid', { name: 'Cluely' });
    const after = await loadState(db, F);
    const expected = structuredClone(before);
    expected.months['2026-10']!.fixed.find((f) => f.name === 'Cluely')!.paid = true;
    expect(after).toEqual(expected);
  });
});

describe('add_transaction: accounts and currencies', () => {
  it('with `account` it comes out of that account, in its currency unless another is given, and reports its new balance', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Netflix', amount: 20, account: 'US account', category: 'Subscriptions' });
    expect(r.text).toBe(
      'Recorded for Frank: Netflix · 20.00 USD (1,175.20 DOP) · Subscriptions · Debit card · 2026-10-07 (October 2026) · paid from US account. Used so far: 50,324.91 of 70,000 DOP. US account balance: 13,462.00 USD.',
    );
    expect(r.data!.transaction).toMatchObject({ amount: 20, cur: 'USD', accountId: 'us' });
    expect(r.data!.account).toEqual({ id: 'us', name: 'US account', currency: 'USD', balance: await balanceOf(db, 'us') });
    expect(r.data!.account.balance).toBeCloseTo(13462, 8);
    // The peso account did not move.
    expect(await balanceOf(db, 'dr')).toBeCloseTo(220641.93, 6);
  });

  it('the account is recognized by its id, by its name ignoring case and accents, or by a beginning that matches only one', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'Türkiye hesabı', currency: 'TRY' });
    const cases: [account: string, id: string][] = [
      ['us', 'us'],
      ['US ACCOUNT', 'us'],
      ['  dr   account ', 'dr'],
      ['DR', 'dr'],
      ['turkiye hesabi', 'tr'],
      ['Türk', 'tr'],
    ];
    for (const [account, id] of cases) {
      const r = await call(env, 'add_transaction', { description: 'Algo', amount: 1, account });
      expect(r.isError, account).toBe(false);
      expect(r.data!.transaction.accountId, account).toBe(id);
      expect(r.data!.account.id, account).toBe(id);
    }
  });

  it('an account that does not exist or an ambiguous name: tool error that names the accounts, without saving anything', async () => {
    const { env, db, sqlite } = await seeded();
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Banco Popular' })).toBe(
      'Invalid data: account: unknown account "Banco Popular" (accounts: US account, DR account)',
    );
    // A part of the name that is not its beginning does not work: "account" is in both.
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'account' })).toContain('unknown account "account"');

    await createAccount(db, F, { name: 'Savings USD', currency: 'USD' });
    await createAccount(db, F, { name: 'Savings DOP', currency: 'DOP' });
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'savings' })).toBe(
      'Invalid data: account: "savings" matches several accounts; use the full name of one of: US account, DR account, Savings USD, Savings DOP',
    );
    expect((await call(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'savings d' })).data!.account.name).toBe('Savings DOP');

    // A hidden account is not offered among the valid ones.
    const hidden = (await loadState(db, F)).accounts.find((a) => a.name === 'Savings USD')!;
    await patchAccount(db, F, hidden.id, { hidden: true });
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Nada' })).toBe(
      'Invalid data: account: unknown account "Nada" (accounts: US account, DR account, Savings DOP)',
    );
    // Another user's account does not exist for this one; an unrecognized one does not create the month of the date.
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Nada', date: '2026-11-03' })).toContain('unknown account');
    expect(count(sqlite, 'transactions', F)).toBe(28);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('without `account` it comes out of the default account of the user, which is changed in the settings', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 15 });
    // And without `currency`, in the currency of that account.
    expect(r.text).toBe(
      'Recorded for Frank: Uber · 15.00 USD (881.40 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from US account. Used so far: 50,031.11 of 70,000 DOP. US account balance: 13,467.00 USD.',
    );
    expect(r.data!.transaction).toMatchObject({ cur: 'USD', accountId: 'us' });
  });

  it('an amount in liras is stored in liras and is subtracted from the account converted at the month rate', async () => {
    const { env, db } = await seeded();
    await setMonthRate(db, F, '2026-10', { from: 'TRY', to: 'DOP', rate: 1.5, date: '2026-10-01' });
    const r = await call(env, 'add_transaction', { description: 'Çay', amount: 500, currency: 'TRY' });
    expect(r.text).toBe(
      'Recorded for Frank: Çay · 500.00 TRY (750.00 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account (750.00 DOP). Used so far: 49,899.71 of 70,000 DOP. DR account balance: 219,891.93 DOP.',
    );
    // What is stored is what the person said, unconverted.
    expect(r.data!.transaction).toMatchObject({ amount: 500, cur: 'TRY', accountId: 'dr' });
    expect((await getMonth(db, F, '2026-10'))!.tx.at(-1)).toMatchObject({ amount: 500, cur: 'TRY' });
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
    expect(r.data!.account.balance).toBeCloseTo(220641.93 - 750, 6);
  });

  it('if nobody has set the rate of that currency, it converts with the default value and warns that it is approximate', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Çay', amount: 500, currency: 'TRY' });
    // 1 USD = 42 TRY as the default value and 58.76 DOP: 500 TRY = 699.52 DOP.
    expect(r.text).toBe(
      'Recorded for Frank: Çay · 500.00 TRY (699.52 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account (699.52 DOP). Used so far: 49,849.23 of 70,000 DOP. DR account balance: 219,942.41 DOP. Note: the rate TRY to DOP (1.40) is a default value, not set yet, so the converted amounts are only approximate.',
    );
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
    // With the usual currencies there is nothing to warn about.
    expect((await call(env, 'add_transaction', { description: 'Uber', amount: 12, currency: 'USD' })).text).not.toContain('Note:');
  });

  it('a lira account: the expense comes out in liras and its balance is reported in liras', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: 10000 });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const r = await call(env, 'add_transaction', { description: 'Market', amount: 1200, account: 'TR account', category: 'Market' });
    // With no direct rate between liras and pesos, it is crossed through the dollar: 1,200 ÷ 40 × 58.76.
    expect(r.text).toBe(
      'Recorded for Frank: Market · 1,200.00 TRY (1,762.80 DOP) · Groceries · Debit card · 2026-10-07 (October 2026) · paid from TR account. Used so far: 50,912.51 of 70,000 DOP. TR account balance: 8,800.00 TRY.',
    );
    expect(r.data!.account).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', balance: 8800 });
    expect(await balanceOf(db, 'tr')).toBe(8800);

    // Dollars paid from the lira account: they are stored in dollars and liras are subtracted from the account.
    const usd = await call(env, 'add_transaction', { description: 'Hotel', amount: 50, currency: 'USD', account: 'tr' });
    expect(usd.text).toContain('Hotel · 50.00 USD (2,938.00 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from TR account (2,000.00 TRY).');
    expect(usd.text).toContain('TR account balance: 6,800.00 TRY.');
    expect(usd.data!.account.balance).toBe(await balanceOf(db, 'tr'));
  });

  it('the month figures are in the main currency of each user', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' });
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 587.6 });
    const c = monthCalc(await loadState(db, F), '2026-10');
    expect(c.main).toBe('USD');
    // The expense still comes out of the default account (the peso one), in pesos; the used amount is reported in dollars.
    expect(r.text).toBe(
      `Recorded for Frank: Uber · 587.60 DOP (10.00 USD) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: ${f2(c.used)} of 1,191 USD. DR account balance: 220,054.33 DOP.`,
    );
    expect(r.data!.month).toMatchObject({ currency: 'USD', used: c.used, budget: c.budget });
  });
});

describe('month_summary: budget by account, currencies and rates', () => {
  it('the budget is split by the account it comes out of, each part in its currency', async () => {
    const { env, db } = await seeded();
    await patchMonth(db, F, '2026-10', { budgets: { us: 200 } });
    const r = await call(env, 'month_summary');
    expect(r.text.split('\n')[1]).toBe('Budget: 81,752.00 DOP (1,391.29 USD) · by account: US account 200.00 USD (11,752.00 DOP); DR account 70,000.00 DOP');
    expect(r.data).toMatchObject({
      budget: expect.closeTo(81752, 6),
      budgetParts: [
        { accountId: 'us', name: 'US account', currency: 'USD', amount: 200, inMain: expect.closeTo(11752, 6) },
        { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: 70000, inMain: 70000 },
      ],
      available: expect.closeTo(81752 - 49149.71, 6),
    });
  });

  it('the month income is the sum of the incomes dated in it', async () => {
    const { env } = await seeded();
    await call(env, 'add_income', { amount: 10000, description: 'Freelance' });
    await call(env, 'add_income', { amount: 100, currency: 'USD', date: '2026-09-30' });
    const r = await call(env, 'month_summary');
    // 5,800 USD × 58.76 + 10,000 DOP; the September one does not count.
    expect(r.text).toContain('Month income: 350,808.00 DOP · Income − used: 301,658.29 DOP');
    expect(r.data!.income).toEqual({ count: 2, total: expect.closeTo(350808, 6), left: expect.closeTo(301658.29, 6) });
  });

  it('says where each rate comes from when it is not the one of the month itself', async () => {
    const { env, db } = await seeded();
    const ratesOf = async (month?: string) => (await call(env, 'month_summary', month ? { month } : {})).text.split('\n').find((l) => l.startsWith('Month rates:'));

    // A lira account and nobody has typed its rate: default value, stated plainly.
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: 4200 });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.40 (default value, not set yet)');
    const fallback = await call(env, 'month_summary');
    expect(fallback.data!.rates[1]).toEqual({ from: 'TRY', to: 'DOP', rate: expect.closeTo(58.76 / 42, 10), source: 'default', monthKey: null, date: null, note: 'default value, not set yet' });
    expect(fallback.text).toContain('TR account 4,200.00 TRY (5,876.00 DOP)');

    // With the month's dollar → lira rate, the lira-to-peso one is crossed through the dollar.
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.47 (crossed through USD)');

    // Typed for the month, in either direction.
    await setMonthRate(db, F, '2026-10', { from: 'DOP', to: 'TRY', rate: 0.8, date: '2026-10-01' });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.25 (typed on 2026-10-01)');

    // November has no rates of its own: the last ones typed in October stay in effect, and it says when they are from.
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect(await ratesOf('2026-11')).toBe(
      'Month rates: USD to DOP: 58.76 (typed on 2026-10-06, still in effect); TRY to DOP: 1.25 (typed on 2026-10-01, still in effect)',
    );
    // August predates all that: its dollar rate comes from its transfers and for the lira only the default value is left.
    expect(await ratesOf('2026-08')).toBe("Month rates: USD to DOP: 58.18 (from this month's transfers); TRY to DOP: 1.40 (default value, not set yet)");
  });

  it('everything is in the main currency of the user, with its code, and the second currency in parentheses', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: 4000 });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    await updateSettings(db, F, { mainCurrency: 'TRY', secondCurrency: 'USD' });
    const state = await loadState(db, F);
    const c = monthCalc(state, '2026-10');
    const b = balances(state, '2026-10');
    expect(c.main).toBe('TRY');

    const r = await call(env, 'month_summary');
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('Frank · October 2026 · amounts in TRY');
    // 70,000 DOP ÷ 58.76 × 40 liras.
    expect(lines[1]).toBe('Budget: 47,651.46 TRY (1,191.29 USD) · by account: DR account 70,000.00 DOP (47,651.46 TRY)');
    // The history is in the currency of each account.
    expect(lines[2]).toBe('Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair)');
    expect(lines[3]).toMatch(/^Budget summary: initial 44,247\.79 TRY · added on 2026-10-05 \(Car repair\) to DR account \+5,000\.00 DOP · total budget 47,651\.46 TRY · spent [\d,.]+ TRY · remaining [\d,.]+ TRY$/);
    expect(lines[4]).toMatch(/^Leftover of September 2026: [\d,.]+ TRY, not added to this month's budget\.$/);
    expect(lines[5]).toBe(`Used so far: ${f2(c.used)} TRY (836.45 USD)`);
    expect(lines[6]).toBe(`Available: ${f2(c.avail)} TRY`);
    expect(lines).toContain(`Transactions: 7 (${f2(c.varSpent)} TRY)`);
    expect(lines).toContain(`Month income: 232,000.00 TRY · Income − used: ${f2(c.incomeLeft)} TRY`);
    expect(lines).toContain(
      `Account balances at the end of October 2026: US account 13,482.00 USD (539,280.00 TRY); DR account 220,641.93 DOP (${f2(b.accounts[1]!.inMain)} TRY); TR account 4,000.00 TRY · Total money: ${f2(b.totalMain)} TRY (${f2(b.totalSecond!)} USD)`,
    );
    // Each rate is read in the direction in which it is worth more than 1: "TRY to DOP: 1.47", not "DOP to TRY: 0.68".
    expect(lines).toContain('Month rates: TRY to DOP: 1.47 (crossed through USD); USD to TRY: 40.00 (typed on 2026-10-01)');
    expect(r.text).toContain('Still to pay: Google One 121.56 DOP (82.75 TRY), day 16;');
    expect(r.data).toMatchObject({ currency: 'TRY', secondCurrency: 'USD', budget: c.budget, used: c.used, usedSecond: c.usedSecond, totalMoney: { main: b.totalMain, second: b.totalSecond } });

    // And the transactions, likewise.
    const list = (await call(env, 'list_transactions', { limit: 1 })).text.split('\n');
    expect(list[0]).toBe(`Frank · October 2026: 7 transactions · ${f2(c.varSpent)} TRY in total. Showing the most recent one.`);
    expect(list[1]).toBe('2026-10-07 · Coffee · Starbucks Ágora · 385.00 DOP (262.08 TRY) · Food · Debit card · DR account');
  });

  it('hidden accounts do not appear in the balances or count in the total', async () => {
    const { env, db } = await seeded();
    await patchAccount(db, F, 'us', { hidden: true });
    const r = await call(env, 'month_summary');
    expect(r.text).toContain('Account balances at the end of October 2026: DR account 220,641.93 DOP · Total money: 220,641.93 DOP (3,754.97 USD)');
    expect(r.data!.accounts.map((a: { id: string }) => a.id)).toEqual(['dr']);
  });
});

describe('add_income', () => {
  it('"I got paid 2,500 for a job": it goes into the default account, in its currency, and reports the balance and the month income', async () => {
    const { env, db, sqlite } = await seeded();
    const r = await call(env, 'add_income', { amount: 2500, description: '  Freelance ' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Income recorded for Frank: Freelance · 2,500.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: 223,141.93 DOP. Income in October 2026 so far: 343,308.00 DOP.',
    );

    const stored = (await listIncomes(db, F)).find((i) => i.desc === 'Freelance')!;
    expect(stored).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      date: '2026-10-07',
      desc: 'Freelance',
      accountId: 'dr',
      amount: 2500,
      cur: 'DOP',
      budget: false,
      rate: null,
      recurring: false,
    } satisfies Record<keyof Income, unknown>);
    expect(r.data).toEqual({
      user: FRANK,
      income: stored,
      account: { id: 'dr', name: 'DR account', currency: 'DOP', balance: await balanceOf(db, 'dr') },
      month: { key: '2026-10', label: 'October 2026', currency: 'DOP', income: expect.closeTo(343308, 6), incomeCount: 2, budget: 70000 },
    });
    expect(r.data!.account.balance).toBeCloseTo(220641.93 + 2500, 6);
    // An income is not an expense and does not touch the month: there is only one more row in incomes.
    expect(count(sqlite, 'incomes', F)).toBe(4);
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect((await call(env, 'month_summary')).data).toMatchObject({ used: expect.closeTo(49149.71, 6), income: { count: 2 } });
  });

  it('with `account` it goes into that account, in its currency; the date and the description are optional', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 5800, account: 'us account', description: 'Salary', date: '2026-10-05' });
    expect(r.text).toBe(
      'Income recorded for Frank: Salary · 5,800.00 USD (340,808.00 DOP) · into US account · 2026-10-05 (October 2026). US account balance: 19,282.00 USD. Income in October 2026 so far: 681,616.00 DOP.',
    );
    expect(r.data!.income).toMatchObject({ accountId: 'us', cur: 'USD', amount: 5800, date: '2026-10-05' });
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'us'));

    const bare = await call(env, 'add_income', { amount: 100, account: 'us', description: null, date: '', currency: null });
    expect(bare.text).toBe(
      'Income recorded for Frank: 100.00 USD (5,876.00 DOP) · into US account · 2026-10-07 (October 2026). US account balance: 19,382.00 USD. Income in October 2026 so far: 687,492.00 DOP.',
    );
    expect(bare.data!.income).toMatchObject({ desc: '', date: '2026-10-07' });
  });

  it('in the currency the person says: it is stored that way and goes into the account converted at the month rate', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 100, currency: 'USD', description: 'Propina' });
    expect(r.text).toBe(
      'Income recorded for Frank: Propina · 100.00 USD (5,876.00 DOP) · into DR account (5,876.00 DOP) · 2026-10-07 (October 2026). DR account balance: 226,517.93 DOP. Income in October 2026 so far: 346,684.00 DOP.',
    );
    expect(r.data!.income).toMatchObject({ amount: 100, cur: 'USD', accountId: 'dr' });
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('an income in liras, into a lira account or into another one', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    await setMonthRate(db, F, '2026-10', { from: 'TRY', to: 'DOP', rate: 1.5, date: '2026-10-01' });
    const own = await call(env, 'add_income', { amount: 30000, account: 'TR account', description: 'Maaş' });
    expect(own.text).toBe(
      'Income recorded for Frank: Maaş · 30,000.00 TRY (45,000.00 DOP) · into TR account · 2026-10-07 (October 2026). TR account balance: 30,000.00 TRY. Income in October 2026 so far: 385,808.00 DOP.',
    );
    expect(own.data!.income).toMatchObject({ amount: 30000, cur: 'TRY', accountId: 'tr' });
    expect(await balanceOf(db, 'tr')).toBe(30000);

    const other = await call(env, 'add_income', { amount: 1000, currency: 'TRY', account: 'DR account' });
    expect(other.text).toContain('1,000.00 TRY (1,500.00 DOP) · into DR account (1,500.00 DOP)');
    expect(other.text).toContain('DR account balance: 222,141.93 DOP.');
    expect(other.data!.account.balance).toBe(await balanceOf(db, 'dr'));
    expect(other.text).not.toContain('Note:');
  });

  it('if nobody has set the rate of that currency, it warns that the converted amount is approximate', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_income', { amount: 1000, currency: 'TRY' });
    expect(r.text).toBe(
      'Income recorded for Frank: 1,000.00 TRY (1,399.05 DOP) · into DR account (1,399.05 DOP) · 2026-10-07 (October 2026). DR account balance: 222,040.98 DOP. Income in October 2026 so far: 342,207.05 DOP. Note: the rate TRY to DOP (1.40) is a default value, not set yet, so the converted amounts are only approximate.',
    );
  });

  it('it does not belong to a month: it can be recorded in a closed one or in one that does not exist yet, without creating it', async () => {
    const { env, db, sqlite } = await seeded();
    const closed = await call(env, 'add_income', { amount: 1000, date: '2026-08-15', description: 'Atrasado' });
    expect(closed.isError).toBe(false);
    // August converts with its own rate; the balance it reports is the current one.
    expect(closed.text).toBe(
      'Income recorded for Frank: Atrasado · 1,000.00 DOP · into DR account · 2026-08-15 (August 2026). DR account balance: 221,641.93 DOP. Income in August 2026 so far: 338,463.33 DOP.',
    );
    expect(closed.data!.account.balance).toBe(await balanceOf(db, 'dr'));

    const next = await call(env, 'add_income', { amount: 500, date: '2026-11-01' });
    expect(next.text).toBe(
      'Income recorded for Frank: 500.00 DOP · into DR account · 2026-11-01 (November 2026). DR account balance: 222,141.93 DOP. Income in November 2026 so far: 500.00 DOP.',
    );
    expect(next.data!.account.balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('a date far from today is rejected: a wrong year would move a balance without anyone seeing it', async () => {
    const { env, sqlite } = await seeded();
    for (const date of ['2025-10-07', '2027-10-07', '2026-03-31', '2026-12-01']) {
      expect(await fails(env, 'add_income', { amount: 100, date }), date).toContain('is far from today (2026-10-07)');
    }
    expect(count(sqlite, 'incomes', F)).toBe(3);
  });

  it('someone who never opened the web app gets their initial accounts and the income goes into the default one', async () => {
    const { env, db, sqlite } = makeEnv();
    const r = await callRaw(env, 'add_income', { user: E, amount: 100 });
    expect(r.text).toBe('Income recorded for Eda: 100.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: 100.00 DOP. Income in October 2026 so far: 100.00 DOP.');
    expect(r.data).toMatchObject({ user: EDA, account: { id: 'dr', balance: 100 } });
    expect((await loadState(db, E)).accounts.map((a) => a.name)).toEqual(['US account', 'DR account']);
    expect(count(sqlite, 'months')).toBe(0);
    expect(count(sqlite, 'incomes', F)).toBe(0);
    expect(count(sqlite, 'accounts', F)).toBe(0);
  });

  it('unknown or ambiguous account, or invalid arguments: tool error with the reason, without saving anything', async () => {
    const { env, db, sqlite } = await seeded();
    expect(await fails(env, 'add_income', { amount: 100, account: 'Banco Popular' })).toBe(
      'Invalid data: account: unknown account "Banco Popular" (accounts: US account, DR account)',
    );
    await createAccount(db, F, { name: 'Savings USD', currency: 'USD' });
    await createAccount(db, F, { name: 'Savings DOP', currency: 'DOP' });
    expect(await fails(env, 'add_income', { amount: 100, account: 'sav' })).toBe(
      'Invalid data: account: "sav" matches several accounts; use the full name of one of: US account, DR account, Savings USD, Savings DOP',
    );

    const bad: [Record<string, unknown>, string][] = [
      [{}, 'amount: is required'],
      [{ amount: 0 }, 'amount: must be greater than 0'],
      [{ amount: -5 }, 'amount: must be greater than 0'],
      [{ amount: '100' }, 'amount: must be a number'],
      [{ amount: 100, currency: 'EUR' }, 'currency: must be DOP, USD or TRY'],
      [{ amount: 100, account: 5 }, 'account: must be text'],
      [{ amount: 100, date: '2026-02-30' }, 'date: is not a valid date (YYYY-MM-DD)'],
      [{ amount: 100, date: 'ayer' }, 'date: is not a valid date (YYYY-MM-DD)'],
      [{ amount: 100, description: 5 }, 'description: must be text'],
      [{ amount: 100, description: 'x'.repeat(201) }, 'description: allows up to 200 characters'],
      [{ amount: 100, category: 'Food' }, 'category'],
    ];
    for (const [args, reason] of bad) {
      const text = await fails(env, 'add_income', args);
      expect(text, JSON.stringify(args)).toContain('Invalid data');
      expect(text, JSON.stringify(args)).toContain(reason);
      expect(text, JSON.stringify(args)).not.toMatch(SPANISH);
    }
    expect(count(sqlite, 'incomes', F)).toBe(3);
  });

  it('if the income was saved but the balance could not be read, it confirms anyway (so that it is not repeated)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await seeded();
    const r = await call(failsAfterWrite(t, 'incomes'), 'add_income', { amount: 100, currency: 'USD', description: 'Freelance' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe('Income recorded for Frank: Freelance · 100.00 USD · into DR account · 2026-10-07 (October 2026).');
    expect(r.data).toMatchObject({ user: FRANK, income: { amount: 100, cur: 'USD' }, account: { id: 'dr', balance: null }, month: null });
    expect(count(t.sqlite, 'incomes', F)).toBe(4);
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('budget with history, leftover and incomes that raise it', () => {
  it('add_income with add_to_budget: the income goes into the account and also raises the month budget, and says so', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 2500, description: 'Bonus', add_to_budget: true });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Income recorded for Frank: Bonus · 2,500.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: 223,141.93 DOP. Income in October 2026 so far: 343,308.00 DOP. It was also added to the budget of October 2026, now 72,500.00 DOP.',
    );
    expect(r.data!.income).toMatchObject({ desc: 'Bonus', amount: 2500, cur: 'DOP', accountId: 'dr', budget: true });
    expect(r.data!.month).toMatchObject({ key: '2026-10', budget: 72500 });
    expect((await listIncomes(db, F)).at(-1)!.budget).toBe(true);
    // It is not written to the budget log: the calculation adds it.
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(2);
    const c = monthCalc(await loadState(db, F), '2026-10');
    expect([c.budget, f2(c.avail)]).toEqual([72500, '23,350.29']);

    // Without asking for it (or with false), the budget does not move and the response does not mention it.
    const plain = await call(env, 'add_income', { amount: 100, add_to_budget: false });
    expect(plain.text).not.toContain('budget');
    expect(plain.data!.income.budget).toBe(false);
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(72500);
    expect(await fails(env, 'add_income', { amount: 100, add_to_budget: 'yes' })).toBe('Invalid data: add_to_budget: must be true or false');
  });

  it('add_transfer with fee: the fee comes out of the origin account, counts as a transaction of the month and month_summary shows it', async () => {
    const { env, db } = await seeded();
    const before = monthCalc(await loadState(db, F), '2026-10');
    const us = balances(await loadState(db, F), '2026-10').accounts.find((a) => a.account.id === 'us')!.balance;
    const r = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 100, rate: 59, fee: 2.99 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('The fee of 2.99 USD also left US account and counts as a transaction of October 2026 (category Other).');
    expect(r.data!.transfer).toMatchObject({ amount: 100, fee: 2.99, budget: false });
    expect(r.data!.fee).toEqual({ amount: 2.99, currency: 'USD' });
    // Balance: the amount sent and the fee, unconverted.
    expect(r.data!.from.balance).toBeCloseTo(us - 100 - 2.99, 8);
    const after = monthCalc(await loadState(db, F), '2026-10');
    expect(after.txCount).toBe(before.txCount + 1);
    expect(after.varSpent - before.varSpent).toBeCloseTo(2.99 * 58.76, 8);
    expect(after.avail - before.avail).toBeCloseTo(-2.99 * 58.76, 8);

    const summary = await call(env, 'month_summary');
    expect(summary.text).toContain('Transactions: 8 (11,020.69 DOP) · of them, transfer fees (category Other): Remitly 2026-10-07 2.99 USD from US account');
    expect(summary.data!.transferFees).toEqual([
      expect.objectContaining({ transferId: r.data!.transfer.id, via: 'Remitly', accountId: 'us', amount: 2.99, currency: 'USD', category: 'Other' }),
    ]);
    expect(summary.data!.categories).toContainEqual({ name: 'Other', value: expect.closeTo(2.99 * 58.76, 8) });
    expect(await fails(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, fee: -1 })).toBe(
      'Invalid data: fee: cannot be negative',
    );
  });

  it('add_transfer with move_budget: the month budget moves from the origin account to the destination account, and month_summary reports it', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 100, rate: 59, move_budget: true });
    expect(r.isError).toBe(false);
    // −100 USD (5,876 DOP at the month rate) and +5,900 DOP: the total only changes by the rate difference.
    expect(r.text).toContain(
      "Budget of October 2026 moved: 100.00 USD less in US account, 5,900.00 DOP more in DR account; the month's budget is now 70,024.00 DOP.",
    );
    expect(r.data!.transfer).toMatchObject({ amount: 100, rate: 59, budget: true, fee: 0 });
    expect(r.data!.month).toEqual({ key: '2026-10', label: 'October 2026', currency: 'DOP', budget: 70024 });
    // It is not written to the budget log: the calculation does it.
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(2);
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(70024);

    const summary = await call(env, 'month_summary');
    expect(summary.text.split('\n')[2]).toBe(
      'Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair); 2026-10-07 transfer US account -100.00 USD (Remitly); 2026-10-07 transfer DR account +5,900.00 DOP (Remitly)',
    );
    expect(summary.data!.budgetHistory.slice(-2)).toMatchObject([
      { kind: 'transfer', side: 'out', id: r.data!.transfer.id, accountId: 'us', amount: -100, currency: 'USD', total: 64124 },
      { kind: 'transfer', side: 'in', id: r.data!.transfer.id, accountId: 'dr', amount: 5900, currency: 'DOP', total: 70024 },
    ]);
    expect(summary.data!.budgetParts).toEqual([
      { accountId: 'us', name: 'US account', currency: 'USD', amount: -100, fromLog: 0, fromIncomes: 0, fromTransfers: -100, inMain: -5876 },
      { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: 75900, fromLog: 70000, fromIncomes: 0, fromTransfers: 5900, inMain: 75900 },
    ]);
    // The former name is still accepted, with the same meaning; if both come, move_budget wins.
    const old = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, add_to_budget: true });
    expect(old.data!.transfer.budget).toBe(true);
    const both = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, move_budget: false, add_to_budget: true });
    expect(both.data!.transfer.budget).toBe(false);
    expect(await fails(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, add_to_budget: 'yes' })).toBe(
      'Invalid data: add_to_budget: must be true or false',
    );
  });

  it('add_income with add_to_budget in another currency: the budget goes up by what it is worth in the account currency, at the rate of its date', async () => {
    const { env, db } = await seeded();
    // 100 USD into the DR account on the 7th: 5,876 DOP.
    const r = await call(env, 'add_income', { amount: 100, currency: 'USD', account: 'DR account', description: 'Gig', add_to_budget: true });
    expect(r.text).toContain('Gig · 100.00 USD (5,876.00 DOP) · into DR account (5,876.00 DOP)');
    expect(r.text).toContain('It was also added to the budget of October 2026, now 75,876.00 DOP.');
    // 60 is typed from the 8th on: what is dated the 7th does not change.
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBeCloseTo(75876, 8);
  });

  it('add_income with add_to_budget in a month that does not exist yet: it stays marked and says so', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 1000, date: '2026-11-02', add_to_budget: true });
    expect(r.text).toContain('It is marked to raise the budget of November 2026, a month that does not exist yet: it will count when the month is created.');
    expect(r.data!.month).toMatchObject({ key: '2026-11', budget: null });
    expect(await getMonth(db, F, '2026-11')).toBeNull();
  });

  it('month_summary tells the budget history: initial, adjustments, leftover and incomes, by date', async () => {
    const { env, db } = await seeded();
    await addBudgetEntry(db, F, '2026-10', { accountId: 'dr', amount: -1200, date: '2026-10-06', note: 'Less eating out' }, NOW);
    await addLeftover(db, F, '2026-10', NOW);
    await call(env, 'add_income', { amount: 100, currency: 'USD', account: 'DR account', description: 'Gig', date: '2026-10-03', add_to_budget: true });

    const r = await call(env, 'month_summary');
    const lines = r.text.split('\n');
    // 65,000 + 5,876 + 5,000 − 1,200 + 3,363.46 (what was left over in September).
    expect(lines[1]).toBe('Budget: 78,039.46 DOP (1,328.11 USD) · by account: DR account 78,039.46 DOP');
    expect(lines[2]).toBe(
      'Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-03 income DR account +5,876.00 DOP (Gig); 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair); 2026-10-06 adjustment DR account -1,200.00 DOP (Less eating out); 2026-10-07 leftover DR account +3,363.46 DOP',
    );
    // Once added, the leftover is not offered again.
    expect(r.text).not.toContain('Leftover of');
    expect(lines[3]).toBe(
      'Budget summary: initial 65,000.00 DOP · leftover from the previous month +3,363.46 DOP · incomes added to the budget +5,876.00 DOP · added on 2026-10-05 (Car repair) to DR account +5,000.00 DOP · reduced on 2026-10-06 (Less eating out) in DR account -1,200.00 DOP · total budget 78,039.46 DOP · spent 49,149.71 DOP · remaining 28,889.75 DOP',
    );
    expect(lines[4]).toBe('Used so far: 49,149.71 DOP (836.45 USD)');
    expect(r.data!.budgetSummary).toMatchObject({ initial: 65000, added: 5000, reduced: -1200, incomes: 5876, total: r.data!.budget, spent: 49149.71 });
    expect(r.data!.leftover).toMatchObject({ previousMonth: '2026-09', added: true });
    expect(r.data!.budgetHistory.map((h: { kind: string; total: number }) => [h.kind, Math.round(h.total * 100) / 100])).toEqual([
      ['initial', 65000],
      ['income', 70876],
      ['adjust', 75876],
      ['adjust', 74676],
      ['leftover', 78039.46],
    ]);
    expect(r.data!.budgetParts).toEqual([
      { accountId: 'dr', name: 'DR account', currency: 'DOP', amount: expect.closeTo(78039.46, 2), fromLog: expect.closeTo(72163.46, 2), fromIncomes: 5876, fromTransfers: 0, inMain: expect.closeTo(78039.46, 2) },
    ]);
    expect(r.data!.budget).toBe(monthCalc(await loadState(db, F), '2026-10').budget);
  });

  it('month_summary: the first month has no leftover to offer; a negative one is reported as negative', async () => {
    const { env, db } = await seeded();
    const august = await call(env, 'month_summary', { month: '2026-08' });
    expect(august.text).not.toContain('Leftover');
    expect(august.data!.leftover).toEqual({ previousMonth: null, amount: null, added: false });
    expect(august.text).toContain('Budget history: 2026-08-01 initial DR account +70,000.00 DOP');

    // An expense of 30,000 in October leaves it at −9,149.71 available: that is what November inherits.
    await call(env, 'add_transaction', { description: 'Roof', amount: 30000 });
    await call(env, 'add_transaction', { description: 'Regalo', amount: 10, date: '2026-11-02' });
    const november = await call(env, 'month_summary', { month: '2026-11' });
    expect(november.text).toContain("Leftover of October 2026: -9,149.71 DOP, not added to this month's budget.");
    expect((await getMonth(db, F, '2026-11'))!.budgets).toEqual({ dr: 70000 });
  });

  it('month_summary: rates carry their date, and each amount uses the rate in effect on its own date', async () => {
    const { env, db } = await seeded();
    // 10 USD paid from the DOP account on the 2nd (at 58.76); on the 8th, 60 is typed.
    await call(env, 'add_transaction', { description: 'Domain', amount: 10, currency: 'USD', date: '2026-10-02' });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    const r = await call(env, 'month_summary', {}, new Date('2026-10-08T16:00:00Z'));
    expect(r.text).toContain('Month rates: USD to DOP: 60.00 (typed on 2026-10-08)');
    expect(r.text).toContain('Rates typed in October 2026: 1 USD = 58.76 DOP from 2026-10-01; 1 USD = 58.76 DOP from 2026-10-06; 1 USD = 60.00 DOP from 2026-10-08');
    expect(r.data!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-08', note: 'typed on 2026-10-08' }]);
    // The transaction of the 2nd is still worth 587.60; the fixed expense in USD (of the whole month) already uses 60.
    expect(r.text).toContain('Transactions: 8 (11,432.60 DOP)');
    expect(r.data!.fixed.paid).toBeCloseTo(32076.15 + 106 * 60, 6);
    const list = await call(env, 'list_transactions', { limit: 20 });
    expect(list.text).toContain('2026-10-02 · Domain · 10.00 USD (587.60 DOP) · Food · Debit card · DR account');
    // One dated the 8th is recorded at 60 and says so.
    const today = await call(env, 'add_transaction', { description: 'Hosting', amount: 10, currency: 'USD' }, new Date('2026-10-08T16:00:00Z'));
    expect(today.text).toContain('Hosting · 10.00 USD (600.00 DOP) · Food · Debit card · 2026-10-08 (October 2026) · paid from DR account (600.00 DOP)');
  });
});

describe('list_accounts', () => {
  it('lists the visible accounts with their currency and balance, which one is the default and the total in both currencies', async () => {
    const { env, db, sqlite } = await seeded();
    const r = await call(env, 'list_accounts');
    expect(r.isError).toBe(false);
    expect(r.text.split('\n')).toEqual([
      'Frank · 2 accounts · main currency DOP, second currency USD',
      'US account · USD · balance 13,482.00 USD (792,202.32 DOP)',
      'DR account · DOP · balance 220,641.93 DOP · default account',
      'Total money: 1,012,844.25 DOP (17,236.97 USD)',
      'Rates used (October 2026): USD to DOP: 58.76 (typed on 2026-10-06)',
      'Today is 2026-10-07.',
    ]);

    // The figures are the ones from shared/calc.ts.
    const b = balances(await loadState(db, F), '2026-10');
    expect(r.data).toEqual({
      user: FRANK,
      today: '2026-10-07',
      asOf: '2026-10',
      mainCurrency: 'DOP',
      secondCurrency: 'USD',
      defaultAccountId: 'dr',
      accounts: [
        { id: 'us', name: 'US account', currency: 'USD', balance: b.accounts[0]!.balance, inMain: b.accounts[0]!.inMain, inSecond: b.accounts[0]!.inSecond, isDefault: false },
        { id: 'dr', name: 'DR account', currency: 'DOP', balance: b.accounts[1]!.balance, inMain: b.accounts[1]!.inMain, inSecond: b.accounts[1]!.inSecond, isDefault: true },
      ],
      totalMoney: { main: b.totalMain, second: b.totalSecond },
      gold: { price: null, excludedFromTotal: false },
      hiddenCount: 0,
      rates: [{ from: 'USD', to: 'DOP', rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-06', note: 'typed on 2026-10-06' }],
    });
    // It is read-only.
    expect(await loadState(db, F)).toEqual(await loadState(db, E));
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('the balances follow each record: expense, income, transfer and paid fixed expense', async () => {
    const { env, db } = await seeded();
    const balancesOf = async () => Object.fromEntries(((await call(env, 'list_accounts')).data!.accounts as { id: string; balance: number }[]).map((a) => [a.id, a.balance]));

    await call(env, 'add_transaction', { description: 'Uber', amount: 850 });
    await call(env, 'add_income', { amount: 1000, account: 'us' });
    await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 60 });
    await call(env, 'mark_fixed_paid', { name: 'Netflix' });
    const after = await balancesOf();
    expect(after.us).toBeCloseTo(13482 + 1000 - 100, 8);
    expect(after.dr).toBeCloseTo(220641.93 - 850 + 6000 - 1137.3, 6);
    expect(after).toEqual({ us: await balanceOf(db, 'us'), dr: await balanceOf(db, 'dr') });

    // What is dated in the next month already counts: the balance is the current one.
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    const next = await call(env, 'list_accounts');
    expect(next.data).toMatchObject({ asOf: '2026-11' });
    expect(next.data!.accounts[1].balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
    expect(next.text).toContain('Rates used (November 2026): USD to DOP: 58.76 (typed on 2026-10-06, still in effect)');
  });

  it('accounts in three currencies, the default one the user chose, and the hidden ones out of the list and the total', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'Türkiye hesabı', currency: 'TRY', opening: 8400 });
    await createAccount(db, F, { id: 'vieja', name: 'Cuenta vieja', currency: 'DOP', opening: 999 });
    await patchAccount(db, F, 'vieja', { hidden: true });
    await updateSettings(db, F, { defaultAccountId: 'us' });

    const r = await call(env, 'list_accounts');
    expect(r.text.split('\n')).toEqual([
      'Frank · 3 accounts · main currency DOP, second currency USD',
      'US account · USD · balance 13,482.00 USD (792,202.32 DOP) · default account',
      'DR account · DOP · balance 220,641.93 DOP',
      // 8,400 TRY ÷ 42 × 58.76, with the default rate: the warning goes on the rates line.
      'Türkiye hesabı · TRY · balance 8,400.00 TRY (11,752.00 DOP)',
      'Total money: 1,024,596.25 DOP (17,436.97 USD)',
      'Hidden accounts, not listed and not counted in the total: 1.',
      'Rates used (October 2026): USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.40 (default value, not set yet)',
      'Today is 2026-10-07.',
    ]);
    expect(r.data).toMatchObject({ defaultAccountId: 'us', hiddenCount: 1 });
    expect(r.data!.accounts.map((a: { id: string; isDefault: boolean }) => [a.id, a.isDefault])).toEqual([
      ['us', true],
      ['dr', false],
      ['tr', false],
    ]);

    // If the default account is hidden, it becomes the first visible one in the main currency.
    await patchAccount(db, F, 'us', { hidden: true });
    const hidden = await call(env, 'list_accounts');
    expect(hidden.text).toContain('DR account · DOP · balance 220,641.93 DOP · default account');
    expect(hidden.data).toMatchObject({ defaultAccountId: 'dr', hiddenCount: 2 });
  });

  it('the total is in the main currency and the second currency of each user', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'TRY' });
    const b = balances(await loadState(db, F), '2026-10');
    const r = await call(env, 'list_accounts');
    expect(r.text.split('\n')).toEqual([
      'Frank · 2 accounts · main currency USD, second currency TRY',
      // With dollars as the main currency, the default account becomes the first one in dollars… unless one has been chosen.
      'US account · USD · balance 13,482.00 USD',
      'DR account · DOP · balance 220,641.93 DOP (3,754.97 USD) · default account',
      `Total money: 17,236.97 USD (${f2(b.totalSecond!)} TRY)`,
      'Rates used (October 2026): USD to DOP: 58.76 (typed on 2026-10-06); USD to TRY: 42.00 (default value, not set yet)',
      'Today is 2026-10-07.',
    ]);
    expect(b.totalSecond).toBeCloseTo(17236.968 * 42, 0);
    expect(r.data).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY', totalMoney: { main: b.totalMain, second: b.totalSecond } });
  });

  it('without a second currency no figures appear in it: neither in parentheses nor in the data', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { secondCurrency: null });
    const accounts = await call(env, 'list_accounts');
    expect(accounts.text.split('\n')[0]).toBe('Frank · 2 accounts · main currency DOP, no second currency');
    expect(accounts.text).toMatch(/\nTotal money: [\d,.]+ DOP\n/);
    expect(accounts.data).toMatchObject({ mainCurrency: 'DOP', secondCurrency: null });
    expect(accounts.data!.totalMoney).not.toHaveProperty('second');
    expect(accounts.data!.accounts[0]).not.toHaveProperty('inSecond');

    const summary = await call(env, 'month_summary');
    expect(summary.text).toMatch(/\nUsed so far: [\d,.]+ DOP\n/);
    expect(summary.text).not.toContain('USD)');
    expect(summary.data).toMatchObject({ currency: 'DOP', secondCurrency: null });
    for (const key of ['budgetSecond', 'usedSecond']) expect(summary.data).not.toHaveProperty(key);
    expect(summary.data!.totalMoney).not.toHaveProperty('second');
  });

  it('someone who never opened the web app sees their initial accounts, at zero, without any month being created', async () => {
    const { env, sqlite } = makeEnv();
    const r = await callRaw(env, 'list_accounts', { user: E });
    expect(r.text.split('\n')).toEqual([
      'Eda · 2 accounts · main currency DOP, second currency USD',
      'US account · USD · balance 0.00 USD (0.00 DOP)',
      'DR account · DOP · balance 0.00 DOP · default account',
      'Total money: 0.00 DOP (0.00 USD)',
      'Rates used (October 2026): USD to DOP: 58.76 (default value, not set yet)',
      'Today is 2026-10-07.',
    ]);
    expect(count(sqlite, 'accounts', E)).toBe(2);
    expect(count(sqlite, 'accounts', F)).toBe(0);
    expect(count(sqlite, 'months')).toBe(0);
    // Repeating it duplicates nothing.
    await callRaw(env, 'list_accounts', { user: E });
    expect(count(sqlite, 'accounts', E)).toBe(2);
  });

  it('accepts no arguments of its own', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'list_accounts', { month: '2026-10' })).toContain('month');
    expect(await fails(env, 'list_accounts', { account: 'us' })).toContain('Invalid data');
  });
});

describe('add_outside_expense', () => {
  it('is subtracted from the account like an expense, does not count toward used, and month_summary counts it separately', async () => {
    const { env, db } = await seeded();
    const used = (await call(env, 'month_summary')).data!.used;
    const before = await balanceOf(db, 'dr');
    const r = await call(env, 'add_outside_expense', { name: 'Car repair', amount: 4500, description: 'radiator' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Recorded outside the budget for Frank: Car repair · radiator · 4,500.00 DOP · 2026-10-07 (October 2026) · paid from DR account. Used so far is unchanged by it: 49,149.71 DOP. DR account balance: 216,141.93 DOP. Outside budget in October 2026: 1 (4,500.00 DOP).',
    );
    expect(r.data!.outsideExpense).toEqual({ id: expect.any(String), monthKey: '2026-10', date: '2026-10-07', name: 'Car repair', desc: 'radiator', accountId: 'dr', amount: 4500, cur: 'DOP' });
    expect(await balanceOf(db, 'dr')).toBeCloseTo(before - 4500, 8);

    const summary = await call(env, 'month_summary');
    expect(summary.data!.used).toBe(used);
    expect(summary.data!.transactions.count).toBe(7);
    expect(summary.data!.outsideBudget).toMatchObject({ count: 1, total: 4500 });
    expect(summary.text).toContain('Outside budget: 1 (4,500.00 DOP) · not part of used or available, but already subtracted from the account balances: Car repair 4,500.00 DOP');
  });

  it('in another currency and another account; rejects gold and a closed month', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_outside_expense', { name: 'Gift', amount: 20, account: 'US account' });
    expect(r.data!.outsideExpense).toMatchObject({ accountId: 'us', cur: 'USD' });
    expect(await balanceOf(db, 'us')).toBeCloseTo(13482 - 20, 6);
    await createAccount(db, F, { id: 'gold', name: 'Gold', currency: 'XAU', opening: 10 });
    expect(await fails(env, 'add_outside_expense', { name: 'Coin', amount: 1, account: 'Gold' })).toContain('is a gold account');
    expect(await fails(env, 'add_outside_expense', { name: 'Old', amount: 1, date: '2026-09-10' })).toContain('closed');
    expect(await fails(env, 'add_outside_expense', { name: 'x', amount: 0 })).toContain('greater than 0');
  });
});

describe('credit card', () => {
  it('a purchase with "Credit card" is charged to the credit card and pay_credit_card pays it (in part) from the account', async () => {
    const { env, db } = await seeded();
    await createCard(db, F, { id: 'card', name: 'Credit card' });
    const before = await balanceOf(db, 'dr');
    const bought = await call(env, 'add_transaction', { description: 'Taxi', amount: 800, method: 'Credit card', category: 'Transport' });
    expect(bought.text).toContain('charged to the credit card');
    expect(bought.data!.account).toBeNull();
    expect(await balanceOf(db, 'dr')).toBe(before);

    const summary = await call(env, 'month_summary');
    expect(summary.data!.creditCards[0]).toMatchObject({ total: 800, previous: 0, other: 0, charged: 800, paid: 0, payments: [], remainder: 800 });
    expect(summary.text).toContain('Credit card "Credit card": total 800.00 DOP');

    expect(await fails(env, 'pay_credit_card', { amount: 800.5 })).toContain('cannot be paid for more than that');
    const paid = await call(env, 'pay_credit_card', { amount: 300 });
    expect(paid.data!.creditCard).toMatchObject({ total: 800, paid: 300, payments: [{ accountId: 'dr', amount: 300 }], remainder: 500 });
    expect(paid.data!.account.balance).toBeCloseTo(before - 300, 8);
    expect(await balanceOf(db, 'dr')).toBeCloseTo(before - 300, 8);
    expect(paid.text).toContain('left to pay: 500.00 DOP');
    // Repeating with another account ADDS a second payment: the first one is kept.
    const again = await call(env, 'pay_credit_card', { amount: 100, account: 'US account' });
    expect(again.data!.creditCard).toMatchObject({ paid: 400, remainder: 400, payments: [{ accountId: 'dr', amount: 300 }, { accountId: 'us', amount: 100 }] });
    expect(await balanceOf(db, 'dr')).toBeCloseTo(before - 300, 8);
    const after = await call(env, 'month_summary');
    expect(after.text).toContain('paid 400.00 DOP in 2 payments');
    expect(after.text).toContain('left to pay 400.00 DOP');
    // Paying more than what is left is rejected.
    expect(await fails(env, 'pay_credit_card', { amount: 400.5 })).toContain('cannot be paid for more than that');
  });

  it('with several credit cards: add_transaction and pay_credit_card name their own, and list_credit_cards and month_summary say how much to pay', async () => {
    const { env, db } = await seeded();
    expect(await fails(env, 'pay_credit_card', { amount: 1 })).toContain('no active credit card');
    const visa = await createCard(db, F, { name: 'Visa', bank: 'Popular', last4: '4242', limit: 60000, cutoffDay: 13 });
    const usd = await createCard(db, F, { name: 'Dollars', cur: 'USD' });
    await setCardOther(db, F, '2026-10', visa.id, 12000);

    const bought = await call(env, 'add_transaction', { description: 'Hotel', amount: 20, currency: 'USD', method: 'Credit card', card: 'dollars' });
    expect(bought.text).toContain('charged to the credit card Dollars');
    expect(bought.data!.transaction.cardId).toBe(usd.id);
    const plain = await call(env, 'add_transaction', { description: 'Taxi', amount: 100, method: 'Credit card' });
    expect(plain.data!.transaction.cardId).toBe(visa.id);
    expect(await fails(env, 'add_transaction', { description: 'x', amount: 1, method: 'Credit card', card: 'amex' })).toContain('unknown credit card "amex"');

    const listed = await call(env, 'list_credit_cards');
    expect(listed.text).toContain('Visa (Popular ****4242) · DOP · on · owed 12,100.00 DOP · limit 60,000.00 DOP · 20.2% used · cutoff day 13 · due day unknown');
    expect(listed.text).toContain('to end the cutoff under 10% pay at least 6,100.01 DOP before 2026-10-13 (in 6 days)');
    expect(listed.data!.cards.map((c: { name: string; owed: number }) => [c.name, c.owed])).toEqual([['Visa', 12100], ['Dollars', 20]]);
    expect(listed.data!.cards[0].hint).toMatchObject({ payToUnder10: 6100.01, nextCutoff: '2026-10-13', daysToCutoff: 6 });

    const summary = await call(env, 'month_summary');
    expect(summary.data!.creditCards.map((c: { name: string }) => c.name)).toEqual(['Visa', 'Dollars']);
    expect(summary.data!.creditCards[0]).toMatchObject({ remainder: 12100, limit: 60000, hint: { payToUnder10: 6100.01 } });
    expect(summary.text).toContain('Credit card "Dollars": total 20.00 USD');

    // With no name, the first active one; with a name, that one; it cannot exceed what is owed on that credit card.
    expect(await fails(env, 'pay_credit_card', { amount: 21, card: 'Dollars' })).toContain('Dollars has 20.00 left to pay');
    const paid = await call(env, 'pay_credit_card', { amount: 100 });
    expect(paid.data!.creditCard).toMatchObject({ name: 'Visa', paid: 100, remainder: 12000 });
    const paidUsd = await call(env, 'pay_credit_card', { amount: 5, card: 'Dollars', account: 'US account' });
    expect(paidUsd.data!.creditCard).toMatchObject({ name: 'Dollars', currency: 'USD', remainder: 15 });
    expect(paidUsd.text).toContain('Paid 5.00 USD of Dollars');
  });

  it('list_transactions marks Credit-card purchases as paid or unpaid and month_summary counts the unpaid ones', async () => {
    const { env, db } = await seeded();
    const visa = await createCard(db, F, { name: 'Visa' });
    const taxi = await call(env, 'add_transaction', { description: 'Taxi', amount: 100, method: 'Credit card' });
    await call(env, 'add_transaction', { description: 'Lunch', amount: 50, method: 'Credit card' });
    await call(env, 'add_transaction', { description: 'Coffee', amount: 5 });
    await payCardPurchases(db, F, '2026-10', visa.id, { transactionIds: [taxi.data!.transaction.id], accountId: 'dr' }, NOW);

    const listed = await call(env, 'list_transactions', { limit: 50 });
    const row = (desc: string) => listed.data!.transactions.find((t: { desc: string }) => t.desc === desc);
    expect(row('Taxi')).toMatchObject({ settled: true, paidOn: '2026-10-07' });
    expect(row('Lunch')).toMatchObject({ settled: false, paidOn: null });
    expect(row('Coffee')).not.toHaveProperty('settled');
    expect(listed.text).toMatch(/Taxi.*Credit card · paid on 2026-10-07/);
    expect(listed.text).toMatch(/Lunch.*Credit card · unpaid/);

    const summary = await call(env, 'month_summary');
    expect(summary.data!.creditCards[0].unsettledPurchases).toEqual({ count: 1, total: 50 });
    expect(summary.text).toContain('1 unpaid purchase (50.00 DOP) not covered by any payment yet');
  });

  it('mark_fixed_paid with on_card charges the expense to the credit card without touching any account', async () => {
    const { env, db } = await seeded();
    await createCard(db, F, { id: 'card', name: 'Credit card' });
    const before = await balanceOf(db, 'dr');
    const r = await call(env, 'mark_fixed_paid', { name: 'Netflix', on_card: true });
    expect(r.data!.fixed).toMatchObject({ name: 'Netflix', paid: true, onCard: true });
    expect(r.text).toContain('charged to the credit card');
    expect(r.data!.account).toBeNull();
    expect(await balanceOf(db, 'dr')).toBe(before);
    expect((await call(env, 'month_summary')).data!.creditCards[0].total).toBeCloseTo(1137.3, 6);
  });
});

describe('add_budget_extra', () => {
  it('records a dated addition on top of the initial budget and reports the new total', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_budget_extra', { amount: 5000, note: ' Medical expense ' });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Extra budget recorded for Frank: +5,000.00 DOP from DR account (Medical expense) on 2026-10-07 (October 2026). Budget summary of October 2026: initial 65,000.00 DOP · added on 2026-10-05 (Car repair) to DR account +5,000.00 DOP · added on 2026-10-07 (Medical expense) to DR account +5,000.00 DOP · total budget 75,000.00 DOP · spent 49,149.71 DOP · remaining 25,850.29 DOP.',
    );
    expect(r.data).toMatchObject({
      entry: { accountId: 'dr', amount: 5000, currency: 'DOP', date: '2026-10-07', note: 'Medical expense' },
      month: { key: '2026-10' },
      budgetSummary: { initial: 65000, added: 10000, total: 75000, additionDates: ['2026-10-05', '2026-10-07'] },
    });
    const month = (await getMonth(db, F, '2026-10'))!;
    expect(month.budgetLog.at(-1)).toMatchObject({ kind: 'adjust', amount: 5000, date: '2026-10-07', note: 'Medical expense' });
    expect(month.budgets).toEqual({ dr: 75000 });
  });

  it('takes the account and the date from the person; the amount is in the account currency', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_budget_extra', { amount: 50, account: 'US account', date: '2026-10-03' });
    expect(r.data!.entry).toMatchObject({ accountId: 'us', amount: 50, currency: 'USD', date: '2026-10-03' });
    // 50 USD x 58.76 on top of 70,000 DOP.
    expect(r.data!.budgetSummary.total).toBeCloseTo(70000 + 2938, 6);
  });

  it('rejects an amount of 0 or less, a gold account, a closed month and a date in another month that does not exist', async () => {
    const { env, db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    expect(await fails(env, 'add_budget_extra', { amount: 0 })).toContain('amount');
    expect(await fails(env, 'add_budget_extra', { amount: -5 })).toContain('amount');
    expect(await fails(env, 'add_budget_extra', { amount: 5, date: '2026-08-10' })).toContain('closed');
    expect(await fails(env, 'add_budget_extra', { amount: 5, date: '2031-01-10' })).toContain('2031');
    expect(await getMonth(db, F, '2026-10')).toEqual(before);
  });
});

describe('add_budget_extra with an income', () => {
  it('links the extra to an income of the same account, matched by description', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_budget_extra', { amount: 100, account: 'US account', income: 'salary' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('income "Salary"');
    expect(r.data!.entry).toMatchObject({ incomeId: 'seed-in-3', income: 'Salary' });
    expect(r.data!.budgetSummary.additions.at(-1)).toMatchObject({ incomeId: 'seed-in-3', income: 'Salary' });
    expect((await getMonth(db, F, '2026-10'))!.budgetLog.at(-1)).toMatchObject({ amount: 100, incomeId: 'seed-in-3' });
  });

  it('rejects an income that is not in the chosen account or does not exist, and writes nothing', async () => {
    const { env, db } = await seeded();
    const before = await getMonth(db, F, '2026-10');
    // The default account is DR; the Salary income is in the US account.
    expect(await fails(env, 'add_budget_extra', { amount: 100, income: 'Salary' })).toContain('No income');
    expect(await fails(env, 'add_budget_extra', { amount: 100, income: 'seed-in-3' })).toContain('different account');
    expect(await fails(env, 'add_budget_extra', { amount: 100, account: 'US account', income: 'Bonus' })).toContain('No income');
    expect(await getMonth(db, F, '2026-10')).toEqual(before);
  });
});
