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
  createFixed,
  getMonth,
  listIncomes,
  loadState,
  patchAccount,
  patchMonth,
  replaceAll,
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
/** Mediodía del 7 de octubre de 2026 en Santo Domingo: el mes en curso de los datos de ejemplo. */
const NOW = new Date('2026-10-07T16:00:00Z');
const F = FRANK.id;
const E = EDA.id;

const TOOL_NAMES = ['add_transaction', 'list_transactions', 'month_summary', 'add_transfer', 'mark_fixed_paid', 'add_income', 'list_accounts'];
const FIXED_NAMES = 'Electricity, Internet, Health insurance, Fridge payment, Claude, Google One, iCloud+, Cluely, Smartfit, Netflix, Unicaribe';
/** Cómo nombra un error a los usuarios de las pruebas: el id que va en `user` y el nombre de cada quien. */
const BOTH = 'frank (Frank), eda (Eda)';
const ASK = 'If it is not clear whose finances are meant, ask the person; do not guess.';
const SERVER = { name: 'fe-finance', title: 'FE Finance', version: SERVER_INFO.version };
/** Restos de la versión en español: nada de lo que lee el modelo los puede traer. */
const SPANISH = /[áéíóúñ¿¡«»]/i;
/** El envío de siempre: de la cuenta en dólares a la cuenta en pesos (las dos cuentas de los datos de ejemplo). */
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
  /** El cuerpo tal cual ('' si no hay). */
  raw: string;
  /** El cuerpo como JSON, o null si no lo es. */
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
    // Sin cuerpo (202).
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

/** Llama a una herramienta con los argumentos tal cual (sin `user` si no lo traen). */
async function callRaw(env: Env, name: string, args?: Record<string, unknown>, now: Date = NOW): Promise<Called> {
  const body = await rpc(env, 'tools/call', args === undefined ? { name } : { name, arguments: args }, now);
  expect(body.error).toBeUndefined();
  const result = body.result as ToolResult;
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return { text: result.content[0]!.text, isError: result.isError === true, data: result.structuredContent };
}

/** Llama como Frank, que es quien habla en estas pruebas salvo que los argumentos digan otra cosa. */
function call(env: Env, name: string, args: Record<string, unknown> = {}, now: Date = NOW): Promise<Called> {
  return callRaw(env, name, { user: F, ...args }, now);
}

/** Una llamada (con los argumentos tal cual) que debe fallar como error de herramienta: devuelve el mensaje. */
async function failsRaw(env: Env, name: string, args?: Record<string, unknown>, now: Date = NOW): Promise<string> {
  const r = await callRaw(env, name, args, now);
  expect(r.isError, r.text).toBe(true);
  expect(r.data).toBeUndefined();
  return r.text;
}

/** Una llamada de Frank que debe fallar como error de herramienta: devuelve el mensaje. */
function fails(env: Env, name: string, args: Record<string, unknown> = {}, now: Date = NOW): Promise<string> {
  return failsRaw(env, name, { user: F, ...args }, now);
}

let bystander: { db: D1Database; before: AppState } | null = null;

/**
 * Los dos usuarios con los mismos datos de ejemplo (y por tanto los mismos ids). En las pruebas que la usan
 * solo actúa Frank: al acabar cada una se comprueba que lo de Eda sigue exactamente igual.
 */
async function seeded(): Promise<TestEnv> {
  const t = makeEnv();
  // El mismo instante para los dos: hay pruebas que comparan un estado con el otro, createdAt incluido.
  const at = new Date();
  await replaceAll(t.db, F, seedState(), at);
  await replaceAll(t.db, E, seedState(), at);
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return t;
}

/** Una base que deja de responder a las lecturas en lote en cuanto `table` tiene una fila más. */
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
 * El saldo de una cuenta según shared/calc.ts al final de `asOf`: lo que dice cada herramienta después de
 * escribir tiene que ser exactamente esto.
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

describe('/mcp: autenticación', () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  it('401 sin token, con token incorrecto o con otro esquema', async () => {
    const { env, sqlite } = await seeded();
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer otro-token' },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { Authorization: 'Bearer ' },
      { Authorization: TOKEN },
      { Authorization: `Basic ${TOKEN}` },
      // Decir quién eres no sustituye al token.
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
      // El mismo cuerpo que el resto de la API.
      expect(r.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid or missing token.' } });
    }
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('401 siempre si API_TOKEN no está configurado', async () => {
    const { db } = makeEnv();
    for (const env of [{ DB: db }, { DB: db, API_TOKEN: '' }] satisfies Env[]) {
      for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }, AUTH]) {
        const r = await post(env, ping, headers);
        expect(r.status).toBe(401);
        expect(r.headers.get('WWW-Authenticate')).toBe('Bearer');
      }
    }
  });

  it('el token se comprueba antes de mirar el cuerpo, el método o la configuración', async () => {
    const { env } = makeEnv();
    expect((await post(env, '{"jsonrpc":', {})).status).toBe(401);
    expect((await send(env, { method: 'GET' })).status).toBe(401);
    expect((await send(env, { method: 'DELETE' })).status).toBe(401);
    // Ni siquiera un USERS mal escrito se deja ver sin el token.
    expect((await post(makeEnv({ USERS: 'Frank Reyes' }).env, ping, {})).status).toBe(401);
  });

  it('con el token correcto responde (el esquema no distingue mayúsculas)', async () => {
    const { env } = makeEnv();
    for (const headers of [AUTH, { Authorization: `bearer ${TOKEN}` }]) {
      const r = await post(env, ping, headers);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    }
  });
});

describe('/mcp: transporte', () => {
  it('GET y DELETE responden 405 con Allow: POST (sin SSE ni sesiones)', async () => {
    const { env } = makeEnv();
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const r = await send(env, { method, headers: { ...AUTH, Accept: 'text/event-stream' } });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('Allow')).toBe('POST');
      expect(r.headers.get('Mcp-Session-Id')).toBeNull();
      expect(r.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    }
  });

  it('JSON mal formado: 400 con error -32700', async () => {
    const { env } = makeEnv();
    const bodies: (string | Uint8Array)[] = ['{"jsonrpc":', '', 'ping', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])];
    for (const body of bodies) {
      const r = await send(env, { method: 'POST', headers: AUTH, body });
      expect(r.status).toBe(400);
      expect(r.headers.get('Content-Type')).toBe('application/json');
      expect(r.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The request body is not valid JSON.' } });
    }
  });

  it('petición JSON-RPC inválida: 400 con error -32600 (y el id, si se pudo leer)', async () => {
    const { env } = makeEnv();
    const bad: [unknown, string | number | null][] = [
      // (post manda los textos tal cual: este es el JSON de una cadena)
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

  it('una notificación o una respuesta del cliente: 202 sin cuerpo', async () => {
    const { env } = makeEnv();
    const accepted: unknown[] = [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'x' } },
      // Sin id no hay a quién responder, ni siquiera "método no encontrado".
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

  it('un lote se atiende en orden y solo se responde a las peticiones', async () => {
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
    // El resumen ya ve la transacción que registró el mensaje anterior del mismo lote.
    expect((out[2]!.result as ToolResult).structuredContent).toMatchObject({ transactions: { count: 8, total: 11695 } });
    expect(out[3]!.error?.code).toBe(-32600);
    expect(out[4]!.error?.code).toBe(-32601);
    expect(count(sqlite, 'transactions', F)).toBe(28);

    // Lo que falle dentro de un lote va en su respuesta: el lote entero es siempre un 200.
    const mixed = await post(env, [5, { jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(mixed.status).toBe(200);
    expect((mixed.body as RpcBody[]).map((x) => x.error?.code)).toEqual([-32600, undefined]);
  });

  it('un lote vacío o demasiado largo es una petición inválida', async () => {
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

  it('413 si el cuerpo pasa del tope, lo diga Content-Length o no', async () => {
    const { env } = makeEnv();
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { relleno: 'x'.repeat(MAX_BODY_BYTES) } });
    const streamed = await post(env, big);
    expect(streamed.status).toBe(413);
    expect(streamed.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });

    const declared = await post(env, { jsonrpc: '2.0', id: 1, method: 'ping' }, { ...AUTH, 'Content-Length': String(MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);
  });

  it('MCP-Protocol-Version: 400 si no se soporta, diciendo cuáles hay; sin la cabecera no se exige', async () => {
    const { env } = makeEnv();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect((await post(env, ping, { ...AUTH, 'MCP-Protocol-Version': version })).status).toBe(200);
    }
    expect((await post(env, ping)).status).toBe(200);

    for (const requested of ['1999-01-01', '2031-01-01', 'x'.repeat(80)]) {
      const r = await post(env, ping, { ...AUTH, 'MCP-Protocol-Version': requested });
      expect(r.status).toBe(400);
      // UnsupportedProtocolVersionError: con él un cliente reintenta con una versión de la lista.
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

    // En initialize todavía no se ha negociado nada: la cabecera no cuenta.
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2031-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    expect((await post(env, init, { ...AUTH, 'MCP-Protocol-Version': '2031-01-01' })).status).toBe(200);
  });

  it('las respuestas no se guardan en caché', async () => {
    const { env } = makeEnv();
    expect((await post(env, { jsonrpc: '2.0', id: 1, method: 'ping' })).headers.get('Cache-Control')).toBe('no-store');
    expect((await post(env, { jsonrpc: '2.0', method: 'notifications/initialized' })).headers.get('Cache-Control')).toBe('no-store');
  });

  it('un USERS mal escrito es un error interno: no se atiende nada ni se filtra el motivo', async () => {
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
    // El motivo queda en el log, que es donde lo busca quien configura.
    expect(log).toHaveBeenCalledTimes(bad.length * 2);
    expect(String(log.mock.calls[0]![1])).toContain('USERS');
  });
});

describe('/mcp: initialize y métodos básicos', () => {
  const client = { capabilities: {}, clientInfo: { name: 'prueba', version: '1.0.0' } };
  const instructionsOf = async (env: Env) =>
    ((await rpc(env, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, ...client })).result as { instructions: string }).instructions;

  it('initialize describe el servidor y no abre sesión', async () => {
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

  it('la versión del servidor es la de package.json', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version: string };
    expect(SERVER_INFO.version).toBe(pkg.version);
    expect(SERVER_INFO.name).toBe('fe-finance');
  });

  it('las instrucciones explican el dominio, en inglés', async () => {
    const text = await instructionsOf(makeEnv().env);
    for (const word of [...CATS, ...METHODS, ...VIAS, TIMEZONE, 'FE Finance', 'USD', 'DOP', 'closed', 'read-only', 'confirm', 'Spanish or Turkish', 'free text']) {
      expect(text, word).toContain(word);
    }
    expect(text).not.toMatch(SPANISH);
    // La tarjeta a secas es la de débito, que además es el método por defecto.
    expect(text).toContain('Payment methods: Debit card, Credit card, Transfer, Bank app, Cash. If none is given it is Debit card.');
    expect(text).toContain('A plain "card" ("tarjeta", "kart") is stored as Debit card');
  });

  it('las instrucciones explican el modelo de dinero: cuentas, moneda principal y qué mueve cada registro', async () => {
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
    // Ya no supone que todo el mundo gana en dólares y gasta en pesos.
    expect(text).not.toContain('earn in USD');
    expect(text).not.toContain('DOP by default');
  });

  it('las instrucciones dicen que cada persona tiene sus finanzas, quiénes son y que ante la duda se pregunta', async () => {
    const text = await instructionsOf(makeEnv().env);
    for (const phrase of ['separate finances', `Configured users: ${BOTH}.`, '`user`', 'required', 'conversation', 'project instructions', 'ask before calling a tool', 'never guess']) {
      expect(text, phrase).toContain(phrase);
    }

    // La lista es la del entorno de cada petición, no una fija.
    const three = await instructionsOf(makeEnv({ USERS: 'frank:Frank,eda:Eda,leo' }).env);
    expect(three).toContain('Configured users: frank (Frank), eda (Eda), leo (Leo).');

    // Con un solo usuario no hay a quién confundir: lo nombra y dice que `user` se puede omitir.
    const single = await instructionsOf(makeEnv({ USERS: 'ana:Ana María' }).env);
    expect(single).toContain('only one user is configured, ana (Ana María)');
    expect(single).toContain('can be omitted');
    expect(single).not.toContain('frank');
    expect(await instructionsOf(makeEnv({ USERS: undefined }).env)).toContain('only one user is configured, me (Me)');
  });

  it('negocia la versión: la del cliente si se soporta; si no, la más nueva de las que usan handshake', async () => {
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
    // Las versiones sin handshake no se pueden acordar con initialize.
    for (const version of ['2031-01-01', '2024-10-07', '1.0', '', ...MODERN_PROTOCOL_VERSIONS]) {
      expect((await negotiate(version)).protocolVersion, version).toBe(latestWithHandshake);
    }
  });

  it('initialize sin protocolVersion: -32602', async () => {
    const { env } = makeEnv();
    for (const params of [undefined, {}, { protocolVersion: 20250618 }, client]) {
      expect((await rpc(env, 'initialize', params)).error?.code).toBe(-32602);
    }
  });

  it('ping responde un resultado vacío', async () => {
    const { env } = makeEnv();
    expect((await rpc(env, 'ping')).result).toEqual({});
    expect((await rpc(env, 'ping', {})).result).toEqual({});
  });

  it('método desconocido: -32601; params que no son un objeto: -32602', async () => {
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

describe('/mcp: protocolo sin handshake (2026-07-28)', () => {
  const MODERN = '2026-07-28';
  const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
  const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
  const META = { [VERSION_KEY]: MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'prueba', version: '1.0.0' }, [CAPABILITIES_KEY]: {} };
  const SERVER_META = { 'io.modelcontextprotocol/serverInfo': SERVER };

  interface Options {
    /** Cabeceras que cambian respecto a las correctas; null quita una. */
    headers?: Record<string, string | null>;
    /** `_meta` de la petición; null lo quita. */
    meta?: Record<string, unknown> | null;
    now?: Date;
  }

  /** Una petición bien formada de un cliente 2026-07-28, salvo lo que cambie `options`. */
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

  it('server/discover describe el servidor: versiones, capacidades, identidad e instrucciones', async () => {
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
    // Las mismas instrucciones que da initialize, con los usuarios configurados.
    const legacy = (await rpc(env, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result;
    expect(result(r).instructions).toBe((legacy as { instructions: string }).instructions);
    expect(result(r).instructions).toContain(BOTH);
    expect(result(await modern(makeEnv({ USERS: 'ana:Ana' }).env, 'server/discover')).instructions).toContain('ana (Ana)');
  });

  it('tools/list lleva las mismas herramientas, con resultType y pistas de caché', async () => {
    const { env } = makeEnv();
    const r = await modern(env, 'tools/list');
    expect(r.status).toBe(200);
    const legacy = (await rpc(env, 'tools/list')).result as { tools: unknown[] };
    expect(result(r)).toEqual({ resultType: 'complete', tools: legacy.tools, ttlMs: 300000, cacheScope: 'public', _meta: SERVER_META });
    expect(result(r).tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES);
    expect(result(r).tools[0].inputSchema.properties.user.enum).toEqual([F, E]);
    // Con handshake el resultado no cambia de forma.
    expect(Object.keys(legacy)).toEqual(['tools']);
  });

  it('tools/call registra el gasto y responde con resultType', async () => {
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

  it('un error de la herramienta sigue siendo un resultado (200, isError)', async () => {
    const { env } = await seeded();
    const r = await modern(env, 'tools/call', { name: 'add_transaction', arguments: { user: F, description: 'Tarde', amount: 1, date: '2026-08-15' } });
    expect(r.status).toBe(200);
    expect(result(r)).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'August 2026 is closed: it is read-only. Reopen it to make changes.' }],
      isError: true,
      _meta: SERVER_META,
    });

    // También cuando falta decir de quién es.
    const nobody = await modern(env, 'tools/call', { name: 'add_transaction', arguments: { description: 'Uber', amount: 850 } });
    expect(nobody.status).toBe(200);
    expect(result(nobody)).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: `Invalid data: user: is required. Valid users: ${BOTH}. ${ASK}` }],
      isError: true,
      _meta: SERVER_META,
    });
  });

  it('herramienta desconocida: -32602; fallo inesperado: -32603 sin detalles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env } = makeEnv();
    const unknown = await modern(env, 'tools/call', { name: 'borrar_todo' });
    expect(unknown.status).toBe(200);
    expect(error(unknown).code).toBe(-32602);

    const broken = { ...env, DB: { prepare: () => { throw new Error('SQLITE_SECRETO'); }, batch: () => { throw new Error('SQLITE_SECRETO'); } } as unknown as D1Database };
    const failed = await modern(broken, 'tools/call', summary);
    expect(failed.body).toEqual({ jsonrpc: '2.0', id: 'm1', error: { code: -32603, message: INTERNAL_MESSAGE } });
  });

  it('Mcp-Name admite el valor codificado en base64', async () => {
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

  it('cabeceras que no coinciden con el cuerpo: 400 HeaderMismatch, sin ejecutar nada', async () => {
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

  it('falta un campo obligatorio de `_meta`: 400 con -32602', async () => {
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

  it('la versión declarada en `_meta` tiene que venir también en la cabecera', async () => {
    const { env } = makeEnv();
    for (const headers of [{ 'MCP-Protocol-Version': null }, { 'MCP-Protocol-Version': '2025-11-25' }]) {
      const r = await modern(env, 'tools/list', {}, { headers });
      expect(r.status).toBe(400);
      expect(error(r).code).toBe(-32020);
    }
    // Un cliente con handshake no declara nada en `_meta`: su progressToken y demás no molestan.
    const legacy = await rpc(env, 'tools/list', { _meta: { progressToken: 7 } });
    expect(legacy.error).toBeUndefined();
  });

  it('un método que no existe en esta versión: 404 con -32601', async () => {
    const { env } = makeEnv();
    for (const method of ['ping', 'resources/list', 'subscriptions/listen', 'no/existe']) {
      const r = await modern(env, method);
      expect(r.status, method).toBe(404);
      expect(r.body).toEqual({ jsonrpc: '2.0', id: 'm1', error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });

  it('initialize sigue siendo el handshake de las versiones anteriores, diga lo que diga la cabecera', async () => {
    const { env } = makeEnv();
    const r = await modern(env, 'initialize', { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(r.status).toBe(200);
    expect(result(r)).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'fe-finance' } });
    expect(result(r).resultType).toBeUndefined();
  });

  it('no admite lotes; una notificación se acepta con 202', async () => {
    const { env } = makeEnv();
    const headers = { ...AUTH, 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' };
    const batch = await post(env, [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }], headers);
    expect(batch.status).toBe(400);
    expect(batch.body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });

    const notification = await post(env, { jsonrpc: '2.0', method: 'notifications/cancelled' }, { ...AUTH, 'MCP-Protocol-Version': MODERN });
    expect(notification.status).toBe(202);
    expect(notification.raw).toBe('');
  });

  it('"hoy" y el resto de las reglas son las mismas en las dos épocas', async () => {
    const { env } = await seeded();
    const r = await modern(env, 'tools/call', summary, { now: new Date('2026-11-02T16:00:00Z') });
    expect(result(r).structuredContent).toMatchObject({ user: FRANK, month: '2026-10', today: '2026-11-02' });
  });
});

describe('/mcp: tools/list', () => {
  async function tools(env: Env = makeEnv().env): Promise<Record<string, any>[]> {
    return ((await rpc(env, 'tools/list')).result as { tools: Record<string, any>[] }).tools;
  }

  it('lista las siete herramientas del diseño, con o sin params', async () => {
    const { env } = makeEnv();
    expect((await tools()).map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const params of [{}, { cursor: 'x' }, null]) {
      const result = (await rpc(env, 'tools/list', params)).result as { tools: unknown[]; nextCursor?: string };
      expect(result.tools).toHaveLength(7);
      expect(result.nextCursor).toBeUndefined();
    }
  });

  it('cada una trae descripción, esquema de entrada cerrado y anotaciones', async () => {
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

  it('todo lo que describe a las herramientas está en inglés', async () => {
    const all = await tools();
    expect(JSON.stringify(all)).not.toMatch(SPANISH);
    expect(all.map((t) => t.title)).toEqual([
      'Record transaction',
      'List transactions',
      'Month summary',
      'Record transfer between accounts',
      'Mark fixed expense as paid',
      'Record income',
      'List accounts',
    ]);
    // Cada descripción dice de quién son las finanzas que toca.
    for (const tool of all) expect(tool.description, tool.name).toContain('in the finances of `user`');
  });

  it('las de lectura se anuncian como tales y solo mark_fixed_paid, de las de escritura, es idempotente', async () => {
    const hints = Object.fromEntries((await tools()).map((t) => [t.name, [t.annotations.readOnlyHint, t.annotations.idempotentHint]]));
    expect(hints).toEqual({
      add_transaction: [false, false],
      list_transactions: [true, true],
      month_summary: [true, true],
      add_transfer: [false, false],
      mark_fixed_paid: [false, true],
      add_income: [false, false],
      list_accounts: [true, true],
    });
  });

  it('los esquemas declaran obligatorios, listas y valores por defecto', async () => {
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t.inputSchema]));

    const tx = byName.add_transaction;
    expect(Object.keys(tx.properties)).toEqual(['user', 'description', 'amount', 'currency', 'account', 'date', 'place', 'category', 'method', 'notes']);
    expect(tx.required).toEqual(['user', 'description', 'amount']);
    expect(tx.properties.amount).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    // Sin valor por defecto: la moneda que se aplica es la de la cuenta, y eso lo dice la descripción.
    expect(tx.properties.currency).toMatchObject({ type: 'string', enum: ['DOP', 'USD', 'TRY'] });
    expect(tx.properties.currency.default).toBeUndefined();
    expect(tx.properties.currency.description).toContain('the currency of the account is used');
    // La cuenta es texto libre: su nombre o su id.
    expect(tx.properties.account).toMatchObject({ type: 'string', maxLength: 120 });
    expect(tx.properties.account.enum).toBeUndefined();
    expect(tx.properties.account.description).toContain('default account');
    // Las listas son las canónicas en inglés, aunque se acepten también en español y en turco.
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
    // `add_to_budget` es el nombre de antes de `move_budget` y se sigue aceptando; ninguno es obligatorio.
    expect(transfer.properties.move_budget).toMatchObject({ type: 'boolean' });
    expect(transfer.properties.add_to_budget).toMatchObject({ type: 'boolean' });
    expect(transfer.properties.fee).toMatchObject({ type: 'number', minimum: 0 });
    // La tasa es opcional: sin ella vale la del mes.
    expect(transfer.required).toEqual(['user', 'from_account', 'to_account', 'amount']);
    expect(transfer.properties.from_account).toMatchObject({ type: 'string', minLength: 1, maxLength: 120 });
    expect(transfer.properties.amount).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    expect(transfer.properties.rate).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    // La vía es texto libre: Remitly y PayPal son solo sugerencias.
    expect(transfer.properties.via).toMatchObject({ type: 'string', default: 'Remitly', minLength: 1, maxLength: 60 });
    expect(transfer.properties.via.enum).toBeUndefined();
    for (const via of VIAS) expect(transfer.properties.via.description).toContain(via);

    const paid = byName.mark_fixed_paid;
    expect(Object.keys(paid.properties)).toEqual(['user', 'name', 'month', 'paid']);
    expect(paid.required).toEqual(['user', 'name']);
    expect(paid.properties.paid).toMatchObject({ type: 'boolean', default: true });

    const income = byName.add_income;
    expect(Object.keys(income.properties)).toEqual(['user', 'amount', 'currency', 'account', 'date', 'description', 'add_to_budget', 'rate', 'recurring']);
    expect(income.properties.add_to_budget).toMatchObject({ type: 'boolean', default: false });
    expect(income.required).toEqual(['user', 'amount']);
    expect(income.properties.currency).toMatchObject({ type: 'string', enum: ['DOP', 'USD', 'TRY'] });
    expect(income.properties.description).toMatchObject({ type: 'string', maxLength: 200 });

    // list_accounts no tiene más argumento que de quién.
    expect(Object.keys(byName.list_accounts.properties)).toEqual(['user']);
    expect(byName.list_accounts.required).toEqual(['user']);
  });

  it('list_accounts le dice al modelo cuándo llamarla', async () => {
    const byName = Object.fromEntries((await tools()).map((t) => [t.name, t]));
    expect(byName.list_accounts.description).toContain('Call it when you need to know which accounts exist');
    // Y quien nombra una cuenta sabe dónde mirarlas.
    for (const [name, field] of [
      ['add_transaction', 'account'],
      ['add_income', 'account'],
      ['add_transfer', 'from_account'],
      ['add_transfer', 'to_account'],
    ] as const) {
      expect(byName[name].inputSchema.properties[field].description, `${name}.${field}`).toContain('list_accounts');
    }
  });

  it('`user` refleja los usuarios configurados: sus ids, y obligatorio solo si hay más de uno', async () => {
    // Dos usuarios (wrangler.toml): hay que decir quién.
    for (const tool of await tools()) {
      expect(tool.inputSchema.properties.user, tool.name).toEqual({ type: 'string', enum: [F, E], description: expect.stringContaining(BOTH) });
      expect(tool.inputSchema.properties.user.description).toContain('ask instead of guessing');
      expect(tool.inputSchema.required[0], tool.name).toBe('user');
    }

    // La lista sale del entorno de cada petición: la misma base con otro USERS anuncia otros usuarios.
    const { env } = makeEnv();
    const three = await tools({ ...env, USERS: 'frank:Frank,eda:Eda,leo' });
    for (const tool of three) {
      expect(tool.inputSchema.properties.user.enum).toEqual(['frank', 'eda', 'leo']);
      expect(tool.inputSchema.properties.user.description).toContain('frank (Frank), eda (Eda), leo (Leo)');
      expect(tool.inputSchema.required).toContain('user');
    }

    // Un solo usuario: se anuncia, es el valor por defecto y no es obligatorio.
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

    // Sin USERS, la app es de un solo usuario.
    const unset = await tools({ ...env, USERS: undefined });
    expect(unset[0]!.inputSchema.properties.user).toMatchObject({ enum: ['me'], default: 'me' });
    expect(unset[0]!.inputSchema.required).toEqual(['description', 'amount']);
  });
});

describe('/mcp: tools/call', () => {
  it('herramienta desconocida o llamada mal formada: -32602, no un resultado', async () => {
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

  it('un fallo inesperado es -32603 y no filtra detalles internos', async () => {
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

describe('de quién son las finanzas: `user`', () => {
  /** Una llamada válida de cada herramienta, a falta de decir de quién. */
  const CALLS: [string, Record<string, unknown>][] = [
    ['add_transaction', { description: 'Uber', amount: 850 }],
    ['list_transactions', {}],
    ['month_summary', {}],
    ['add_transfer', { ...US_TO_DR, amount: 100, rate: 58 }],
    ['mark_fixed_paid', { name: 'Netflix' }],
    ['add_income', { amount: 100 }],
    ['list_accounts', {}],
  ];

  it('con varios usuarios, una llamada sin `user` es un error de la herramienta que dice quiénes hay', async () => {
    const { env, db } = await seeded();
    const before = await loadState(db, F);
    const expected = `Invalid data: user: is required. Valid users: ${BOTH}. ${ASK}`;
    for (const [name, args] of CALLS) {
      expect(await failsRaw(env, name, args), name).toBe(expected);
      // Un modelo suele mandar null o '' en lo que no sabe: sigue siendo "no vino".
      expect(await failsRaw(env, name, { ...args, user: null }), name).toBe(expected);
      expect(await failsRaw(env, name, { ...args, user: '   ' }), name).toBe(expected);
    }
    // Sin argumentos no hay de quién.
    expect(await failsRaw(env, 'month_summary')).toBe(expected);
    // No se le atribuye a nadie: ni al primero de la lista.
    expect(await loadState(db, F)).toEqual(before);
  });

  it('un usuario que no existe es un error de la herramienta que dice quiénes hay', async () => {
    const { env, db, sqlite } = await seeded();
    const before = await loadState(db, F);
    for (const [name, args] of CALLS) {
      expect(await failsRaw(env, name, { ...args, user: 'pedro' }), name).toBe(`Invalid data: user: unknown user "pedro". Valid users: ${BOTH}. ${ASK}`);
    }
    const add = { description: 'Uber', amount: 850 };
    // El nombre completo no es el id, y el id no es un número.
    expect(await failsRaw(env, 'add_transaction', { ...add, user: 'Frank Reyes' })).toContain('unknown user "Frank Reyes"');
    expect(await failsRaw(env, 'add_transaction', { ...add, user: 7 })).toBe(`Invalid data: user: must be text. Valid users: ${BOTH}. ${ASK}`);
    expect(await failsRaw(env, 'add_transaction', { ...add, user: [F] })).toContain('user: must be text');
    // Lo que mandó el cliente vuelve acotado.
    expect((await failsRaw(env, 'add_transaction', { ...add, user: 'x'.repeat(5000) })).length).toBeLessThan(300);
    // El error del usuario va antes que cualquier otro: sin saber de quién no hay nada que validar.
    expect(await failsRaw(env, 'add_transaction', { user: 'pedro' })).not.toContain('description');

    expect(await loadState(db, F)).toEqual(before);
    expect(count(sqlite, 'months')).toBe(6);
    expect(count(sqlite, 'transactions', 'pedro')).toBe(0);
  });

  it('el id se acepta con otras mayúsculas o espacios de más', async () => {
    const { env, sqlite } = makeEnv();
    for (const user of [' Frank ', 'FRANK', 'frank']) {
      const r = await callRaw(env, 'add_transaction', { user, description: 'Uber', amount: 850 });
      expect(r.isError, user).toBe(false);
      expect(r.data!.user).toEqual(FRANK);
    }
    expect(count(sqlite, 'transactions', F)).toBe(3);
    expect(count(sqlite, 'transactions')).toBe(3);
  });

  it('el mismo gasto dictado por cada uno queda en las finanzas de cada cual', async () => {
    const { env, db, sqlite } = makeEnv();
    await replaceAll(db, F, seedState());
    const expense = { description: 'Uber', amount: 850, category: 'Transport' };

    const frank = await callRaw(env, 'add_transaction', { ...expense, user: F });
    const eda = await callRaw(env, 'add_transaction', { ...expense, user: E });
    // Frank tiene tres meses y presupuesto; para Eda es su primer registro.
    expect(frank.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Transport · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
    );
    // Eda estrena sus propias cuentas (las iniciales, en cero): la suya también se llama "DR account", pero es otra.
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
    // El mes de Eda es suyo: no hereda los gastos fijos de Frank.
    expect((await getMonth(db, E, '2026-10'))!.fixed).toEqual([]);
  });

  it('cada quien consulta y cambia solo lo suyo, y la respuesta dice de quién es', async () => {
    const { env, db } = makeEnv();
    await replaceAll(db, F, seedState());

    // Eda todavía no tiene nada.
    expect(await failsRaw(env, 'month_summary', { user: E })).toBe('Eda has no months yet. Record a transaction to create the current month.');
    expect(await failsRaw(env, 'list_transactions', { user: E })).toBe('Eda has no months yet. Record a transaction to create the current month.');

    // Su envío crea su octubre con su tasa; la de Frank no se mueve.
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

    // Netflix es un gasto fijo de Frank; Eda no tiene ninguno.
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

    // Un mes cerrado de Frank no le cierra nada a Eda (ni existe para ella).
    expect(await failsRaw(env, 'list_transactions', { user: E, month: '2026-08' })).toBe('August 2026 does not exist for Eda. Existing months: 2026-10.');
    expect((await callRaw(env, 'list_transactions', { user: F, month: '2026-08' })).data).toMatchObject({ user: FRANK, closed: true, count: 10 });

    // Las cuentas y los ingresos también son de cada quien: los saldos de Frank no se movieron con lo de Eda.
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

  it('con un solo usuario configurado, `user` se puede omitir', async () => {
    const { env, db, sqlite } = makeEnv({ USERS: 'frank:Frank' });
    await replaceAll(db, F, seedState());

    const added = await callRaw(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(added.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,999.71 of 70,000 DOP. DR account balance: 219,791.93 DOP.',
    );
    expect(added.data!.user).toEqual(FRANK);
    expect(count(sqlite, 'transactions', F)).toBe(28);

    // Todas las herramientas, y también sin argumentos o con `user` en blanco.
    expect((await callRaw(env, 'list_transactions')).data).toMatchObject({ user: FRANK, count: 8 });
    expect((await callRaw(env, 'month_summary', { user: null })).data).toMatchObject({ user: FRANK, month: '2026-10' });
    expect((await callRaw(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, user: '' })).text).toContain('Transfer recorded for Frank:');
    expect((await callRaw(env, 'mark_fixed_paid', { name: 'Netflix' })).text).toContain('Paid for Frank: Netflix');
    expect((await callRaw(env, 'add_income', { amount: 100 })).text).toContain('Income recorded for Frank:');
    expect((await callRaw(env, 'list_accounts')).data).toMatchObject({ user: FRANK, defaultAccountId: 'dr' });

    // Decirlo sigue valiendo, pero tiene que ser ese.
    expect((await callRaw(env, 'month_summary', { user: 'Frank' })).isError).toBe(false);
    expect(await failsRaw(env, 'month_summary', { user: E })).toBe('Invalid data: user: unknown user "eda". Valid users: frank (Frank).');
    expect(count(sqlite, 'months', E)).toBe(0);
  });

  it('sin USERS hay un solo usuario, "me", y tampoco hace falta decirlo', async () => {
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
  it('«gasté 850 en Uber hoy con tarjeta»', async () => {
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
      // Sin decir cuenta, sale de la cuenta por defecto del usuario.
      accountId: 'dr',
      notes: '',
      source: 'claude',
      createdAt: NOW.toISOString(),
    } satisfies Record<keyof Transaction, unknown>);
    expect(r.data).toEqual({
      user: FRANK,
      transaction: stored,
      monthCreated: false,
      account: { id: 'dr', name: 'DR account', currency: 'DOP', balance: expect.closeTo(219791.93, 6) },
      month: { key: '2026-10', label: 'October 2026', closed: false, currency: 'DOP', budget: 70000, used: expect.closeTo(49999.71, 6), available: expect.closeTo(20000.29, 6) },
    });
    // El saldo que dice es el de shared/calc.ts con el gasto ya restado.
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('solo con descripción y monto aplica los valores por defecto que anuncia el esquema', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: '  Empanadas  ', amount: 150.5 });
    expect(r.text).toBe(
      'Recorded for Frank: Empanadas · 150.50 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: 49,300.21 of 70,000 DOP. DR account balance: 220,491.43 DOP.',
    );
    expect(r.data!.transaction).toMatchObject({ desc: 'Empanadas', cat: 'Food', method: 'Debit card', cur: 'DOP', accountId: 'dr', date: '2026-10-07', place: '', notes: '' });
  });

  it('respeta todos los campos; un monto en otra moneda se muestra también en la principal y en la de la cuenta', async () => {
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
    // Lo que dictó la persona (descripción, lugar, notas) queda tal cual, en su idioma.
    expect(r.text).toBe(
      'Recorded for Frank: Vuelo · JetBlue · 320.45 USD (18,829.64 DOP) · Travel · Transfer · 2026-10-06 (October 2026) · paid from DR account (18,829.64 DOP). Used so far: 67,979.35 of 70,000 DOP. DR account balance: 201,812.29 DOP.',
    );
    expect(r.data!.transaction).toMatchObject({ desc: 'Vuelo', amount: 320.45, cur: 'USD', place: 'JetBlue', cat: 'Travel', method: 'Transfer', notes: 'ida', date: '2026-10-06' });
  });

  it('categoría y método dichos en español o en turco se guardan con su nombre canónico', async () => {
    const { env, db } = await seeded();
    const cases: [category: string, method: string, cat: string, stored: string][] = [
      // "Tarjeta", "Kart" o "card" a secas: la de débito.
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
      // En inglés, también sin importar las mayúsculas.
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
    // Lo guardado son siempre valores de las listas canónicas.
    for (const t of saved) {
      expect(CATS).toContain(t.cat);
      expect(METHODS).toContain(t.method);
    }
    // Y el resumen las agrupa con las que ya había, no como categorías aparte.
    const names = ((await call(env, 'month_summary')).data!.categories as { name: string }[]).map((c) => c.name);
    expect(names).not.toContain('Transporte');
    expect(names).not.toContain('Ulaşım');
    expect(names.filter((n) => n === 'Transport')).toHaveLength(1);
  });

  it('null o texto vacío en un argumento opcional cuenta como "no vino"', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Pan', amount: 90, currency: null, date: '', place: null, category: '  ', method: null, notes: '' });
    expect(r.isError).toBe(false);
    expect(r.data!.transaction).toMatchObject({ date: '2026-10-07', place: '', cat: 'Food', method: 'Debit card', cur: 'DOP', notes: '' });
  });

  it('"hoy" es la fecha en República Dominicana, no en UTC', async () => {
    const { env } = await seeded();
    // 02:30 UTC del 1 de noviembre son las 22:30 del 31 de octubre en Santo Domingo.
    const r = await call(env, 'add_transaction', { description: 'Cena', amount: 1200 }, new Date('2026-11-01T02:30:00Z'));
    expect(r.data!.transaction).toMatchObject({ date: '2026-10-31', monthKey: '2026-10' });
    expect(r.data!.monthCreated).toBe(false);
  });

  it('avisa cuando el gasto deja el mes por encima del presupuesto', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Sofá', amount: 25000, category: 'Home' });
    expect(r.text).toContain('Used so far: 74,149.71 of 70,000 DOP. Over budget by 4,149.71 DOP.');
  });

  it('en una base vacía crea el mes de hoy; sin presupuesto lo dice', async () => {
    const { env, sqlite } = makeEnv();
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 850 });
    expect(r.text).toBe(
      'Recorded for Frank: Uber · 850.00 DOP · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. The month October 2026 was created. Used so far: 850.00 DOP (no budget set). DR account balance: -850.00 DOP.',
    );
    expect(r.data!.monthCreated).toBe(true);
    expect(count(sqlite, 'months')).toBe(1);
    expect(count(sqlite, 'months', F)).toBe(1);
  });

  it('crea el mes siguiente con los gastos fijos del anterior sin pagar', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect(r.text).toBe(
      'Recorded for Frank: Regalo · 1,500.00 DOP · Food · Debit card · 2026-11-03 (November 2026) · paid from DR account. The month November 2026 was created. Used so far: 1,500.00 of 70,000 DOP. DR account balance: 219,141.93 DOP.',
    );
    // El saldo es el de ahora: ya cuenta el gasto, aunque tenga fecha del mes siguiente.
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
    const november = (await getMonth(db, F, '2026-11'))!;
    expect(november.fixed).toHaveLength(11);
    expect(november.fixed.every((f) => !f.paid)).toBe(true);
  });

  it('mes cerrado: error de la herramienta, sin guardar nada', async () => {
    const { env, sqlite } = await seeded();
    const text = await fails(env, 'add_transaction', { description: 'Tarde', amount: 100, date: '2026-08-15' });
    expect(text).toBe('August 2026 is closed: it is read-only. Reopen it to make changes.');
    expect(count(sqlite, 'transactions', F)).toBe(27);
  });

  it('argumentos inválidos: error de la herramienta con el motivo, sin guardar nada', async () => {
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
      // Fuera de las listas no se acepta en ningún idioma: después no se podría elegir en la aplicación.
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
    // Un mismo problema no se repite en el mensaje.
    expect(await fails(env, 'add_transaction', { description: 'x', amount: 10, date: 'ayer' })).toBe('Invalid data: date: is not a valid date (YYYY-MM-DD)');
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('no crea un mes lejano a hoy: un año equivocado no deja un mes fantasma', async () => {
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

    // Dentro del margen sí se crea: seis meses atrás y el mes siguiente.
    expect((await call(env, 'add_transaction', { description: 'Viejo', amount: 10, date: '2026-04-15' })).data!.monthCreated).toBe(true);
    expect((await call(env, 'add_transaction', { description: 'Próximo', amount: 10, date: '2026-11-01' })).data!.monthCreated).toBe(true);
    expect(count(sqlite, 'months', F)).toBe(5);
  });

  it('a un mes que ya existe se puede escribir aunque quede lejos de hoy; el de otro usuario no cuenta', async () => {
    const t = makeEnv();
    const state = seedState();
    state.months['2025-01'] = { ...state.months['2026-10']!, key: '2025-01', budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
    await replaceAll(t.db, F, state);
    const r = await call(t.env, 'add_transaction', { description: 'Atrasado', amount: 300, date: '2025-01-20' });
    expect(r.isError).toBe(false);
    expect(r.data!.transaction).toMatchObject({ monthKey: '2025-01', date: '2025-01-20' });
    expect(r.data!.monthCreated).toBe(false);

    // Que Frank tenga enero de 2025 no hace que exista para Eda.
    expect(await failsRaw(t.env, 'add_transaction', { user: E, description: 'Atrasado', amount: 300, date: '2025-01-20' })).toContain(
      'a month that does not exist for Eda and is far from today',
    );
    expect(count(t.sqlite, 'months', E)).toBe(0);
  });

  it('si el gasto se guardó pero no se pudo leer el resumen, confirma igual (para que no se repita)', async () => {
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
  it('por defecto lista el mes actual, de la más reciente a la más antigua', async () => {
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

  it('limit recorta a las más recientes y lo dice', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', { limit: 2 });
    const lines = r.text.split('\n');
    expect(lines[0]).toBe('Frank · October 2026: 7 transactions · 10,845.00 DOP in total. Showing the 2 most recent.');
    expect(lines).toHaveLength(3);
    expect(r.data).toMatchObject({ count: 7, total: 10845, shown: 2 });
    expect(r.data!.transactions).toHaveLength(2);
  });

  it('con la misma fecha va primero la última registrada; se muestran las notas, otra moneda y la cuenta de cada una', async () => {
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

  it('un mes cerrado se puede consultar', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', { month: '2026-08', limit: 1 });
    expect(r.text.split('\n')).toEqual([
      'Frank · August 2026 · closed: 10 transactions · 27,850.00 DOP in total. Showing the most recent one.',
      '2026-08-29 · Gas · Shell · 2,000.00 DOP · Transport · Debit card · DR account',
    ]);
    expect(r.data).toMatchObject({ month: '2026-08', closed: true, count: 10 });
  });

  it('un mes sin transacciones, o con una sola, lo dice', async () => {
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

  it('si el mes del calendario aún no existe, usa el mes en curso de la aplicación', async () => {
    const { env } = await seeded();
    const r = await call(env, 'list_transactions', {}, new Date('2026-11-02T16:00:00Z'));
    expect(r.data).toMatchObject({ month: '2026-10', today: '2026-11-02', count: 7 });
  });

  it('mes que no existe o mal escrito, o límite inválido: error de la herramienta', async () => {
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

  it('sin ningún mes registrado: error de la herramienta, sin crear nada', async () => {
    const { env, sqlite } = makeEnv();
    expect(await fails(env, 'list_transactions')).toBe('Frank has no months yet. Record a transaction to create the current month.');
    expect(count(sqlite, 'months')).toBe(0);
  });
});

describe('month_summary', () => {
  it('resume el mes actual con las cifras del panel', async () => {
    const { env, db, sqlite } = await seeded();
    const r = await call(env, 'month_summary');
    expect(r.isError).toBe(false);
    expect(r.text.split('\n')).toEqual([
      'Frank · October 2026 · amounts in DOP',
      'Budget: 70,000.00 DOP (1,191.29 USD) · by account: DR account 70,000.00 DOP',
      // Cómo llegó a 70,000: 65,000 iniciales y un ajuste de 5,000 el día 5.
      'Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair)',
      // Septiembre: 70,000 − (35,872.66 + 106 USD × 58.57 + 24,555) usados.
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
    // Los saldos y el total son los de shared/calc.ts.
    const expected = balances(await loadState(db, F), '2026-10');
    expect(r.data!.accounts.map((a: { balance: number }) => a.balance)).toEqual(expected.accounts.map((a) => a.balance));
    expect(r.data!.totalMoney).toEqual({ main: expected.totalMain, second: expected.totalSecond });
    // Es de solo lectura.
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('un mes cerrado: todo pagado y con la tasa ponderada de sus envíos', async () => {
    const { env } = await seeded();
    const r = await call(env, 'month_summary', { month: '2026-08' });
    const lines = r.text.split('\n');
    // (1500 × 58.40 + 300 × 57.10) / 1800
    expect(lines[0]).toBe('Frank · August 2026 · closed · amounts in DOP');
    expect(lines).toContain("Month rates: USD to DOP: 58.18 (from this month's transfers)");
    // Los saldos son los del final de ese mes, no los de hoy.
    expect(lines.some((l) => l.startsWith('Account balances at the end of August 2026: US account 5,894.00 USD'))).toBe(true);
    expect(lines).toContain('Transactions: 10 (27,850.00 DOP)');
    expect(lines.some((l) => l.startsWith('Monthly expenses: 11 of 11 paid'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Still to pay'))).toBe(false);
    expect(r.data).toMatchObject({ month: '2026-08', closed: true, fixed: { count: 11, paidCount: 11, pending: expect.closeTo(0, 6), pendingItems: [] } });
    expect(r.data!.rates).toEqual([expect.objectContaining({ from: 'USD', to: 'DOP', source: 'transfers', monthKey: '2026-08' })]);
    expect(r.data!.rates[0].rate).toBeCloseTo((1500 * 58.4 + 300 * 57.1) / 1800, 10);
  });

  it('un gasto fijo pendiente en otra moneda se muestra con su equivalente en la principal', async () => {
    const { env } = await seeded();
    await call(env, 'mark_fixed_paid', { name: 'Claude', paid: false });
    const r = await call(env, 'month_summary');
    expect(r.text).toContain('Still to pay: Claude 106.00 USD (6,228.56 DOP), day 5; Google One 121.56 DOP, day 16;');
    expect(r.data!.fixed.pendingItems[0]).toEqual({ name: 'Claude', day: '5', amount: 106, cur: 'USD', inMain: expect.closeTo(6228.56, 6) });
  });

  it('un mes recién creado, sin gastos', async () => {
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
      // Sin tasa escrita, la del mes sale de su envío.
      "Month rates: USD to DOP: 58.00 (from this month's transfers)",
      'Today is 2026-10-07.',
    ]);
  });

  it('si el mes del calendario aún no existe, resume el mes en curso de la aplicación', async () => {
    const { env } = await seeded();
    const r = await call(env, 'month_summary', {}, new Date('2026-11-02T16:00:00Z'));
    expect(r.text.split('\n')[0]).toBe('Frank · October 2026 · amounts in DOP');
    expect(r.text).toContain('Today is 2026-11-02.');
    expect(r.data).toMatchObject({ month: '2026-10', today: '2026-11-02' });
  });

  it('si el mes del calendario se cerró antes de tiempo, resume el siguiente (y el cerrado, si se pide)', async () => {
    const { env, db } = await seeded();
    await closeMonth(db, F, '2026-10', {}, NOW);
    const r = await call(env, 'month_summary');
    expect(r.data).toMatchObject({ month: '2026-11', closed: false, today: '2026-10-07', fixed: { count: 11, paidCount: 0 } });
    expect((await call(env, 'month_summary', { month: '2026-10' })).data).toMatchObject({ month: '2026-10', closed: true });
    expect((await call(env, 'list_transactions')).data).toMatchObject({ month: '2026-11', count: 0 });
    // Eda no cerró su octubre: el suyo sigue siendo el mes en curso.
    expect((await callRaw(env, 'month_summary', { user: E })).data).toMatchObject({ user: EDA, month: '2026-10', closed: false });
  });

  it('un mes posterior ya creado no desplaza al del calendario mientras siga abierto', async () => {
    const { env } = await seeded();
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect((await call(env, 'month_summary')).data).toMatchObject({ month: '2026-10', transactions: { count: 7 } });
    expect((await call(env, 'list_transactions')).data).toMatchObject({ month: '2026-10', count: 7 });
    expect((await call(env, 'mark_fixed_paid', { name: 'Netflix' })).data!.fixed.monthKey).toBe('2026-10');
  });

  it('mes que no existe, mal escrito o base vacía: error de la herramienta', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'month_summary', { month: '2027-01' })).toBe(
      'January 2027 does not exist for Frank. Existing months: 2026-08 (closed), 2026-09 (closed), 2026-10.',
    );
    expect(await fails(env, 'month_summary', { month: 'octubre 2026' })).toBe('Invalid data: month: is not a valid month (YYYY-MM)');
    expect(await fails(makeEnv().env, 'month_summary')).toBe('Frank has no months yet. Record a transaction to create the current month.');
  });
});

describe('add_transfer', () => {
  it('registra el envío: lo que sale, lo que entra y el saldo nuevo de las dos cuentas', async () => {
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
      // Sin move_budget el presupuesto del mes sigue en sus 70,000.
      month: { key: '2026-10', label: 'October 2026', currency: 'DOP', budget: 70000 },
      monthCreated: false,
    });
    expect(r.text).not.toContain('budget');
    expect(r.data!.from.balance).toBeCloseTo(12982, 8);
    expect(r.data!.to.balance).toBeCloseTo(250341.93, 6);
    // No es un gasto: el usado del mes no cambia (octubre tiene su tasa escrita, que manda sobre la de los envíos).
    expect((await call(env, 'month_summary')).data).toMatchObject({ used: expect.closeTo(49149.71, 6), transactions: { count: 7 } });
  });

  it('las cuentas se dicen por su nombre, sin mayúsculas ni acentos, por un comienzo que sea de una sola, o por su id', async () => {
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
    // Y en el otro sentido: sale de la cuenta en pesos, en pesos, y la tasa es lo que llega por cada peso.
    const back = await call(env, 'add_transfer', { from_account: 'DR account', to_account: 'US account', amount: 5876, rate: 1 / 58.76 });
    expect(back.text).toContain('5,876.00 DOP left DR account, 100.00 USD arrived in US account (1 USD = 58.76 DOP)');
    expect(back.data).toMatchObject({ sent: { amount: 5876, currency: 'DOP' }, received: { amount: expect.closeTo(100, 8), currency: 'USD' } });
    expect(back.data!.from.balance).toBe(await balanceOf(db, 'dr'));
    expect(back.data!.to.balance).toBe(await balanceOf(db, 'us'));
  });

  it('por defecto: vía Remitly y fecha de hoy', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 1500, rate: 58.76, via: null, date: '' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 1,500.00 USD left US account, 88,140.00 DOP arrived in DR account (1 USD = 58.76 DOP) · Remitly · 2026-10-07 (October 2026). US account balance: 11,982.00 USD. DR account balance: 308,781.93 DOP.',
    );
    expect(r.data!.transfer).toMatchObject({ via: 'Remitly', date: '2026-10-07', monthKey: '2026-10' });
  });

  it('sin tasa usa la del mes para esas dos monedas y dice de dónde salió', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100 });
    expect(r.text).toBe(
      "Transfer recorded for Frank: 100.00 USD left US account, 5,876.00 DOP arrived in DR account (1 USD = 58.76 DOP) · Remitly · 2026-10-07 (October 2026). No rate was given: the rate in effect on that date was used (typed on 2026-10-06). US account balance: 13,382.00 USD. DR account balance: 226,517.93 DOP.",
    );
    expect(r.data).toMatchObject({ transfer: { rate: 58.76 }, rateSource: 'month', received: { amount: expect.closeTo(5876, 8), currency: 'DOP' } });

    // En noviembre nadie ha escrito tasa: sigue vigente la última de octubre, y lo dice.
    const november = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, date: '2026-11-02' });
    expect(november.text).toContain('No rate was given: the rate in effect on that date was used (typed on 2026-10-06, still in effect).');
    expect(november.data).toMatchObject({ transfer: { rate: 58.76 }, rateSource: 'previous' });

    // Una tasa que nadie ha puesto nunca es un valor de respaldo: lo que llegó es aproximado y hay que preguntarlo.
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY' });
    const lira = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'TR account', amount: 100 });
    expect(lira.text).toBe(
      "Transfer recorded for Frank: 100.00 USD left US account, 4,200.00 TRY arrived in TR account (1 USD = 42.00 TRY) · Remitly · 2026-10-07 (October 2026). No rate was given: the rate in effect on that date was used (default value, not set yet). Nobody has set that rate yet, so the amount that arrived is only approximate: ask the person how much arrived. US account balance: 13,182.00 USD. TR account balance: 4,200.00 TRY.",
    );
    expect(lira.data).toMatchObject({ rateSource: 'default', received: { amount: 4200, currency: 'TRY' } });
    expect(lira.data!.to.balance).toBe(await balanceOf(db, 'tr', F, '2026-11'));
  });

  it('entre dos cuentas de la misma moneda llega lo mismo que sale', async () => {
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
    // Pasar dinero entre cuentas propias no cambia el total, ni la tasa del mes.
    const summary = await call(env, 'month_summary');
    expect(summary.data!.totalMoney.main).toBeCloseTo(1012844.25, 6);
    expect(summary.text).toContain('Month rates: USD to DOP: 58.76 (typed on 2026-10-06)');

    // Una tasa distinta de 1 inventaría o perdería dinero: no se acepta. Decir 1 no molesta.
    expect(await fails(env, 'add_transfer', { from_account: 'dr', to_account: 'ahorro', amount: 100, rate: 58.76 })).toBe(
      'Invalid data: rate: must be omitted between accounts of the same currency (both are in DOP)',
    );
    expect((await call(env, 'add_transfer', { from_account: 'dr', to_account: 'ahorro', amount: 100, rate: 1 })).data!.transfer.rate).toBe(1);
    expect((await getMonth(db, F, '2026-10'))!.transfers).toHaveLength(3);
  });

  it('un envío en liras: de la cuenta en pesos a la cuenta en Turquía, con la tasa que diga la persona', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'Türkiye hesabı', currency: 'TRY' });
    const r = await call(env, 'add_transfer', { from_account: 'DR account', to_account: 'turkiye', amount: 14000, rate: 0.7, via: 'Wise' });
    expect(r.text).toBe(
      'Transfer recorded for Frank: 14,000.00 DOP left DR account, 9,800.00 TRY arrived in Türkiye hesabı (1 TRY = 1.43 DOP) · Wise · 2026-10-07 (October 2026). DR account balance: 206,641.93 DOP. Türkiye hesabı balance: 9,800.00 TRY.',
    );
    expect(r.data!.to).toEqual({ id: 'tr', name: 'Türkiye hesabı', currency: 'TRY', balance: await balanceOf(db, 'tr') });
    // Ese envío pasa a ser la tasa del mes entre pesos y liras.
    expect((await call(env, 'month_summary')).text).toContain("TRY to DOP: 1.43 (from this month's transfers)");
  });

  it('la vía es texto libre: se guarda la que se diga, sin espacios de más', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, via: '  Western Union ' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('100.00 USD left US account, 5,800.00 DOP arrived in DR account (1 USD = 58.00 DOP) · Western Union · 2026-10-07');
    expect(r.data!.transfer.via).toBe('Western Union');

    // Tal como se dicta, en cualquier idioma, y hasta el largo que admite la aplicación.
    const longest = 'x'.repeat(60);
    for (const via of ['Banco Popular', 'Elden Havale', 'paypal', longest]) {
      expect((await call(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, via })).data!.transfer.via).toBe(via);
    }
    expect((await getMonth(db, F, '2026-10'))!.transfers.map((t) => t.via)).toEqual(['Remitly', 'Western Union', 'Banco Popular', 'Elden Havale', 'paypal', longest]);
  });

  it('va al mes de su fecha y lo crea si falta', async () => {
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
    // Los saldos son los de ahora, con el envío de noviembre ya contado.
    expect(r.data!.to.balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
  });

  it('mes cerrado o lejano: error de la herramienta, sin guardar nada', async () => {
    const { env, sqlite } = await seeded();
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, date: '2026-09-30' })).toBe(
      'September 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    // Tampoco sin tasa, que es cuando hay que leer la del mes.
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, date: '2026-09-30' })).toBe(
      'September 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    expect(await fails(env, 'add_transfer', { ...US_TO_DR, amount: 100, rate: 58, date: '2025-10-07' })).toContain('is far from today (2026-10-07)');
    expect(count(sqlite, 'transfers', F)).toBe(5);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('una cuenta que no existe, ambigua o repetida: error de la herramienta que nombra las cuentas, sin guardar nada', async () => {
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
    // Una cuenta que no se reconoce no llega a crear el mes de la fecha.
    expect(await fails(env, 'add_transfer', { from_account: 'us', to_account: 'nada', amount: 100, date: '2026-11-02' })).toContain('unknown account "nada"');
    expect(count(sqlite, 'transfers', F)).toBe(5);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('argumentos inválidos: error de la herramienta con el motivo', async () => {
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
      // Los argumentos de la versión anterior ya no existen.
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

  it('si el envío se guardó pero no se pudieron leer los saldos, confirma igual', async () => {
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

  it('marca como pagado por nombre exacto, sin distinguir mayúsculas', async () => {
    // Eda tiene un Netflix con el mismo id: el suyo no se toca (lo comprueba afterEach).
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
      } satisfies Record<keyof FixedExpense, unknown>,
      changed: true,
      // Mientras está pagado, resta de la cuenta de la que se paga.
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

  it('ignora espacios de más y acentos; con paid: false lo deja sin pagar', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: '  health   INSURANCE ', paid: false });
    expect(r.text).toBe(
      'Marked as not paid for Frank: Health insurance · 5,640.00 DOP · October 2026 · paid from DR account. Monthly expenses: 5 of 11 paid · Fixed pending: 9,360.86 DOP. Used so far: 43,509.71 of 70,000 DOP. DR account balance: 226,281.93 DOP.',
    );
    expect(await paidOf(db, 'Health insurance')).toBe(false);

    // El nombre de un gasto fijo es un dato de la persona, en su idioma: se busca tal como lo dice.
    await createFixed(db, F, { monthKey: '2026-10', name: 'Seguro médico', amount: 2500, cur: 'DOP' });
    const accent = await call(env, 'mark_fixed_paid', { name: 'seguro medico' });
    expect(accent.text).toBe(
      'Paid for Frank: Seguro médico · 2,500.00 DOP · October 2026 · paid from DR account. Monthly expenses: 6 of 12 paid · Fixed pending: 9,360.86 DOP. Used so far: 46,009.71 of 70,000 DOP. DR account balance: 223,781.93 DOP.',
    );
    expect(await paidOf(db, 'Seguro médico')).toBe(true);
  });

  it('un gasto en otra moneda se muestra con su equivalente en la principal; el saldo que cambia es el de su cuenta', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: 'claude', paid: false });
    expect(r.text).toBe(
      'Marked as not paid for Frank: Claude · 106.00 USD (6,228.56 DOP) · October 2026 · paid from US account. Monthly expenses: 5 of 11 paid · Fixed pending: 9,949.42 DOP. Used so far: 42,921.15 of 70,000 DOP. US account balance: 13,588.00 USD.',
    );
    expect(r.data!.account).toEqual({ id: 'us', name: 'US account', currency: 'USD', balance: await balanceOf(db, 'us') });

    // Pagado desde una cuenta en otra moneda: dice cuánto le resta a esa cuenta.
    await createFixed(db, F, { monthKey: '2026-10', name: 'Spotify', amount: 10, cur: 'USD', accountId: 'dr' });
    const other = await call(env, 'mark_fixed_paid', { name: 'spotify' });
    expect(other.text).toContain('Paid for Frank: Spotify · 10.00 USD (587.60 DOP) · October 2026 · paid from DR account (587.60 DOP).');
    expect(other.text).toContain('DR account balance: 220,054.33 DOP.');
    expect(other.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('vale el comienzo del nombre o una parte, si identifica a uno solo', async () => {
    const { env, db } = await seeded();
    expect((await call(env, 'mark_fixed_paid', { name: 'goo' })).data!.fixed.name).toBe('Google One');
    expect((await call(env, 'mark_fixed_paid', { name: 'cloud' })).data!.fixed.name).toBe('iCloud+');
    expect((await call(env, 'mark_fixed_paid', { name: 'fit' })).data!.fixed.name).toBe('Smartfit');
    expect(await paidOf(db, 'Google One')).toBe(true);
    expect(await paidOf(db, 'iCloud+')).toBe(true);
    expect(await paidOf(db, 'Smartfit')).toBe(true);
  });

  it('el nombre exacto gana al comienzo, y el comienzo a la parte', async () => {
    const { env, db } = await seeded();
    await createFixed(db, F, { monthKey: '2026-10', name: 'Claude Max', amount: 100, cur: 'USD' });
    await createFixed(db, F, { monthKey: '2026-10', name: 'Pet health plan', amount: 3000, cur: 'DOP' });
    expect((await call(env, 'mark_fixed_paid', { name: 'claude', paid: false })).data!.fixed.name).toBe('Claude');
    expect((await call(env, 'mark_fixed_paid', { name: 'health', paid: false })).data!.fixed.name).toBe('Health insurance');
    expect((await call(env, 'mark_fixed_paid', { name: 'plan' })).data!.fixed.name).toBe('Pet health plan');
  });

  it('si ya estaba en ese estado no cambia nada y lo dice', async () => {
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

    // Repetir la misma llamada da el mismo estado (es idempotente).
    await call(env, 'mark_fixed_paid', { name: 'Netflix' });
    const repeated = await call(env, 'mark_fixed_paid', { name: 'Netflix' });
    expect(repeated.data).toMatchObject({ changed: false, month: { paidCount: 7 } });
  });

  it('nombre ambiguo: error de la herramienta con los nombres del mes, sin cambiar nada', async () => {
    const { env, db } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'cl' })).toBe(
      `"cl" matches several fixed expenses for Frank in October 2026: Claude, Cluely. Repeat the call with the exact name. Fixed expenses in October 2026: ${FIXED_NAMES}.`,
    );
    // "t" no empieza ningún nombre, pero está dentro de varios.
    expect(await fails(env, 'mark_fixed_paid', { name: 't' })).toContain(
      'matches several fixed expenses for Frank in October 2026: Electricity, Internet, Health insurance, Fridge payment, Smartfit, Netflix.',
    );
    expect(await paidOf(db, 'Cluely')).toBe(false);

    await createFixed(db, F, { monthKey: '2026-10', name: 'netflix', amount: 500, cur: 'DOP' });
    expect(await fails(env, 'mark_fixed_paid', { name: 'Netflix' })).toContain('matches several fixed expenses for Frank in October 2026: Netflix, netflix.');
  });

  it('nombre que no coincide con ninguno: error de la herramienta con los nombres del mes', async () => {
    const { env, sqlite } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'Gimnasio' })).toBe(
      `No fixed expense for Frank in October 2026 matches "Gimnasio". Fixed expenses in October 2026: ${FIXED_NAMES}.`,
    );
    // Los nombres no se traducen: "Luz" no es "Electricity".
    expect(await fails(env, 'mark_fixed_paid', { name: 'Luz' })).toContain('No fixed expense for Frank in October 2026 matches "Luz".');
    expect(await fails(env, 'mark_fixed_paid', { name: '´' })).toContain('No fixed expense for Frank in October 2026 matches');
    const paid = sqlite.sqlite.prepare("SELECT COUNT(*) AS n FROM fixed_expenses WHERE user_id = 'frank' AND month_key = '2026-10' AND paid = 1").get();
    expect(paid?.n).toBe(6);
  });

  it('mes cerrado: no se puede cambiar, pero sí confirmar lo que ya estaba', async () => {
    const { env, db } = await seeded();
    expect(await fails(env, 'mark_fixed_paid', { name: 'Electricity', month: '2026-08', paid: false })).toBe(
      'August 2026 is closed: it is read-only. Reopen it to make changes.',
    );
    expect(await paidOf(db, 'Electricity', '2026-08')).toBe(true);

    const same = await call(env, 'mark_fixed_paid', { name: 'Electricity', month: '2026-08' });
    expect(same.isError).toBe(false);
    expect(same.text).toContain('Electricity was already paid for Frank in August 2026: nothing was changed.');
  });

  it('usa el mes en curso de la aplicación si el del calendario aún no existe', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'mark_fixed_paid', { name: 'Smartfit' }, new Date('2026-11-02T16:00:00Z'));
    expect(r.text).toContain('Paid for Frank: Smartfit · 1,550.00 DOP · October 2026 · paid from DR account.');
    expect(await paidOf(db, 'Smartfit')).toBe(true);
  });

  it('si el mes del calendario se cerró antes de tiempo, marca el gasto del mes siguiente', async () => {
    const { env, db } = await seeded();
    await closeMonth(db, F, '2026-10', {}, NOW);
    const r = await call(env, 'mark_fixed_paid', { name: 'Electricity' });
    expect(r.text).toBe(
      'Paid for Frank: Electricity · 1,337.15 DOP · November 2026 · paid from DR account. Monthly expenses: 1 of 11 paid · Fixed pending: 40,688.42 DOP. Used so far: 1,337.15 of 70,000 DOP. DR account balance: 219,304.78 DOP.',
    );
    expect(await paidOf(db, 'Electricity', '2026-11')).toBe(true);
  });

  it('mes que no existe, sin gastos fijos o argumentos inválidos: error de la herramienta', async () => {
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

  it('no toca nada más que `paid`', async () => {
    const { env, db } = await seeded();
    const before = await loadState(db, F);
    await call(env, 'mark_fixed_paid', { name: 'Cluely' });
    const after = await loadState(db, F);
    const expected = structuredClone(before);
    expected.months['2026-10']!.fixed.find((f) => f.name === 'Cluely')!.paid = true;
    expect(after).toEqual(expected);
  });
});

describe('add_transaction: cuentas y monedas', () => {
  it('con `account` sale de esa cuenta, en su moneda si no se dice otra, y dice su saldo nuevo', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Netflix', amount: 20, account: 'US account', category: 'Subscriptions' });
    expect(r.text).toBe(
      'Recorded for Frank: Netflix · 20.00 USD (1,175.20 DOP) · Subscriptions · Debit card · 2026-10-07 (October 2026) · paid from US account. Used so far: 50,324.91 of 70,000 DOP. US account balance: 13,462.00 USD.',
    );
    expect(r.data!.transaction).toMatchObject({ amount: 20, cur: 'USD', accountId: 'us' });
    expect(r.data!.account).toEqual({ id: 'us', name: 'US account', currency: 'USD', balance: await balanceOf(db, 'us') });
    expect(r.data!.account.balance).toBeCloseTo(13462, 8);
    // La cuenta en pesos no se movió.
    expect(await balanceOf(db, 'dr')).toBeCloseTo(220641.93, 6);
  });

  it('la cuenta se reconoce por su id, por su nombre sin mayúsculas ni acentos, o por un comienzo que sea de una sola', async () => {
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

  it('una cuenta que no existe o un nombre ambiguo: error de la herramienta que nombra las cuentas, sin guardar nada', async () => {
    const { env, db, sqlite } = await seeded();
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Banco Popular' })).toBe(
      'Invalid data: account: unknown account "Banco Popular" (accounts: US account, DR account)',
    );
    // Parte del nombre que no es su comienzo no vale: "account" está en las dos.
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'account' })).toContain('unknown account "account"');

    await createAccount(db, F, { name: 'Savings USD', currency: 'USD' });
    await createAccount(db, F, { name: 'Savings DOP', currency: 'DOP' });
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'savings' })).toBe(
      'Invalid data: account: "savings" matches several accounts; use the full name of one of: US account, DR account, Savings USD, Savings DOP',
    );
    expect((await call(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'savings d' })).data!.account.name).toBe('Savings DOP');

    // Una cuenta oculta no se ofrece entre las válidas.
    const hidden = (await loadState(db, F)).accounts.find((a) => a.name === 'Savings USD')!;
    await patchAccount(db, F, hidden.id, { hidden: true });
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Nada' })).toBe(
      'Invalid data: account: unknown account "Nada" (accounts: US account, DR account, Savings DOP)',
    );
    // La cuenta de otro usuario no existe para este; una que no se reconoce no crea el mes de la fecha.
    expect(await fails(env, 'add_transaction', { description: 'Uber', amount: 850, account: 'Nada', date: '2026-11-03' })).toContain('unknown account');
    expect(count(sqlite, 'transactions', F)).toBe(28);
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('sin `account` sale de la cuenta por defecto del usuario, que se cambia en los ajustes', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { defaultAccountId: 'us' });
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 15 });
    // Y sin `currency`, en la moneda de esa cuenta.
    expect(r.text).toBe(
      'Recorded for Frank: Uber · 15.00 USD (881.40 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from US account. Used so far: 50,031.11 of 70,000 DOP. US account balance: 13,467.00 USD.',
    );
    expect(r.data!.transaction).toMatchObject({ cur: 'USD', accountId: 'us' });
  });

  it('un monto en liras se guarda en liras y resta de la cuenta convertido con la tasa del mes', async () => {
    const { env, db } = await seeded();
    await setMonthRate(db, F, '2026-10', { from: 'TRY', to: 'DOP', rate: 1.5, date: '2026-10-01' });
    const r = await call(env, 'add_transaction', { description: 'Çay', amount: 500, currency: 'TRY' });
    expect(r.text).toBe(
      'Recorded for Frank: Çay · 500.00 TRY (750.00 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account (750.00 DOP). Used so far: 49,899.71 of 70,000 DOP. DR account balance: 219,891.93 DOP.',
    );
    // Lo guardado es lo que dijo la persona, sin convertir.
    expect(r.data!.transaction).toMatchObject({ amount: 500, cur: 'TRY', accountId: 'dr' });
    expect((await getMonth(db, F, '2026-10'))!.tx.at(-1)).toMatchObject({ amount: 500, cur: 'TRY' });
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
    expect(r.data!.account.balance).toBeCloseTo(220641.93 - 750, 6);
  });

  it('si nadie ha puesto la tasa de esa moneda, convierte con el valor de respaldo y avisa de que es aproximado', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transaction', { description: 'Çay', amount: 500, currency: 'TRY' });
    // 1 USD = 42 TRY de respaldo y 58.76 DOP: 500 TRY = 699.52 DOP.
    expect(r.text).toBe(
      'Recorded for Frank: Çay · 500.00 TRY (699.52 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account (699.52 DOP). Used so far: 49,849.23 of 70,000 DOP. DR account balance: 219,942.41 DOP. Note: the rate TRY to DOP (1.40) is a default value, not set yet, so the converted amounts are only approximate.',
    );
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
    // Con las monedas de siempre no hay nada que avisar.
    expect((await call(env, 'add_transaction', { description: 'Uber', amount: 12, currency: 'USD' })).text).not.toContain('Note:');
  });

  it('una cuenta en liras: el gasto sale en liras y su saldo se dice en liras', async () => {
    const { env, db } = await seeded();
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: 10000 });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    const r = await call(env, 'add_transaction', { description: 'Market', amount: 1200, account: 'TR account', category: 'Market' });
    // Sin tasa directa entre liras y pesos, se cruza por el dólar: 1,200 ÷ 40 × 58.76.
    expect(r.text).toBe(
      'Recorded for Frank: Market · 1,200.00 TRY (1,762.80 DOP) · Groceries · Debit card · 2026-10-07 (October 2026) · paid from TR account. Used so far: 50,912.51 of 70,000 DOP. TR account balance: 8,800.00 TRY.',
    );
    expect(r.data!.account).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', balance: 8800 });
    expect(await balanceOf(db, 'tr')).toBe(8800);

    // Dólares pagados desde la cuenta en liras: se guardan en dólares y a la cuenta le restan liras.
    const usd = await call(env, 'add_transaction', { description: 'Hotel', amount: 50, currency: 'USD', account: 'tr' });
    expect(usd.text).toContain('Hotel · 50.00 USD (2,938.00 DOP) · Food · Debit card · 2026-10-07 (October 2026) · paid from TR account (2,000.00 TRY).');
    expect(usd.text).toContain('TR account balance: 6,800.00 TRY.');
    expect(usd.data!.account.balance).toBe(await balanceOf(db, 'tr'));
  });

  it('las cifras del mes van en la moneda principal de cada usuario', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'DOP' });
    const r = await call(env, 'add_transaction', { description: 'Uber', amount: 587.6 });
    const c = monthCalc(await loadState(db, F), '2026-10');
    expect(c.main).toBe('USD');
    // El gasto sigue saliendo de la cuenta por defecto (la de pesos), en pesos; el usado se dice en dólares.
    expect(r.text).toBe(
      `Recorded for Frank: Uber · 587.60 DOP (10.00 USD) · Food · Debit card · 2026-10-07 (October 2026) · paid from DR account. Used so far: ${f2(c.used)} of 1,191 USD. DR account balance: 220,054.33 DOP.`,
    );
    expect(r.data!.month).toMatchObject({ currency: 'USD', used: c.used, budget: c.budget });
  });
});

describe('month_summary: presupuesto por cuenta, monedas y tasas', () => {
  it('el presupuesto se reparte por la cuenta de la que sale, cada parte en su moneda', async () => {
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

  it('el ingreso del mes es la suma de los ingresos con fecha en él', async () => {
    const { env } = await seeded();
    await call(env, 'add_income', { amount: 10000, description: 'Freelance' });
    await call(env, 'add_income', { amount: 100, currency: 'USD', date: '2026-09-30' });
    const r = await call(env, 'month_summary');
    // 5,800 USD × 58.76 + 10,000 DOP; el de septiembre no cuenta.
    expect(r.text).toContain('Month income: 350,808.00 DOP · Income − used: 301,658.29 DOP');
    expect(r.data!.income).toEqual({ count: 2, total: expect.closeTo(350808, 6), left: expect.closeTo(301658.29, 6) });
  });

  it('dice de dónde sale cada tasa cuando no es la del propio mes', async () => {
    const { env, db } = await seeded();
    const ratesOf = async (month?: string) => (await call(env, 'month_summary', month ? { month } : {})).text.split('\n').find((l) => l.startsWith('Month rates:'));

    // Una cuenta en liras y nadie ha escrito su tasa: valor de respaldo, dicho en claro.
    await createAccount(db, F, { id: 'tr', name: 'TR account', currency: 'TRY', opening: 4200 });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.40 (default value, not set yet)');
    const fallback = await call(env, 'month_summary');
    expect(fallback.data!.rates[1]).toEqual({ from: 'TRY', to: 'DOP', rate: expect.closeTo(58.76 / 42, 10), source: 'default', monthKey: null, date: null, note: 'default value, not set yet' });
    expect(fallback.text).toContain('TR account 4,200.00 TRY (5,876.00 DOP)');

    // Con la tasa dólar → lira del mes, la de liras a pesos se cruza por el dólar.
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'TRY', rate: 40, date: '2026-10-01' });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.47 (crossed through USD)');

    // Escrita para el mes, en cualquiera de los dos sentidos.
    await setMonthRate(db, F, '2026-10', { from: 'DOP', to: 'TRY', rate: 0.8, date: '2026-10-01' });
    expect(await ratesOf()).toBe('Month rates: USD to DOP: 58.76 (typed on 2026-10-06); TRY to DOP: 1.25 (typed on 2026-10-01)');

    // Noviembre no tiene tasas propias: siguen vigentes las últimas escritas en octubre, y dice de cuándo son.
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    expect(await ratesOf('2026-11')).toBe(
      'Month rates: USD to DOP: 58.76 (typed on 2026-10-06, still in effect); TRY to DOP: 1.25 (typed on 2026-10-01, still in effect)',
    );
    // Agosto es anterior a todo eso: su tasa del dólar sale de sus envíos y para la lira solo queda el valor de respaldo.
    expect(await ratesOf('2026-08')).toBe("Month rates: USD to DOP: 58.18 (from this month's transfers); TRY to DOP: 1.40 (default value, not set yet)");
  });

  it('todo va en la moneda principal del usuario, con su código, y la segunda entre paréntesis', async () => {
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
    // La historia va en la moneda de cada cuenta.
    expect(lines[2]).toBe('Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair)');
    expect(lines[3]).toMatch(/^Leftover of September 2026: [\d,.]+ TRY, not added to this month's budget\.$/);
    expect(lines[4]).toBe(`Used so far: ${f2(c.used)} TRY (836.45 USD)`);
    expect(lines[5]).toBe(`Available: ${f2(c.avail)} TRY`);
    expect(lines).toContain(`Transactions: 7 (${f2(c.varSpent)} TRY)`);
    expect(lines).toContain(`Month income: 232,000.00 TRY · Income − used: ${f2(c.incomeLeft)} TRY`);
    expect(lines).toContain(
      `Account balances at the end of October 2026: US account 13,482.00 USD (539,280.00 TRY); DR account 220,641.93 DOP (${f2(b.accounts[1]!.inMain)} TRY); TR account 4,000.00 TRY · Total money: ${f2(b.totalMain)} TRY (${f2(b.totalSecond)} USD)`,
    );
    // Cada tasa se lee en el sentido en que vale más de 1: "TRY to DOP: 1.47", no "DOP to TRY: 0.68".
    expect(lines).toContain('Month rates: TRY to DOP: 1.47 (crossed through USD); USD to TRY: 40.00 (typed on 2026-10-01)');
    expect(r.text).toContain('Still to pay: Google One 121.56 DOP (82.75 TRY), day 16;');
    expect(r.data).toMatchObject({ currency: 'TRY', secondCurrency: 'USD', budget: c.budget, used: c.used, usedSecond: c.usedSecond, totalMoney: { main: b.totalMain, second: b.totalSecond } });

    // Y las transacciones, igual.
    const list = (await call(env, 'list_transactions', { limit: 1 })).text.split('\n');
    expect(list[0]).toBe(`Frank · October 2026: 7 transactions · ${f2(c.varSpent)} TRY in total. Showing the most recent one.`);
    expect(list[1]).toBe('2026-10-07 · Coffee · Starbucks Ágora · 385.00 DOP (262.08 TRY) · Food · Debit card · DR account');
  });

  it('las cuentas ocultas no salen en los saldos ni cuentan en el total', async () => {
    const { env, db } = await seeded();
    await patchAccount(db, F, 'us', { hidden: true });
    const r = await call(env, 'month_summary');
    expect(r.text).toContain('Account balances at the end of October 2026: DR account 220,641.93 DOP · Total money: 220,641.93 DOP (3,754.97 USD)');
    expect(r.data!.accounts.map((a: { id: string }) => a.id)).toEqual(['dr']);
  });
});

describe('add_income', () => {
  it('«me pagaron 2,500 por un trabajo»: entra a la cuenta por defecto, en su moneda, y dice el saldo y el ingreso del mes', async () => {
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
    // Un ingreso no es un gasto ni toca el mes: solo hay una fila más en incomes.
    expect(count(sqlite, 'incomes', F)).toBe(4);
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect((await call(env, 'month_summary')).data).toMatchObject({ used: expect.closeTo(49149.71, 6), income: { count: 2 } });
  });

  it('con `account` entra a esa cuenta, en su moneda; la fecha y la descripción son opcionales', async () => {
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

  it('en la moneda que diga la persona: se guarda así y a la cuenta entra convertido con la tasa del mes', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 100, currency: 'USD', description: 'Propina' });
    expect(r.text).toBe(
      'Income recorded for Frank: Propina · 100.00 USD (5,876.00 DOP) · into DR account (5,876.00 DOP) · 2026-10-07 (October 2026). DR account balance: 226,517.93 DOP. Income in October 2026 so far: 346,684.00 DOP.',
    );
    expect(r.data!.income).toMatchObject({ amount: 100, cur: 'USD', accountId: 'dr' });
    expect(r.data!.account.balance).toBe(await balanceOf(db, 'dr'));
  });

  it('un ingreso en liras, a una cuenta en liras o a otra', async () => {
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

  it('si nadie ha puesto la tasa de esa moneda, avisa de que lo convertido es aproximado', async () => {
    const { env } = await seeded();
    const r = await call(env, 'add_income', { amount: 1000, currency: 'TRY' });
    expect(r.text).toBe(
      'Income recorded for Frank: 1,000.00 TRY (1,399.05 DOP) · into DR account (1,399.05 DOP) · 2026-10-07 (October 2026). DR account balance: 222,040.98 DOP. Income in October 2026 so far: 342,207.05 DOP. Note: the rate TRY to DOP (1.40) is a default value, not set yet, so the converted amounts are only approximate.',
    );
  });

  it('no pertenece a un mes: se puede registrar en uno cerrado o en uno que aún no existe, sin crearlo', async () => {
    const { env, db, sqlite } = await seeded();
    const closed = await call(env, 'add_income', { amount: 1000, date: '2026-08-15', description: 'Atrasado' });
    expect(closed.isError).toBe(false);
    // Agosto convierte con su propia tasa; el saldo que dice es el de ahora.
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

  it('una fecha lejana a hoy se rechaza: un año equivocado movería un saldo sin que nadie lo vea', async () => {
    const { env, sqlite } = await seeded();
    for (const date of ['2025-10-07', '2027-10-07', '2026-03-31', '2026-12-01']) {
      expect(await fails(env, 'add_income', { amount: 100, date }), date).toContain('is far from today (2026-10-07)');
    }
    expect(count(sqlite, 'incomes', F)).toBe(3);
  });

  it('quien nunca abrió la web recibe sus cuentas iniciales y el ingreso entra a la de por defecto', async () => {
    const { env, db, sqlite } = makeEnv();
    const r = await callRaw(env, 'add_income', { user: E, amount: 100 });
    expect(r.text).toBe('Income recorded for Eda: 100.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: 100.00 DOP. Income in October 2026 so far: 100.00 DOP.');
    expect(r.data).toMatchObject({ user: EDA, account: { id: 'dr', balance: 100 } });
    expect((await loadState(db, E)).accounts.map((a) => a.name)).toEqual(['US account', 'DR account']);
    expect(count(sqlite, 'months')).toBe(0);
    expect(count(sqlite, 'incomes', F)).toBe(0);
    expect(count(sqlite, 'accounts', F)).toBe(0);
  });

  it('cuenta desconocida o ambigua, o argumentos inválidos: error de la herramienta con el motivo, sin guardar nada', async () => {
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

  it('si el ingreso se guardó pero no se pudo leer el saldo, confirma igual (para que no se repita)', async () => {
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

describe('presupuesto con historia, sobrante e ingresos que lo suben', () => {
  it('add_income con add_to_budget: el ingreso entra a la cuenta y además sube el presupuesto del mes, y lo dice', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 2500, description: 'Bonus', add_to_budget: true });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      'Income recorded for Frank: Bonus · 2,500.00 DOP · into DR account · 2026-10-07 (October 2026). DR account balance: 223,141.93 DOP. Income in October 2026 so far: 343,308.00 DOP. It was also added to the budget of October 2026, now 72,500.00 DOP.',
    );
    expect(r.data!.income).toMatchObject({ desc: 'Bonus', amount: 2500, cur: 'DOP', accountId: 'dr', budget: true });
    expect(r.data!.month).toMatchObject({ key: '2026-10', budget: 72500 });
    expect((await listIncomes(db, F)).at(-1)!.budget).toBe(true);
    // No se escribe en el registro: lo suma el cálculo.
    expect((await getMonth(db, F, '2026-10'))!.budgetLog).toHaveLength(2);
    const c = monthCalc(await loadState(db, F), '2026-10');
    expect([c.budget, f2(c.avail)]).toEqual([72500, '23,350.29']);

    // Sin pedirlo (o con false), el presupuesto no se mueve y la respuesta no lo menciona.
    const plain = await call(env, 'add_income', { amount: 100, add_to_budget: false });
    expect(plain.text).not.toContain('budget');
    expect(plain.data!.income.budget).toBe(false);
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBe(72500);
    expect(await fails(env, 'add_income', { amount: 100, add_to_budget: 'yes' })).toBe('Invalid data: add_to_budget: must be true or false');
  });

  it('add_transfer con fee: la comisión sale de la cuenta de origen, cuenta como una transacción del mes y month_summary la enseña', async () => {
    const { env, db } = await seeded();
    const before = monthCalc(await loadState(db, F), '2026-10');
    const us = balances(await loadState(db, F), '2026-10').accounts.find((a) => a.account.id === 'us')!.balance;
    const r = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 100, rate: 59, fee: 2.99 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('The fee of 2.99 USD also left US account and counts as a transaction of October 2026 (category Other).');
    expect(r.data!.transfer).toMatchObject({ amount: 100, fee: 2.99, budget: false });
    expect(r.data!.fee).toEqual({ amount: 2.99, currency: 'USD' });
    // Saldo: lo enviado y la comisión, sin convertir.
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

  it('add_transfer con move_budget: el presupuesto del mes pasa de la cuenta de origen a la de destino, y month_summary lo cuenta', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 100, rate: 59, move_budget: true });
    expect(r.isError).toBe(false);
    // −100 USD (5,876 DOP a la tasa del mes) y +5,900 DOP: el total solo cambia por la diferencia de tasa.
    expect(r.text).toContain(
      "Budget of October 2026 moved: 100.00 USD less in US account, 5,900.00 DOP more in DR account; the month's budget is now 70,024.00 DOP.",
    );
    expect(r.data!.transfer).toMatchObject({ amount: 100, rate: 59, budget: true, fee: 0 });
    expect(r.data!.month).toEqual({ key: '2026-10', label: 'October 2026', currency: 'DOP', budget: 70024 });
    // No se escribe en el registro: lo hace el cálculo.
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
    // El nombre de antes se sigue aceptando, con el mismo significado; si vienen los dos, manda move_budget.
    const old = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, add_to_budget: true });
    expect(old.data!.transfer.budget).toBe(true);
    const both = await call(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, move_budget: false, add_to_budget: true });
    expect(both.data!.transfer.budget).toBe(false);
    expect(await fails(env, 'add_transfer', { from_account: 'US account', to_account: 'DR account', amount: 1, add_to_budget: 'yes' })).toBe(
      'Invalid data: add_to_budget: must be true or false',
    );
  });

  it('add_income con add_to_budget en otra moneda: sube lo que vale en la moneda de la cuenta, a la tasa de su fecha', async () => {
    const { env, db } = await seeded();
    // 100 USD a la DR account el día 7: 5,876 DOP.
    const r = await call(env, 'add_income', { amount: 100, currency: 'USD', account: 'DR account', description: 'Gig', add_to_budget: true });
    expect(r.text).toContain('Gig · 100.00 USD (5,876.00 DOP) · into DR account (5,876.00 DOP)');
    expect(r.text).toContain('It was also added to the budget of October 2026, now 75,876.00 DOP.');
    // Se escribe 60 desde el día 8: lo del día 7 no cambia.
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    expect(monthCalc(await loadState(db, F), '2026-10').budget).toBeCloseTo(75876, 8);
  });

  it('add_income con add_to_budget en un mes que todavía no existe: queda marcado y lo dice', async () => {
    const { env, db } = await seeded();
    const r = await call(env, 'add_income', { amount: 1000, date: '2026-11-02', add_to_budget: true });
    expect(r.text).toContain('It is marked to raise the budget of November 2026, a month that does not exist yet: it will count when the month is created.');
    expect(r.data!.month).toMatchObject({ key: '2026-11', budget: null });
    expect(await getMonth(db, F, '2026-11')).toBeNull();
  });

  it('month_summary cuenta la historia del presupuesto: inicial, ajustes, sobrante e ingresos, por fecha', async () => {
    const { env, db } = await seeded();
    await addBudgetEntry(db, F, '2026-10', { accountId: 'dr', amount: -1200, date: '2026-10-06', note: 'Less eating out' }, NOW);
    await addLeftover(db, F, '2026-10', NOW);
    await call(env, 'add_income', { amount: 100, currency: 'USD', account: 'DR account', description: 'Gig', date: '2026-10-03', add_to_budget: true });

    const r = await call(env, 'month_summary');
    const lines = r.text.split('\n');
    // 65,000 + 5,876 + 5,000 − 1,200 + 3,363.46 (lo que sobró en septiembre).
    expect(lines[1]).toBe('Budget: 78,039.46 DOP (1,328.11 USD) · by account: DR account 78,039.46 DOP');
    expect(lines[2]).toBe(
      'Budget history: 2026-10-01 initial DR account +65,000.00 DOP; 2026-10-03 income DR account +5,876.00 DOP (Gig); 2026-10-05 adjustment DR account +5,000.00 DOP (Car repair); 2026-10-06 adjustment DR account -1,200.00 DOP (Less eating out); 2026-10-07 leftover DR account +3,363.46 DOP',
    );
    // Ya sumado, el sobrante no se vuelve a ofrecer.
    expect(r.text).not.toContain('Leftover of');
    expect(lines[3]).toBe('Used so far: 49,149.71 DOP (836.45 USD)');
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

  it('month_summary: el primer mes no tiene sobrante que ofrecer; uno negativo se dice en negativo', async () => {
    const { env, db } = await seeded();
    const august = await call(env, 'month_summary', { month: '2026-08' });
    expect(august.text).not.toContain('Leftover');
    expect(august.data!.leftover).toEqual({ previousMonth: null, amount: null, added: false });
    expect(august.text).toContain('Budget history: 2026-08-01 initial DR account +70,000.00 DOP');

    // Un gasto de 30,000 en octubre lo deja en −9,149.71 disponibles: es lo que hereda noviembre.
    await call(env, 'add_transaction', { description: 'Roof', amount: 30000 });
    await call(env, 'add_transaction', { description: 'Regalo', amount: 10, date: '2026-11-02' });
    const november = await call(env, 'month_summary', { month: '2026-11' });
    expect(november.text).toContain("Leftover of October 2026: -9,149.71 DOP, not added to this month's budget.");
    expect((await getMonth(db, F, '2026-11'))!.budgets).toEqual({ dr: 70000 });
  });

  it('month_summary: las tasas llevan su fecha, y cada importe va con la vigente en la suya', async () => {
    const { env, db } = await seeded();
    // 10 USD pagados desde la cuenta en DOP el día 2 (a 58.76); el día 8 se escribe 60.
    await call(env, 'add_transaction', { description: 'Domain', amount: 10, currency: 'USD', date: '2026-10-02' });
    await setMonthRate(db, F, '2026-10', { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-08' });
    const r = await call(env, 'month_summary', {}, new Date('2026-10-08T16:00:00Z'));
    expect(r.text).toContain('Month rates: USD to DOP: 60.00 (typed on 2026-10-08)');
    expect(r.text).toContain('Rates typed in October 2026: 1 USD = 58.76 DOP from 2026-10-01; 1 USD = 58.76 DOP from 2026-10-06; 1 USD = 60.00 DOP from 2026-10-08');
    expect(r.data!.rates).toEqual([{ from: 'USD', to: 'DOP', rate: 60, source: 'month', monthKey: '2026-10', date: '2026-10-08', note: 'typed on 2026-10-08' }]);
    // La transacción del día 2 sigue valiendo 587.60; el fijo en USD (del mes entero) ya va a 60.
    expect(r.text).toContain('Transactions: 8 (11,432.60 DOP)');
    expect(r.data!.fixed.paid).toBeCloseTo(32076.15 + 106 * 60, 6);
    const list = await call(env, 'list_transactions', { limit: 20 });
    expect(list.text).toContain('2026-10-02 · Domain · 10.00 USD (587.60 DOP) · Food · Debit card · DR account');
    // Una del día 8 se registra a 60 y lo dice.
    const today = await call(env, 'add_transaction', { description: 'Hosting', amount: 10, currency: 'USD' }, new Date('2026-10-08T16:00:00Z'));
    expect(today.text).toContain('Hosting · 10.00 USD (600.00 DOP) · Food · Debit card · 2026-10-08 (October 2026) · paid from DR account (600.00 DOP)');
  });
});

describe('list_accounts', () => {
  it('lista las cuentas visibles con su moneda y su saldo, cuál es la de por defecto y el total en las dos monedas', async () => {
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

    // Las cifras son las de shared/calc.ts.
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
    // Es de solo lectura.
    expect(await loadState(db, F)).toEqual(await loadState(db, E));
    expect(count(sqlite, 'months', F)).toBe(3);
  });

  it('los saldos siguen a cada registro: gasto, ingreso, envío y gasto fijo pagado', async () => {
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

    // Lo que tiene fecha del mes siguiente ya cuenta: el saldo es el de ahora.
    await call(env, 'add_transaction', { description: 'Regalo', amount: 1500, date: '2026-11-03' });
    const next = await call(env, 'list_accounts');
    expect(next.data).toMatchObject({ asOf: '2026-11' });
    expect(next.data!.accounts[1].balance).toBe(await balanceOf(db, 'dr', F, '2026-11'));
    expect(next.text).toContain('Rates used (November 2026): USD to DOP: 58.76 (typed on 2026-10-06, still in effect)');
  });

  it('cuentas en tres monedas, la de por defecto que eligió el usuario, y las ocultas fuera de la lista y del total', async () => {
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
      // 8,400 TRY ÷ 42 × 58.76, con la tasa de respaldo: el aviso va en la línea de las tasas.
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

    // Si la cuenta por defecto se oculta, pasa a ser la primera visible en la moneda principal.
    await patchAccount(db, F, 'us', { hidden: true });
    const hidden = await call(env, 'list_accounts');
    expect(hidden.text).toContain('DR account · DOP · balance 220,641.93 DOP · default account');
    expect(hidden.data).toMatchObject({ defaultAccountId: 'dr', hiddenCount: 2 });
  });

  it('el total va en la moneda principal y en la segunda de cada usuario', async () => {
    const { env, db } = await seeded();
    await updateSettings(db, F, { mainCurrency: 'USD', secondCurrency: 'TRY' });
    const b = balances(await loadState(db, F), '2026-10');
    const r = await call(env, 'list_accounts');
    expect(r.text.split('\n')).toEqual([
      'Frank · 2 accounts · main currency USD, second currency TRY',
      // Con dólares como moneda principal, la cuenta por defecto pasa a ser la primera en dólares… salvo que haya una elegida.
      'US account · USD · balance 13,482.00 USD',
      'DR account · DOP · balance 220,641.93 DOP (3,754.97 USD) · default account',
      `Total money: 17,236.97 USD (${f2(b.totalSecond)} TRY)`,
      'Rates used (October 2026): USD to DOP: 58.76 (typed on 2026-10-06); USD to TRY: 42.00 (default value, not set yet)',
      'Today is 2026-10-07.',
    ]);
    expect(b.totalSecond).toBeCloseTo(17236.968 * 42, 0);
    expect(r.data).toMatchObject({ mainCurrency: 'USD', secondCurrency: 'TRY', totalMoney: { main: b.totalMain, second: b.totalSecond } });
  });

  it('quien nunca abrió la web ve sus cuentas iniciales, en cero, sin que se cree ningún mes', async () => {
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
    // Repetirla no duplica nada.
    await callRaw(env, 'list_accounts', { user: E });
    expect(count(sqlite, 'accounts', E)).toBe(2);
  });

  it('no admite argumentos propios', async () => {
    const { env } = await seeded();
    expect(await fails(env, 'list_accounts', { month: '2026-10' })).toContain('month');
    expect(await fails(env, 'list_accounts', { account: 'us' })).toContain('Invalid data');
  });
});
