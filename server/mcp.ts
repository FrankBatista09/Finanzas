// Servidor MCP remoto (Model Context Protocol) en /mcp: es lo que permite decirle a Claude
// "gasté 850 en Uber hoy con tarjeta" y que quede registrado.
//
// Transporte Streamable HTTP sin estado y sin SDK: cada POST trae un mensaje JSON-RPC 2.0 y la respuesta va
// como JSON en esa misma petición. No hay sesiones (no se emite Mcp-Session-Id) ni flujo SSE, así que GET y
// DELETE responden 405. Toda petición exige Authorization: Bearer <API_TOKEN>.
//
// Habla las dos épocas del protocolo en el mismo endpoint:
//   · con handshake (2025-11-25 y anteriores): initialize negocia la versión; después ping, tools/list y
//     tools/call, sueltos o en un lote;
//   · sin handshake (2026-07-28): cada petición declara su versión en la cabecera MCP-Protocol-Version y en
//     `_meta`, repite su método en Mcp-Method, y el servidor se describe con server/discover.
// Como aquí no se guarda nada entre peticiones, la época se decide en cada una por lo que trae.
//
// De quién son los datos: cada persona tiene sus finanzas aparte (USERS, shared/users.ts) y el Bearer es uno
// solo para todas, así que cada herramienta recibe `user`. Es obligatorio cuando hay más de un usuario
// configurado: el modelo lo saca de la conversación o de las instrucciones del proyecto y, si no lo sabe,
// tiene que preguntar. Como la lista sale del entorno, tools/list y las instrucciones se arman en cada petición.
//
// Dinero: cada usuario tiene sus cuentas, su moneda principal y su segunda moneda. Todo lo que se registra
// mueve el saldo de una cuenta (un gasto resta de la cuenta de la que se paga, un ingreso suma, un envío pasa
// dinero de una a otra), así que cada confirmación dice de qué cuenta y cómo quedó su saldo. Las cifras del mes
// van en la moneda principal del usuario, con su código. Todas las cuentas salen de shared/calc.ts.
//
// Idioma: todo lo que este servidor le dice al modelo va en inglés (Claude ya le habla a cada persona en el
// suyo). Lo que dicta el usuario no se traduce; categorías y métodos se aceptan en cualquiera de los idiomas
// de la app y se guardan con su nombre canónico (shared/i18n.ts).
//
// Los fallos de dominio y de validación de una herramienta (mes cerrado, fecha inválida, usuario que falta,
// gasto fijo que no existe) son un resultado normal con isError: true, para que el modelo los lea y se
// corrija; los errores JSON-RPC quedan para los fallos del protocolo.

import { z } from 'zod';
import {
  accountsById,
  balances,
  budgetHistory,
  convert,
  currentKey,
  defaultAccount,
  incomeInMonth,
  leftoverFor,
  monthCalc,
  rateFor,
  sortedKeys,
  transferReceived,
} from '../shared/calc';
import type { AccountBalance, Balances, MonthCalc, RateInfo, RateSource } from '../shared/calc';
import { APP_NAME, CATS, METHODS, TIMEZONE, VIAS } from '../shared/constants';
import { f0, f2, fRate } from '../shared/format';
import { canonicalCat, canonicalMethod } from '../shared/i18n';
import { currentMonthKey, isISODate, isMonthKey, label, monthOf, monthSpan, todayISO } from '../shared/month';
import type { Account, AppState, AppUser, Currency, FixedExpense, ISODate, Month, MonthKey } from '../shared/types';
import { checkBearer } from './auth';
import { readLimitedBody } from './body';
import { createIncome, createTransfer, ensureMonth, getMonth, loadState, patchFixed, userAccounts, userState } from './db';
import type { Env } from './env';
import {
  ApiError,
  errorBody,
  INTERNAL_MESSAGE,
  invalidData,
  monthClosedError,
  noAccountsError,
  notFoundError,
  toApiError,
  validationError,
} from './errors';
import { ingestTransaction, matchAccount } from './ingest';
import { configuredUsers, userFromBody } from './users';
import { fixedPatchSchema, incomeCreateSchema, MAX_AMOUNT, MAX_LEN, parse, transferCreateSchema } from './validate';

/** Las monedas de la app, como las ve el modelo: siempre por su código. */
const CURRENCY_CODES = ['DOP', 'USD', 'TRY'] as const satisfies readonly Currency[];


// ── Protocolo ────────────────────────────────────────────────────────────────

/** Revisiones sin handshake: cada petición declara su versión y las capacidades del cliente. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
/** Revisiones con handshake `initialize`. */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Todas las revisiones de MCP que este servidor entiende, de la más nueva a la más vieja. */
export const PROTOCOL_VERSIONS = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** `version` es la de package.json (server/mcp.test.ts comprueba que no se desfasen). */
export const SERVER_INFO = { name: 'fe-finance', title: APP_NAME, version: '0.1.0' } as const;

/** Un mensaje MCP de este servidor ocupa unos cientos de bytes; el tope solo frena abusos. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Cada llamada a una herramienta son varias consultas a D1: un lote no puede multiplicarlas sin límite. */
export const MAX_BATCH = 20;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Códigos propios de MCP (2026-07-28). Un cliente que habla las dos épocas reconoce por ellos a un servidor
// sin handshake y corrige la petición en vez de volver a initialize.
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Claves de `_meta` que reserva el protocolo sin handshake. */
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

const CAPABILITIES = { tools: {} } as const;

/**
 * Pistas de caché de server/discover y tools/list (2026-07-28). La lista es la misma para cualquiera
 * ("public") y solo cambia con un despliegue (los usuarios que nombra salen de la variable USERS): cinco
 * minutos sin volver a pedirla es poco riesgo.
 */
const CACHE_HINTS = { ttlMs: 5 * 60 * 1000, cacheScope: 'public' } as const;

type JsonRpcId = string | number;

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

type Incoming =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification' }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null };

/**
 * Fallo del protocolo: se responde como error JSON-RPC con este código. `status` es el estado HTTP cuando la
 * petición viaja sola (en un lote la respuesta es siempre 200).
 */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly status: number = 200,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE, ...headers } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

function isSupported(version: string): boolean {
  return (PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isModern(version: string): boolean {
  return (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

function isLegacy(version: string): boolean {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** Lo que el cliente mandó y se devuelve en un mensaje de error: acotado, por si viene algo enorme. */
function quoted(value: string): string {
  return value.slice(0, 80);
}

function classify(msg: unknown): Incoming {
  if (!isRecord(msg)) return { kind: 'invalid', id: null };
  // MCP no admite id null: un id que no sea texto o número no identifica nada.
  const id = isId(msg.id) ? msg.id : null;
  if (msg.jsonrpc !== '2.0') return { kind: 'invalid', id };
  if ('method' in msg) {
    if (typeof msg.method !== 'string') return { kind: 'invalid', id };
    if (!('id' in msg)) return { kind: 'notification' };
    return id === null ? { kind: 'invalid', id } : { kind: 'request', id, method: msg.method, params: msg.params };
  }
  // Respuesta del cliente a una petición del servidor. Este servidor no hace peticiones: se acepta y se ignora.
  if (id !== null && ('result' in msg || 'error' in msg)) return { kind: 'response' };
  return { kind: 'invalid', id };
}

// ── Usuarios ─────────────────────────────────────────────────────────────────

/** "frank (Frank), eda (Eda)": el id es lo que va en `user`; el nombre, cómo se llama esa persona. */
function userList(users: readonly AppUser[]): string {
  return users.map((u) => `${u.id} (${u.name})`).join(', ');
}

/** La propiedad `user` del inputSchema de cada herramienta: sus valores son los usuarios configurados. */
function userProperty(users: readonly AppUser[]): Record<string, unknown> {
  const ids = users.map((u) => u.id);
  if (ids.length === 1) {
    return {
      type: 'string',
      enum: ids,
      default: ids[0],
      description: `Whose finances to act on. Only one user is configured, ${userList(users)}, so it can be omitted.`,
    };
  }
  return {
    type: 'string',
    enum: ids,
    description: `Whose finances to act on, by id: ${userList(users)}. Use the person named in the conversation or in the project instructions; if it is not clear who, ask instead of guessing.`,
  };
}

function userError(users: readonly AppUser[], problem: string): ApiError {
  const ask = users.length > 1 ? ' If it is not clear whose finances are meant, ask the person; do not guess.' : '';
  return validationError(invalidData(`user: ${problem}. Valid users: ${userList(users)}.${ask}`));
}

/**
 * De quién son las finanzas de una llamada. La regla es la de server/users.ts (el id, sin distinguir
 * mayúsculas; se puede omitir si solo hay un usuario configurado). Aquí cambia el mensaje: nombra a cada
 * usuario, para que el modelo sepa de quién es cada id y le pregunte a la persona en vez de probar con otro.
 */
function resolveUser(users: readonly AppUser[], value: unknown): AppUser {
  const given = value ?? undefined;
  if (given !== undefined && typeof given !== 'string') throw userError(users, 'must be text');
  try {
    return userFromBody(users, given);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    throw userError(users, given?.trim() ? `unknown user "${quoted(given.trim())}"` : 'is required');
  }
}

// ── Textos para el modelo ────────────────────────────────────────────────────

/** Las instrucciones nombran a los usuarios configurados: se arman en cada petición. */
function instructions(users: readonly AppUser[]): string {
  const who =
    users.length === 1
      ? `Users: only one user is configured, ${userList(users)}. Every tool takes \`user\`; with a single user it can be omitted.`
      : `Users: each person has completely separate finances (their own accounts, currencies, months, budget, monthly expenses, transactions, incomes and transfers). Configured users: ${userList(users)}. Every tool takes \`user\`, the id of the person whose finances to act on, and it is required. Use the person named in the conversation or in the project instructions. If it is not clear whose finances are meant, ask before calling a tool: never guess, and never record one person's expense under another person.`;
  return [
    `${APP_NAME}: personal finances. With these tools you record a person's expenses, incomes and transfers, and check how the month and the accounts are going.`,
    who,
    `Money: each person has their own accounts (a name and a currency: ${CURRENCY_CODES.join(', ')}) and their own main currency, in which budget and totals are shown. Nobody types a balance: every movement changes it. An expense is subtracted from the account it is paid from, which is the person's default account unless they name another one. An income adds to an account. A transfer moves money from one account to another. Call list_accounts when you need to know which accounts exist.`,
    'Language: these tools answer in English only; talk to each person in their own language. People may dictate in Spanish or Turkish: pass descriptions, places, notes, account names and names of fixed expenses exactly as they said them, without translating.',
    'Currency: when the person names a currency (dollars, pesos, lira), record the amount in the currency they said, even if it is not the currency of the account: the server converts with the rate in effect on the date of the record. If they name none, omit `currency` and the currency of the account is used. Never convert an amount yourself.',
    `Date: by default, today in ${TIMEZONE}. If the person gives no date or says "today", omit \`date\` and the server uses today's. Dates are YYYY-MM-DD and months are YYYY-MM. Each record goes to the month of its date. For relative dates ("yesterday", "on Friday") start from today's date as returned by month_summary or list_accounts.`,
    `Categories: ${CATS.join(', ')}. Always choose the one that best describes the expense; if none is given it is ${CATS[0]}.`,
    `Payment methods: ${METHODS.join(', ')}. If none is given it is ${METHODS[0]}.`,
    'Categories and payment methods are stored under these English names. Pass the English name; the Spanish or Turkish name ("Comida", "Yemek", "Tarjeta", "Kart") is also accepted and stored as the English one. A plain "card" ("tarjeta", "kart") is stored as Debit card; when the person says it was a credit card ("tarjeta de credito", "kredi karti"), pass Credit card.',
    `Transfers: \`via\` is the service used, as free text (${VIAS.join(', ')} or any other; ${VIAS[0]} by default). Between accounts of different currencies the rate is what arrives per unit sent (for example, the DOP received per USD).`,
    'Rates: each month has its own rates between currencies. When a tool says that a rate is a default value, nobody has set it yet: tell the person, because the converted amounts are only approximate until they type the rate of the month in the web app.',
    'Fixed expenses (the "Monthly expenses" list of the app): the same items every month (electricity, internet, subscriptions…). They are not recorded as transactions: mark them as paid with mark_fixed_paid.',
    'A closed month is read-only: it can be consulted, but it accepts no expenses, transfers or changes until the person reopens it in the web app. If a tool answers that the month is closed, tell the person; do not record it under another date.',
    'After recording something, confirm to the person what was recorded and for whom, with the amount, the account and its new balance, based on the text the tool returns.',
  ].join('\n');
}

const SEP = ' · ';

/** Cómo se le explica al modelo el mes por defecto (ver resolveMonth). */
const IN_PROGRESS = 'the month in progress (the calendar month or, if it does not exist yet or is already closed, the last open month)';

function money(amount: number, cur: Currency): string {
  return `${f2(amount)} ${cur}`;
}

/**
 * Un importe y, si está en otra moneda que `to`, también su equivalente: con la tasa vigente en `date` si la
 * fila tiene fecha propia, o con la última del mes `key` si no.
 */
function moneyIn(state: AppState, key: MonthKey, amount: number, cur: Currency, to: Currency, date?: ISODate): string {
  return cur === to ? money(amount, cur) : `${money(amount, cur)} (${money(convert(state, key, amount, cur, to, date), to)})`;
}

/** Un importe con su signo a la vista: "+5,000.00 DOP", "-1,200.00 DOP". */
function signed(amount: number, cur: Currency): string {
  return `${amount < 0 ? '-' : '+'}${money(Math.abs(amount), cur)}`;
}

function monthTitle(m: Pick<Month, 'key' | 'closed'>): string {
  return `${label(m.key)}${m.closed ? `${SEP}closed` : ''}`;
}

/** Encabezado de una consulta: de quién y de qué mes son las cifras. */
function heading(user: AppUser, m: Pick<Month, 'key' | 'closed'>): string {
  return `${user.name}${SEP}${monthTitle(m)}`;
}

function usedLine(c: MonthCalc): string {
  if (!(c.budget > 0)) return `Used so far: ${money(c.used, c.main)} (no budget set).`;
  const over = c.avail < 0 ? ` Over budget by ${money(-c.avail, c.main)}.` : '';
  return `Used so far: ${f2(c.used)} of ${f0(c.budget)} ${c.main}.${over}`;
}

function fixedLine(c: MonthCalc): string {
  return `Monthly expenses: ${c.paidCount} of ${c.fixedCount} paid${SEP}Fixed pending: ${money(c.pending, c.main)}.`;
}

/** Las cifras del mes van en la moneda principal del usuario: `currency` dice cuál. */
function monthStatus(c: MonthCalc) {
  return { key: c.key, label: label(c.key), closed: c.closed, currency: c.main, budget: c.budget, used: c.used, available: c.avail };
}

// ── Tasas ────────────────────────────────────────────────────────────────────

interface RateLine {
  from: Currency;
  to: Currency;
  /** 1 `from` = `rate` `to`. */
  rate: number;
  source: RateSource;
  /** Mes del que salió la tasa (shared/calc.ts RateInfo). */
  monthKey: MonthKey | null;
  /** Fecha desde la que vale, si es una tasa escrita a mano; null si salió de otro sitio. */
  date: ISODate | null;
  /** De dónde salió, dicho en claro: es lo que avisa de una tasa que no es la del mes. */
  note: string;
}

function rateNote(info: RateInfo, from: Currency, to: Currency): string {
  switch (info.source) {
    case 'same':
      return 'same currency';
    case 'month':
      return info.date ? `typed on ${info.date}` : 'typed for this month';
    case 'transfers':
      return "from this month's transfers";
    case 'cross':
      // Con tres monedas, la que no es ninguna de las dos.
      return `crossed through ${CURRENCY_CODES.find((c) => c !== from && c !== to) ?? 'another currency'}`;
    case 'previous':
      // Una escrita en un mes anterior sigue vigente hasta que se escriba otra.
      if (info.date) return `typed on ${info.date}, still in effect`;
      return info.monthKey ? `from ${label(info.monthKey)}` : 'from an earlier month';
    case 'default':
      return 'default value, not set yet';
  }
}

/**
 * La tasa entre dos monedas, en el sentido en que se lee (la que vale más primero: "USD to DOP: 58.76" y no
 * "DOP to USD: 0.02", que con dos decimales no dice nada). Sin `date`, la última del mes; con ella, la vigente ese día.
 */
function rateLine(state: AppState, key: MonthKey, a: Currency, b: Currency, date?: ISODate): RateLine {
  const direct = rateFor(state, key, a, b, date);
  const [from, to, info] = direct.rate >= 1 ? [a, b, direct] : [b, a, rateFor(state, key, b, a, date)];
  return { from, to, rate: info.rate, source: info.source, monthKey: info.monthKey, date: info.date, note: rateNote(info, from, to) };
}

function rateText(r: RateLine): string {
  return `${r.from} to ${r.to}: ${fRate(r.rate)} (${r.note})`;
}

/** Una tasa suelta, en el sentido en que se lee: "1 USD = 59.40 DOP" también para un envío de DOP a USD. */
function pairText(from: Currency, to: Currency, rate: number): string {
  return rate >= 1 || !(rate > 0) ? `1 ${from} = ${fRate(rate)} ${to}` : `1 ${to} = ${fRate(1 / rate)} ${from}`;
}

/**
 * Aviso de que lo convertido es aproximado: alguna de las conversiones de `cur` a las monedas de `to` en el
 * mes `key` sale del valor de respaldo, porque nadie ha escrito esa tasa. Una frase por par; ninguna si no pasa.
 */
function approxNotes(state: AppState, key: MonthKey, cur: Currency, to: readonly Currency[], date?: ISODate): string[] {
  return [...new Set(to)]
    .filter((other) => other !== cur)
    .map((other) => rateLine(state, key, cur, other, date))
    .filter((r) => r.source === 'default')
    .map((r) => `Note: the rate ${r.from} to ${r.to} (${fRate(r.rate)}) is a default value, not set yet, so the converted amounts are only approximate.`);
}

/** Las tasas con las que se lleva a la moneda principal cada una de las otras monedas de `used`. */
function ratesToMain(state: AppState, key: MonthKey, used: Iterable<Currency>): RateLine[] {
  const wanted = new Set(used);
  return CURRENCY_CODES.filter((c) => c !== state.mainCurrency && wanted.has(c)).map((c) => rateLine(state, key, c, state.mainCurrency));
}

// ── Reglas compartidas por las herramientas ──────────────────────────────────

/** Lo que comparten todos los mensajes de una petición HTTP. */
interface ServerContext {
  db: D1Database;
  now: Date;
  /** Los usuarios configurados (USERS), en su orden. */
  users: readonly AppUser[];
}

interface ToolContext {
  db: D1Database;
  now: Date;
  /** De quién son las finanzas de esta llamada, ya resuelto: todo lo que la herramienta lee o escribe es suyo. */
  user: AppUser;
}

/**
 * El mes sobre el que trabaja una herramienta. Sin `requested` es el mes en curso: el del calendario (en la
 * zona del usuario) mientras exista y esté abierto; si no, el mes en curso de la aplicación (el último abierto).
 * Cubre los primeros días de un mes cuando aún no se ha cerrado el anterior, y los últimos cuando el mes
 * se cerró antes de tiempo y ya se trabaja en el siguiente.
 */
function resolveMonth(state: AppState, requested: MonthKey | undefined, { now, user }: Pick<ToolContext, 'now' | 'user'>): Month {
  const calendar = currentMonthKey(now);
  const inCalendar = state.months[calendar];
  const key = requested ?? (inCalendar && !inCalendar.closed ? calendar : currentKey(state));
  const month = key ? state.months[key] : undefined;
  if (month) return month;

  const keys = sortedKeys(state);
  if (keys.length === 0) {
    throw notFoundError(`${user.name} has no months yet. Record a transaction to create the current month.`);
  }
  // Con la clave, que es lo que hay que mandar en `month`.
  const known = keys.slice(-12).map((k) => `${k}${state.months[k]!.closed ? ' (closed)' : ''}`);
  throw notFoundError(`${label(key ?? calendar)} does not exist for ${user.name}. Existing months: ${known.join(', ')}.`);
}

/** Meses hacia atrás y hacia delante de hoy en los que una herramienta acepta una fecha de un mes que no existe. */
const CREATE_MONTHS_BACK = 6;
const CREATE_MONTHS_AHEAD = 1;

/**
 * Registrar algo crea el mes de su fecha si no existe. Un año mal puesto por el modelo dejaría un mes fantasma
 * (o un ingreso que nadie ve y que mueve un saldo): por eso solo se aceptan fechas de meses cercanos a hoy.
 * A un mes que ya existe se puede escribir sea cual sea su fecha.
 */
async function assertReachable({ db, now, user }: ToolContext, date: ISODate): Promise<void> {
  const key = monthOf(date);
  const offset = monthSpan(currentMonthKey(now), key) - 1;
  if (offset >= -CREATE_MONTHS_BACK && offset <= CREATE_MONTHS_AHEAD) return;
  if (await getMonth(db, user.id, key)) return;
  throw validationError(
    `The date ${date} falls in ${label(key)}, a month that does not exist for ${user.name} and is far from today (${todayISO(now)}). Check the year of the date.`,
  );
}

/**
 * Lo que una confirmación cuenta después de escribir (el usado del mes, el saldo nuevo de la cuenta). Es un
 * extra: si no se puede leer o calcular, la confirmación sale sin él. Responder con un error haría que el
 * modelo repitiera un registro que ya se guardó.
 */
async function afterWrite<T>({ db, user }: ToolContext, derive: (state: AppState) => T): Promise<T | null> {
  try {
    return derive(await loadState(db, user.id));
  } catch (err) {
    console.error('[mcp] no se pudo leer el estado tras guardar', err);
    return null;
  }
}

/**
 * Los saldos "de ahora": al final del mes más reciente entre los registrados, el del calendario y los que se
 * indiquen (el del registro que se acaba de hacer). Así un gasto con fecha del mes siguiente ya se ve restado.
 */
function balancesNow(state: AppState, now: Date, ...keys: MonthKey[]): { asOf: MonthKey; all: Balances } {
  const asOf = [...sortedKeys(state).slice(-1), currentMonthKey(now), ...keys].sort().at(-1)!;
  return { asOf, all: balances(state, asOf) };
}

function balanceOf(all: Balances, accountId: string): AccountBalance | null {
  return all.accounts.find((b) => b.account.id === accountId) ?? null;
}

function balanceSentence(b: AccountBalance): string {
  return `${b.account.name} balance: ${money(b.balance, b.account.currency)}.`;
}

/** Una cuenta en los datos crudos; `balance` es null si no se pudo leer después de escribir. */
function accountData(account: Account, b: AccountBalance | null) {
  return { id: account.id, name: account.name, currency: account.currency, balance: b ? b.balance : null };
}

/** La cuenta a la que entra o de la que sale `amount`, y cuánto es en su moneda si se dijo en otra. */
function accountPart(state: AppState | null, key: MonthKey, account: Account, amount: number, cur: Currency, date?: ISODate): string {
  if (!state || cur === account.currency) return account.name;
  return `${account.name} (${money(convert(state, key, amount, cur, account.currency, date), account.currency)})`;
}

/** La cuenta que nombra la persona o, si no nombra ninguna, su cuenta por defecto. */
async function resolveAccount({ db, user }: ToolContext, named: string | undefined): Promise<Account> {
  const { accounts, defaultAccount } = await userAccounts(db, user.id);
  const account = named === undefined ? defaultAccount : matchAccount(accounts, named);
  if (!account) throw noAccountsError();
  return account;
}

/** Para comparar nombres sin distinguir mayúsculas, acentos ni espacios de más. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Gastos fijos que coinciden con `name`: primero por nombre exacto, si no por comienzo y si no por contenido.
 * Devuelve los del primer criterio que acierte; más de uno significa que el nombre es ambiguo.
 */
function findFixed(list: readonly FixedExpense[], name: string): FixedExpense[] {
  const query = fold(name);
  if (!query) return [];
  const folded = list.map((f) => ({ f, n: fold(f.name) }));
  const tiers: ((n: string) => boolean)[] = [(n) => n === query, (n) => n.startsWith(query), (n) => n.includes(query)];
  for (const matches of tiers) {
    const hits = folded.filter((x) => matches(x.n)).map((x) => x.f);
    if (hits.length > 0) return hits;
  }
  return [];
}

// ── Argumentos ───────────────────────────────────────────────────────────────
// Un solo esquema zod por herramienta: valida los argumentos y de él sale el inputSchema que ve el modelo.
// La excepción es `user`, que depende de la configuración y no del código: se resuelve aparte (resolveUser) y
// su propiedad se añade al inputSchema en cada petición (userProperty).
// Categoría y método se limitan aquí a las listas de la interfaz (en la API son texto libre): un valor fuera
// de lista no se podría elegir después en los desplegables de la aplicación. La vía de un envío sí es libre.
// Una cuenta se dice por su nombre (o su id) y se busca entre las del usuario (server/ingest.ts matchAccount).

type IssueLike = { input?: unknown };

/** Mensaje de tipo: distingue "falta" de "vino con otro tipo". */
const typed = (message: string) => (issue: IssueLike) => (issue.input === undefined ? 'is required' : message);

const text = (max: number) => z.string({ error: typed('must be text') }).trim().max(max, { error: `allows up to ${max} characters` });
const requiredText = (max: number) => text(max).min(1, { error: 'cannot be empty' });
const positive = () =>
  z.number({ error: typed('must be a number') }).gt(0, { error: 'must be greater than 0' }).max(MAX_AMOUNT, { error: 'is too large' });
const oneOf = <const T extends readonly [string, ...string[]]>(values: T) => z.enum(values, { error: `must be one of: ${values.join(', ')}` });

/**
 * Un valor de lista fija (categoría, método), opcional y con el primero de la lista por defecto. La persona
 * puede decirlo en español o en turco y Claude pasa lo que oye: antes de validar se lleva a su nombre canónico.
 * El esquema que ve el modelo lista solo los canónicos.
 */
const listed = <const T extends readonly [string, ...string[]]>(values: T, canonical: (name: string) => string, description: string) =>
  z.preprocess((v) => (typeof v === 'string' ? canonical(v) : v), oneOf(values).optional().meta({ description, default: values[0] }));

/** Sin valor por defecto en el esquema: la moneda que se aplica es la de la cuenta, que el esquema no conoce. */
const currency = (description: string) => z.enum(CURRENCY_CODES, { error: 'must be DOP, USD or TRY' }).optional().describe(description);

const accountName = (description: string) => text(MAX_LEN.name).optional().describe(description);

// Los patrones son la pista para el modelo; quien decide es shared/month.ts (que además rechaza un 30 de febrero).
const NOT_A_DATE = 'is not a valid date (YYYY-MM-DD)';
const NOT_A_MONTH = 'is not a valid month (YYYY-MM)';
const isoDate = () =>
  z
    .string({ error: typed('must be a date (YYYY-MM-DD)') })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: NOT_A_DATE, abort: true })
    .refine(isISODate, { error: NOT_A_DATE });
const monthKey = () =>
  z
    .string({ error: typed('must be a month (YYYY-MM)') })
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: NOT_A_MONTH, abort: true })
    .refine(isMonthKey, { error: NOT_A_MONTH });

const DEFAULT_LIST = 20;
const MAX_LIST = 200;

const ACCOUNT_HINT = 'by name or id, as the person calls it (part of the name is enough if it identifies only one; see list_accounts)';

const addTransactionArgs = z.strictObject({
  description: requiredText(MAX_LEN.desc).describe('What the expense was, in a few words and as the person said it: "Uber", "Lunch", "Weekly groceries".'),
  amount: positive().describe('Amount as the person said it, in the currency of `currency` and without converting. Greater than 0.'),
  currency: currency(
    'Currency the person said: DOP (Dominican pesos), USD (dollars) or TRY (Turkish lira). Omit it if they named none: the currency of the account is used.',
  ),
  account: accountName(`Account the expense is paid from, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  date: isoDate()
    .optional()
    .describe(`Date of the expense, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  place: text(MAX_LEN.place).optional().describe('Shop or place of the expense, if the person said it: "Supermercado Nacional", "Texaco".'),
  category: listed(CATS, canonicalCat, 'Category that best describes the expense.'),
  method: listed(METHODS, canonicalMethod, 'Payment method.'),
  notes: text(MAX_LEN.notes).optional().describe('Free note, if the person added some detail.'),
});

const listTransactionsArgs = z.strictObject({
  month: monthKey().optional().describe('Month to list, YYYY-MM. By default, the month in progress.'),
  limit: z
    .number({ error: 'must be a number' })
    .int({ error: 'must be an integer' })
    .min(1, { error: 'must be at least 1' })
    .max(MAX_LIST, { error: `allows up to ${MAX_LIST}` })
    .default(DEFAULT_LIST)
    .describe('Maximum number of transactions to return, starting with the most recent.'),
});

const monthSummaryArgs = z.strictObject({
  month: monthKey().optional().describe('Month to summarize, YYYY-MM. By default, the month in progress.'),
});

const addTransferArgs = z.strictObject({
  from_account: requiredText(MAX_LEN.name).describe(`Account the money leaves, ${ACCOUNT_HINT}.`),
  to_account: requiredText(MAX_LEN.name).describe(`Account the money arrives in, ${ACCOUNT_HINT}. It must be a different account.`),
  amount: positive().describe('Amount that leaves, in the currency of the origin account. Greater than 0.'),
  rate: positive()
    .optional()
    .describe(
      "What arrives per unit sent: 1 unit of the origin currency = `rate` units of the destination currency, for example 58.76 from USD to DOP. If the person gives the amount that arrived, it is arrived ÷ sent. Omit it if they give neither: the rate in effect on that date for the two currencies is used. Between accounts of the same currency, omit it.",
    ),
  via: requiredText(MAX_LEN.label)
    .default(VIAS[0])
    .describe(`Service the transfer was made through, as free text: ${VIAS.join(', ')} or any other name.`),
  date: isoDate()
    .optional()
    .describe(`Date of the transfer, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
});

const addIncomeArgs = z.strictObject({
  amount: positive().describe('Amount received as the person said it, in the currency of `currency` and without converting. Greater than 0.'),
  currency: currency(
    'Currency the person said: DOP (Dominican pesos), USD (dollars) or TRY (Turkish lira). Omit it if they named none: the currency of the account is used.',
  ),
  account: accountName(`Account the money enters, ${ACCOUNT_HINT}. Omit it unless the person names one: their default account is used.`),
  date: isoDate()
    .optional()
    .describe(`Date the money was received, YYYY-MM-DD. Omit it if the person gave no date or said "today": today in ${TIMEZONE} is used.`),
  description: text(MAX_LEN.desc).optional().describe('What the income was, in a few words and as the person said it: "Salary", "Freelance", "Gift".'),
  add_to_budget: z
    .boolean({ error: 'must be true or false' })
    .default(false)
    .describe(
      "true only if the person says this money should also raise the budget of the month of its date (for example \"add it to this month's budget\"). By default false: the income enters the account and the budget stays as it is.",
    ),
});

const listAccountsArgs = z.strictObject({});

const markFixedPaidArgs = z.strictObject({
  name: requiredText(MAX_LEN.name).describe(
    'Name of the fixed expense, as the person calls it: "Internet", "Netflix", "Luz". Part of the name is enough if it identifies only one.',
  ),
  month: monthKey().optional().describe('Month of the fixed expense, YYYY-MM. By default, the month in progress.'),
  paid: z
    .boolean({ error: 'must be true or false' })
    .default(true)
    .describe('true to mark it as paid; false to leave it as not paid.'),
});

// ── Herramientas ─────────────────────────────────────────────────────────────

interface ToolOutput {
  /** Confirmación corta, en inglés: es lo que lee el modelo. Dice de quién son las finanzas. */
  text: string;
  /** Los datos crudos (structuredContent); callTool les añade el usuario. */
  data: Record<string, unknown>;
}

interface ToolSpec<T> {
  name: string;
  title: string;
  /** Para el modelo: cuándo usarla y qué pasa si se omiten argumentos. */
  description: string;
  /** Los argumentos propios de la herramienta, sin `user`. */
  schema: z.ZodType<T>;
  readOnly: boolean;
  /** Repetir la llamada con los mismos argumentos no cambia nada más. */
  idempotent: boolean;
  run(args: T, ctx: ToolContext): Promise<ToolOutput>;
}

interface Tool {
  name: string;
  /** Lo que se publica en tools/list, con `user` según los usuarios configurados. */
  definition(users: readonly AppUser[]): Record<string, unknown>;
  /** Valida los argumentos (ya sin `user`) y ejecuta. Lanza ApiError si no cumplen o si el dominio lo impide. */
  call(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/** Un modelo suele mandar null o '' en lo que no sabe: cuenta como "no vino" y se aplica el valor por defecto. */
function dropBlank(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && !(typeof v === 'string' && v.trim() === '')));
}

function defineTool<T>(spec: ToolSpec<T>): Tool {
  // Solo se usan palabras clave comunes a draft-07 y 2020-12; sin `$schema`, cada cliente aplica el dialecto que entienda.
  const { properties = {}, required = [], additionalProperties } = z.toJSONSchema(spec.schema, { io: 'input' });
  return {
    name: spec.name,
    definition: (users) => {
      // `user` va primero, porque es lo primero que hay que saber, y es obligatorio solo si hay de quién elegir.
      const mandatory = users.length > 1 ? ['user', ...required] : required;
      return {
        name: spec.name,
        title: spec.title,
        description: spec.description,
        inputSchema: {
          type: 'object',
          properties: { user: userProperty(users), ...properties },
          ...(mandatory.length > 0 ? { required: mandatory } : {}),
          additionalProperties,
        },
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          // Ninguna herramienta borra ni sobrescribe datos del usuario.
          destructiveHint: false,
          idempotentHint: spec.idempotent,
          // Solo tocan la base de esta aplicación.
          openWorldHint: false,
        },
      };
    },
    call: async (args, ctx) => spec.run(parse(spec.schema, dropBlank(args)), ctx),
  };
}

const addTransaction = defineTool({
  name: 'add_transaction',
  title: 'Record transaction',
  description: [
    'Records an expense (a transaction) in the finances of `user`, in the month of its date, and subtracts it from the account it is paid from. Use it when the person says they spent, paid or bought something, for example "I spent 850 on Uber today with my card".',
    `Apart from \`user\`, only \`description\` and \`amount\` are required. Defaults: the person's default account, the currency of that account, today's date in ${TIMEZONE}, category ${CATS[0]} and method ${METHODS[0]}; even so, always choose the category that best describes the expense.`,
    'Pass `account` only if the person names the account it was paid from, and `currency` only if they name a currency: the amount is recorded in the currency they said, without converting, even if the account is in another one (the account is charged the equivalent at the rate in effect on that date).',
    'Category and method are stored under their English names; a Spanish or Turkish name is also accepted. Description, place and notes are kept exactly as given.',
    'The answer says which account it was paid from and the new balance of that account. If the month of the date does not exist, it is created (only near today: a date in another year is rejected); if it is closed, the call fails.',
    "Each call creates a new transaction: do not repeat it for the same expense. Do not use it for the month's fixed expenses (use mark_fixed_paid), for money moved between accounts (use add_transfer) or for money received (use add_income).",
  ].join(' '),
  schema: addTransactionArgs,
  readOnly: false,
  idempotent: false,
  async run(args, ctx) {
    const { db, now, user } = ctx;
    if (args.date) await assertReachable(ctx, args.date);
    // El usuario ya está resuelto: ingestTransaction solo tiene que encontrarlo. Las reglas de la cuenta y de
    // la moneda por defecto son las suyas (las mismas de POST /api/ingest/transaction).
    const { transaction: t, monthCreated } = await ingestTransaction(db, [user], { ...args, user: user.id }, now);
    const after = await afterWrite(ctx, (state) => ({
      state,
      calc: monthCalc(state, t.monthKey),
      paidFrom: balanceOf(balancesNow(state, now, t.monthKey).all, t.accountId),
    }));
    const paidFrom = after?.paidFrom ?? null;

    const parts = [
      t.desc,
      t.place,
      after ? moneyIn(after.state, t.monthKey, t.amount, t.cur, after.calc.main, t.date) : money(t.amount, t.cur),
      t.cat,
      t.method,
      `${t.date} (${label(t.monthKey)})`,
      after && paidFrom && `paid from ${accountPart(after.state, t.monthKey, paidFrom.account, t.amount, t.cur, t.date)}`,
    ];
    const sentences = [`Recorded for ${user.name}: ${parts.filter(Boolean).join(SEP)}.`];
    if (monthCreated) sentences.push(`The month ${label(t.monthKey)} was created.`);
    if (after) sentences.push(usedLine(after.calc));
    if (paidFrom) sentences.push(balanceSentence(paidFrom));
    if (after) sentences.push(...approxNotes(after.state, t.monthKey, t.cur, [after.calc.main, ...(paidFrom ? [paidFrom.account.currency] : [])], t.date));
    return {
      text: sentences.join(' '),
      data: {
        transaction: t,
        monthCreated,
        account: paidFrom ? accountData(paidFrom.account, paidFrom) : null,
        month: after ? monthStatus(after.calc) : null,
      },
    };
  },
});

const listTransactions = defineTool({
  name: 'list_transactions',
  title: 'List transactions',
  description: [
    "Lists the transactions of one month in the finances of `user`, from the most recent to the oldest, with the original amount, its equivalent in the person's main currency and the account each one was paid from.",
    'Use it to review what has been recorded, to look for an expense, or to check whether something is already recorded before recording it again.',
    `Defaults: ${IN_PROGRESS} and the ${DEFAULT_LIST} most recent. It does not include the fixed expenses (they are in month_summary), the incomes or the transfers.`,
  ].join(' '),
  schema: listTransactionsArgs,
  readOnly: true,
  idempotent: true,
  async run({ month, limit }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const main = state.mainCurrency;
    const accounts = accountsById(state);

    // Más reciente primero; con la misma fecha, la última que se registró.
    const sorted = m.tx
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i))
      .map(({ t }) => ({ ...t, inMain: convert(state, m.key, t.amount, t.cur, main, t.date), account: accounts.get(t.accountId)?.name ?? null }));
    const shown = sorted.slice(0, limit);
    const total = sorted.reduce((a, t) => a + t.inMain, 0);

    const lines =
      sorted.length === 0
        ? [`${heading(user, m)}: no transactions recorded.`]
        : [
            `${heading(user, m)}: ${sorted.length} ${sorted.length === 1 ? 'transaction' : 'transactions'}${SEP}${money(total, main)} in total.` +
              (shown.length === sorted.length ? '' : shown.length === 1 ? ' Showing the most recent one.' : ` Showing the ${shown.length} most recent.`),
            ...shown.map((t) =>
              [t.date, t.desc, t.place, moneyIn(state, m.key, t.amount, t.cur, main, t.date), t.cat, t.method, t.account, t.notes && `Notes: ${t.notes}`]
                .filter(Boolean)
                .join(SEP),
            ),
          ];
    return {
      text: lines.join('\n'),
      data: {
        month: m.key,
        label: label(m.key),
        closed: m.closed,
        today: todayISO(now),
        currency: main,
        count: sorted.length,
        total,
        shown: shown.length,
        transactions: shown,
      },
    };
  },
});

/** Cómo se nombra cada fila de la historia del presupuesto. */
const HISTORY_KIND = { initial: 'initial', adjust: 'adjustment', leftover: 'leftover', income: 'income' } as const;

const monthSummary = defineTool({
  name: 'month_summary',
  title: 'Month summary',
  description: [
    "Summary of one month in the finances of `user`, with every amount in the person's main currency: budget and the part of it that comes out of each account, how the budget got there (its history: the initial amount, later adjustments, the leftover of the previous month and the incomes added to it, each with its date), used, available, fixed expenses paid and pending (with the names of the ones still to pay), spending by category, the month's income and income minus used, the balance of each account and the month's rates.",
    'Use it when the person asks how the month is going, how much is left, what is still to be paid, how much they have or why the budget changed.',
    'If the previous month ended with money left over (or overspent) and it has not been added to this month\'s budget, a "Leftover" line says how much; adding it is done in the app.',
    'Rates carry the date they apply from: an amount is converted with the rate in effect on its own date, so a rate typed later does not change earlier records. The "Month rates" line gives the latest rate of the month and where it came from; "default value, not set yet" means the converted amounts are only approximate.',
    `It also says what today's date is for the users. By default: ${IN_PROGRESS}.`,
  ].join(' '),
  schema: monthSummaryArgs,
  readOnly: true,
  idempotent: true,
  async run({ month }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const c = monthCalc(state, m.key);
    const { main, second } = c;
    const today = todayISO(now);
    const both = (amount: number, inSecond: number) => `${money(amount, main)} (${money(inSecond, second)})`;

    const pending = m.fixed
      .filter((f) => !f.paid)
      .map((f) => ({ name: f.name, day: f.day, amount: f.amount, cur: f.cur, inMain: convert(state, m.key, f.amount, f.cur, main) }));
    // Las partes sin monto no dicen nada: el presupuesto de una cuenta que no aporta es cero.
    const parts = c.budgetParts.filter((p) => p.amount !== 0);
    // Saldos al final del mes que se resume: para el mes en curso son los de ahora.
    const all = balances(state, m.key);
    const visible = all.accounts.filter((b) => !b.account.hidden);
    const incomes = state.incomes.filter((i) => monthOf(i.date) === m.key);
    const rates = ratesToMain(state, m.key, [
      second,
      ...visible.map((b) => b.account.currency),
      ...parts.map((p) => p.account.currency),
      ...m.fixed.map((f) => f.cur),
      ...m.tx.map((t) => t.cur),
      ...incomes.map((i) => i.cur),
    ]);

    const history = budgetHistory(state, m.key);
    const left = leftoverFor(state, m.key);
    // Las tasas escritas con fecha en el mes: cada una vale desde su fecha hasta la siguiente del par.
    const typed = m.rates.filter((r) => r.rate > 0);

    const lines = [
      `${heading(user, m)}${SEP}amounts in ${main}`,
      c.budget === 0 && parts.length === 0
        ? `Budget: ${money(0, main)} (no budget set)`
        : `Budget: ${both(c.budget, c.budgetSecond)}${SEP}by account: ${parts.map((p) => `${p.account.name} ${moneyIn(state, m.key, p.amount, p.account.currency, main)}`).join('; ')}`,
    ];
    if (history.length > 0) {
      lines.push(
        `Budget history: ${history
          .map((h) => `${h.date} ${HISTORY_KIND[h.kind]} ${h.account.name} ${signed(h.amount, h.account.currency)}${h.note ? ` (${h.note})` : ''}`)
          .join('; ')}`,
      );
    }
    if (left.previousKey !== null && left.leftover !== null && !left.added) {
      lines.push(`Leftover of ${label(left.previousKey)}: ${money(left.leftover, main)}, not added to this month's budget.`);
    }
    lines.push(
      `Used so far: ${both(c.used, c.usedSecond)}`,
      `Available: ${money(c.avail, main)}`,
      `Available after pending fixed: ${money(c.after, main)}`,
      `Monthly expenses: ${c.paidCount} of ${c.fixedCount} paid${SEP}Fixed paid: ${money(c.fixedPaid, main)}${SEP}Fixed pending: ${money(c.pending, main)}`,
    );
    if (pending.length > 0) {
      lines.push(`Still to pay: ${pending.map((f) => `${f.name} ${moneyIn(state, m.key, f.amount, f.cur, main)}${f.day ? `, day ${f.day}` : ''}`).join('; ')}`);
    }
    lines.push(
      `Transactions: ${c.txCount} (${money(c.varSpent, main)})`,
      c.categories.length > 0
        ? `By category: ${c.categories.map((cat) => `${cat.name} ${money(cat.value, main)}`).join(SEP)}`
        : 'By category: No expenses yet this month.',
      `Month income: ${money(c.income, main)}${SEP}Income − used: ${money(c.incomeLeft, main)}`,
      visible.length > 0
        ? `Account balances at the end of ${label(m.key)}: ${visible.map((b) => `${b.account.name} ${moneyIn(state, m.key, b.balance, b.account.currency, main)}`).join('; ')}${SEP}Total money: ${both(all.totalMain, all.totalSecond)}`
        : `Account balances at the end of ${label(m.key)}: no visible accounts.`,
      `Month rates: ${rates.map(rateText).join('; ')}`,
    );
    if (typed.length > 0) {
      lines.push(`Rates typed in ${label(m.key)}: ${typed.map((r) => `${pairText(r.from, r.to, r.rate)} from ${r.date}`).join('; ')}`);
    }
    lines.push(`Today is ${today}.`);
    return {
      text: lines.join('\n'),
      data: {
        month: m.key,
        label: label(m.key),
        closed: m.closed,
        today,
        currency: main,
        secondCurrency: second,
        budget: c.budget,
        budgetSecond: c.budgetSecond,
        budgetParts: parts.map((p) => ({
          accountId: p.account.id,
          name: p.account.name,
          currency: p.account.currency,
          amount: p.amount,
          fromLog: p.fromLog,
          fromIncomes: p.fromIncomes,
          inMain: p.inMain,
        })),
        budgetHistory: history.map((h) => ({
          kind: h.kind,
          id: h.id,
          date: h.date,
          accountId: h.account.id,
          account: h.account.name,
          amount: h.amount,
          currency: h.account.currency,
          note: h.note,
          inMain: h.inMain,
          total: h.total,
        })),
        leftover: { previousMonth: left.previousKey, amount: left.leftover, added: left.added },
        used: c.used,
        usedSecond: c.usedSecond,
        available: c.avail,
        availableAfterPending: c.after,
        fixed: { count: c.fixedCount, paidCount: c.paidCount, paid: c.fixedPaid, pending: c.pending, pendingItems: pending },
        transactions: { count: c.txCount, total: c.varSpent },
        categories: c.categories.map((cat) => ({ name: cat.name, value: cat.value })),
        income: { count: incomes.length, total: c.income, left: c.incomeLeft },
        accounts: visible.map((b) => ({ ...accountData(b.account, b), inMain: b.inMain })),
        totalMoney: { main: all.totalMain, second: all.totalSecond },
        rates,
        typedRates: typed,
      },
    };
  },
});

const addTransfer = defineTool({
  name: 'add_transfer',
  title: 'Record transfer between accounts',
  description: [
    'Records money moved from one account to another in the finances of `user`: it leaves `from_account` and arrives in `to_account`. Use it when the person says they sent, exchanged, withdrew or moved money between their accounts, for example dollars sent to their pesos account.',
    'It is not an expense and does not count as used. `amount` is what leaves, in the currency of the origin account; what arrives is amount × rate, in the currency of the destination account.',
    "Between accounts of different currencies pass `rate` if the person says it or says how much arrived; if it is omitted, the rate in effect on that date for the two currencies is used and the answer says where it came from. The transfers of a month also set that month's rate between the two currencies while the person has never typed one. Between accounts of the same currency the same amount arrives.",
    `Defaults: via ${VIAS[0]} and today's date in ${TIMEZONE}. \`via\` is free text: the name of the service used (${VIAS.join(', ')} or any other). If the month of the date does not exist, it is created (only near today); if it is closed, the call fails.`,
    'The answer states what left, what arrived and the new balance of both accounts. Each call creates a new transfer: do not repeat it for the same transfer.',
  ].join(' '),
  schema: addTransferArgs,
  readOnly: false,
  idempotent: false,
  async run({ from_account, to_account, amount, rate: given, via, date: givenDate }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const date = givenDate ?? todayISO(now);
    const key = monthOf(date);

    // Las cuentas se resuelven antes de tocar nada: una que no se reconoce no llega a crear el mes.
    const { accounts } = await userAccounts(db, user.id);
    const from = matchAccount(accounts, from_account, 'from_account');
    const to = matchAccount(accounts, to_account, 'to_account');
    if (from.id === to.id) throw validationError(invalidData(`to_account: must be a different account from from_account (both are ${from.name})`));
    const same = from.currency === to.currency;
    // Entre cuentas de la misma moneda entra lo mismo que sale: otra tasa inventaría o perdería dinero.
    if (same && given !== undefined && given !== 1) {
      throw validationError(invalidData(`rate: must be omitted between accounts of the same currency (both are in ${from.currency})`));
    }

    const { month, created } = await ensureMonth(db, user.id, key);
    if (month.closed) throw monthClosedError(key);
    // Sin tasa vale la vigente en la fecha del envío para ese par. Se resuelve aquí (y no dentro de
    // createTransfer) para poder decir de dónde salió: una vez guardado el envío, la tasa del mes podría salir de él.
    const assumed = same || given !== undefined ? null : rateFor(await loadState(db, user.id), key, from.currency, to.currency, date);
    const rate = same ? 1 : (given ?? assumed?.rate);
    // Las reglas del contrato (shared/api.ts) las pone el mismo esquema que usa POST /api/transfers.
    const transfer = await createTransfer(
      db,
      user.id,
      parse(transferCreateSchema, { monthKey: key, date, via, fromAccountId: from.id, toAccountId: to.id, amount, rate }),
    );
    const received = transferReceived(transfer);
    const after = await afterWrite(ctx, (state) => {
      const { all } = balancesNow(state, now, key);
      return { from: balanceOf(all, from.id), to: balanceOf(all, to.id) };
    });

    const moved = `${money(transfer.amount, from.currency)} left ${from.name}, ${money(received, to.currency)} arrived in ${to.name}`;
    const head = same ? moved : `${moved} (${pairText(from.currency, to.currency, transfer.rate)})`;
    const sentences = [`Transfer recorded for ${user.name}: ${[head, transfer.via, `${transfer.date} (${label(key)})`].join(SEP)}.`];
    if (created) sentences.push(`The month ${label(key)} was created.`);
    if (assumed) {
      sentences.push(
        `No rate was given: the rate in effect on that date was used (${rateNote(assumed, from.currency, to.currency)}).` +
          (assumed.source === 'default' ? ' Nobody has set that rate yet, so the amount that arrived is only approximate: ask the person how much arrived.' : ''),
      );
    }
    if (after?.from) sentences.push(balanceSentence(after.from));
    if (after?.to) sentences.push(balanceSentence(after.to));
    return {
      text: sentences.join(' '),
      data: {
        transfer,
        from: accountData(from, after?.from ?? null),
        to: accountData(to, after?.to ?? null),
        sent: { amount: transfer.amount, currency: from.currency },
        received: { amount: received, currency: to.currency },
        rateSource: same ? 'same' : assumed ? assumed.source : 'given',
        monthCreated: created,
      },
    };
  },
});

const addIncome = defineTool({
  name: 'add_income',
  title: 'Record income',
  description: [
    'Records money received (an income: salary, a payment, a gift…) in the finances of `user` and adds it to the account it enters. Use it when the person says they were paid or received money.',
    `Apart from \`user\`, only \`amount\` is required. Defaults: the person's default account, the currency of that account and today's date in ${TIMEZONE}. Pass \`account\` if the person names the account the money entered, and \`currency\` only if they name a currency: the amount is recorded in the currency they said, without converting.`,
    "The month's income is the sum of the incomes dated in it. An income does not belong to a month sheet, so it can also be recorded with a date in a closed month; a date in another year is rejected.",
    "With `add_to_budget: true` the income also raises the budget of the month of its date, in the part of the account it enters, by its amount (converted to the currency of that account at the rate in effect on its date); the answer then states the month's budget. Use it only when the person asks for it.",
    "The answer states the new balance of the account and the month's income so far. Each call creates a new income: do not repeat it for the same one. Do not use it for money moved between the person's own accounts (use add_transfer).",
  ].join(' '),
  schema: addIncomeArgs,
  readOnly: false,
  idempotent: false,
  async run({ amount, currency: cur, account: named, date: givenDate, description, add_to_budget }, ctx) {
    const { db, now, user } = ctx;
    if (givenDate) await assertReachable(ctx, givenDate);
    const date = givenDate ?? todayISO(now);
    const key = monthOf(date);
    const account = await resolveAccount(ctx, named);

    // Un ingreso no pertenece a un mes (shared/api.ts): no crea el de su fecha ni lo frena que esté cerrado.
    const income = await createIncome(
      db,
      user.id,
      parse(incomeCreateSchema, { date, desc: description ?? '', accountId: account.id, amount, cur: cur ?? account.currency, budget: add_to_budget }),
    );
    const after = await afterWrite(ctx, (state) => ({
      state,
      main: state.mainCurrency,
      balance: balanceOf(balancesNow(state, now, key).all, account.id),
      monthIncome: incomeInMonth(state, key),
      count: state.incomes.filter((i) => monthOf(i.date) === key).length,
      // El presupuesto solo existe si el mes está registrado: un ingreso no crea el mes de su fecha.
      budget: state.months[key] ? monthCalc(state, key).budget : null,
    }));

    const parts = [
      income.desc,
      after ? moneyIn(after.state, key, income.amount, income.cur, after.main, income.date) : money(income.amount, income.cur),
      `into ${accountPart(after?.state ?? null, key, account, income.amount, income.cur, income.date)}`,
      `${income.date} (${label(key)})`,
    ];
    const sentences = [`Income recorded for ${user.name}: ${parts.filter(Boolean).join(SEP)}.`];
    if (after?.balance) sentences.push(balanceSentence(after.balance));
    if (after) {
      sentences.push(`Income in ${label(key)} so far: ${money(after.monthIncome, after.main)}.`);
      if (income.budget) {
        sentences.push(
          after.budget === null
            ? `It is marked to raise the budget of ${label(key)}, a month that does not exist yet: it will count when the month is created.`
            : `It was also added to the budget of ${label(key)}, now ${money(after.budget, after.main)}.`,
        );
      }
      sentences.push(...approxNotes(after.state, key, income.cur, [after.main, account.currency], income.date));
    }
    return {
      text: sentences.join(' '),
      data: {
        income,
        account: accountData(account, after?.balance ?? null),
        month: after
          ? { key, label: label(key), currency: after.main, income: after.monthIncome, incomeCount: after.count, budget: after.budget }
          : null,
      },
    };
  },
});

const listAccounts = defineTool({
  name: 'list_accounts',
  title: 'List accounts',
  description: [
    "Lists the accounts in the finances of `user`: the name, currency and current balance of each visible account, which one is the default account, and the total money in the person's main currency and in their second currency.",
    'Call it when you need to know which accounts exist: before recording an expense, an income or a transfer for which the person names an account you do not know, or when they ask how much money they have or what the balance of an account is.',
    "Balances are never typed: each one is the account's opening balance plus everything recorded since. Hidden accounts are not listed. It also says what today's date is for the users.",
  ].join(' '),
  schema: listAccountsArgs,
  readOnly: true,
  idempotent: true,
  async run(_args, ctx) {
    const { db, now, user } = ctx;
    // Quien nunca abrió la web recibe aquí sus cuentas iniciales (como en cualquier escritura): sin ellas la
    // lista saldría vacía y el modelo no tendría en qué registrar.
    const state = await userState(db, user.id);
    const { asOf, all } = balancesNow(state, now);
    const main = state.mainCurrency;
    const second = state.secondCurrency;
    const preferred = defaultAccount(state);
    const visible = all.accounts.filter((b) => !b.account.hidden);
    const hidden = all.accounts.length - visible.length;
    const today = todayISO(now);
    const rates = ratesToMain(state, asOf, [second, ...visible.map((b) => b.account.currency)]);

    const lines = [
      `${user.name}${SEP}${visible.length} ${visible.length === 1 ? 'account' : 'accounts'}${SEP}main currency ${main}, second currency ${second}`,
      ...visible.map((b) =>
        [
          b.account.name,
          b.account.currency,
          `balance ${moneyIn(state, asOf, b.balance, b.account.currency, main)}`,
          b.account.id === preferred?.id && 'default account',
        ]
          .filter(Boolean)
          .join(SEP),
      ),
      `Total money: ${money(all.totalMain, main)} (${money(all.totalSecond, second)})`,
    ];
    if (hidden > 0) lines.push(`Hidden accounts, not listed and not counted in the total: ${hidden}.`);
    lines.push(`Rates used (${label(asOf)}): ${rates.map(rateText).join('; ')}`, `Today is ${today}.`);
    return {
      text: lines.join('\n'),
      data: {
        today,
        asOf,
        mainCurrency: main,
        secondCurrency: second,
        defaultAccountId: preferred?.id ?? null,
        accounts: visible.map((b) => ({
          ...accountData(b.account, b),
          inMain: b.inMain,
          inSecond: b.inSecond,
          isDefault: b.account.id === preferred?.id,
        })),
        totalMoney: { main: all.totalMain, second: all.totalSecond },
        hiddenCount: hidden,
        rates,
      },
    };
  },
});

const markFixedPaid = defineTool({
  name: 'mark_fixed_paid',
  title: 'Mark fixed expense as paid',
  description: [
    'Marks one of the fixed expenses of a month in the finances of `user` (the "Monthly expenses" list: electricity, internet, insurance, subscriptions…) as paid, or as not paid with `paid: false`. Use it when the person says they have already paid one of their fixed expenses.',
    "The expense is found by name, ignoring case and accents, and part of the name is enough if it identifies only one. If none or several match, the answer lists the names of the month's fixed expenses so the call can be repeated with the exact name.",
    'While it is marked as paid, its amount is subtracted from the account it is paid from: the answer says which account that is and its new balance.',
    `Defaults: ${IN_PROGRESS} and \`paid: true\`. It does not change the amount or the account of the expense or create new fixed expenses; in a closed month it fails.`,
  ].join(' '),
  schema: markFixedPaidArgs,
  readOnly: false,
  idempotent: true,
  async run({ name, month, paid }, ctx) {
    const { db, now, user } = ctx;
    const state = await loadState(db, user.id);
    const m = resolveMonth(state, month, ctx);
    const where = label(m.key);

    const hits = findFixed(m.fixed, name);
    if (hits.length !== 1) {
      if (m.fixed.length === 0) throw notFoundError(`${user.name} has no fixed expenses in ${where}.`);
      const all = `Fixed expenses in ${where}: ${m.fixed.map((f) => f.name).join(', ')}.`;
      throw hits.length === 0
        ? notFoundError(`No fixed expense for ${user.name} in ${where} matches "${quoted(name)}". ${all}`)
        : validationError(
            `"${quoted(name)}" matches several fixed expenses for ${user.name} in ${where}: ${hits.map((f) => f.name).join(', ')}. Repeat the call with the exact name. ${all}`,
          );
    }

    const found = hits[0]!;
    const changed = found.paid !== paid;
    // Sin cambio no se escribe nada: repetir la llamada es inofensivo. La regla del mes cerrado la aplica patchFixed.
    const fixed = changed ? await patchFixed(db, user.id, found.id, parse(fixedPatchSchema, { paid })) : found;
    m.fixed = m.fixed.map((f) => (f.id === fixed.id ? fixed : f));
    const c = monthCalc(state, m.key);
    const paidFrom = balanceOf(balancesNow(state, now, m.key).all, fixed.accountId);

    const what = [
      fixed.name,
      moneyIn(state, m.key, fixed.amount, fixed.cur, c.main),
      where,
      paidFrom && `paid from ${accountPart(state, m.key, paidFrom.account, fixed.amount, fixed.cur)}`,
    ];
    const head = !changed
      ? `${fixed.name} was already ${paid ? 'paid' : 'not paid'} for ${user.name} in ${where}: nothing was changed.`
      : `${paid ? 'Paid' : 'Marked as not paid'} for ${user.name}: ${what.filter(Boolean).join(SEP)}.`;
    return {
      text: [head, fixedLine(c), usedLine(c), ...(paidFrom ? [balanceSentence(paidFrom)] : [])].join(' '),
      data: {
        fixed,
        changed,
        account: paidFrom ? accountData(paidFrom.account, paidFrom) : null,
        month: { ...monthStatus(c), fixedCount: c.fixedCount, paidCount: c.paidCount, pending: c.pending },
      },
    };
  },
});

/** En el orden en que las lista tools/list. */
const TOOLS = new Map(
  [addTransaction, listTransactions, monthSummary, addTransfer, markFixedPaid, addIncome, listAccounts].map((t) => [t.name, t]),
);
// ── Métodos ──────────────────────────────────────────────────────────────────

type RequestMessage = Extract<Incoming, { kind: 'request' }>;

/** Lo que de la petición HTTP decide cómo se atiende un mensaje. */
interface HttpContext {
  headers: Headers;
  /** Cabecera MCP-Protocol-Version, ya comprobado que es una versión soportada; null si no vino. */
  version: string | null;
}

/**
 * Negociación de versión con handshake: la que pide el cliente si se entiende; si no, la más nueva de las
 * que usan handshake (las posteriores no tienen initialize: no se pueden acordar por esta vía).
 */
function initialize(params: Record<string, unknown>, users: readonly AppUser[]): unknown {
  const requested = params.protocolVersion;
  if (typeof requested !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: `protocolVersion` is missing.');
  return {
    protocolVersion: isLegacy(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0],
    capabilities: CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: instructions(users),
  };
}

/** Son siete: caben en una página y no se devuelve nextCursor. */
function listTools(users: readonly AppUser[]): { tools: Record<string, unknown>[] } {
  return { tools: [...TOOLS.values()].map((t) => t.definition(users)) };
}

async function callTool(params: Record<string, unknown>, ctx: ServerContext): Promise<Record<string, unknown>> {
  const { name } = params;
  if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: `name` is missing.');
  const tool = TOOLS.get(name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${quoted(name)}`);
  const args = params.arguments ?? {};
  if (!isRecord(args)) throw new RpcError(INVALID_PARAMS, 'Invalid params: `arguments` must be an object.');

  try {
    // Antes que nada, de quién: sin eso no hay nada que validar ni que leer.
    const { user: requested, ...own } = args;
    const user = resolveUser(ctx.users, requested);
    const out = await tool.call(own, { db: ctx.db, now: ctx.now, user });
    return {
      content: [{ type: 'text', text: out.text }],
      structuredContent: { user: { id: user.id, name: user.name }, ...out.data },
      isError: false,
    };
  } catch (err) {
    const api = toApiError(err);
    // Lo inesperado no es un error de la herramienta: sube y se responde como error interno.
    if (api.status === 500) throw err;
    return { content: [{ type: 'text', text: api.message }], isError: true };
  }
}

/** MCP solo usa parámetros con nombre. */
function namedParams(params: unknown, status = 200): Record<string, unknown> {
  if (params != null && !isRecord(params)) throw new RpcError(INVALID_PARAMS, 'Invalid params: `params` must be an object.', status);
  return params ?? {};
}

function headerMismatch(detail: string): RpcError {
  return new RpcError(HEADER_MISMATCH, `The headers do not match the body: ${detail}`, 400);
}

const VERSION_MISMATCH = '`_meta` declares a protocol version that is not the one in the MCP-Protocol-Version header.';

/** Valor de una cabecera que repite un campo del cuerpo: lo que no es ASCII simple viaja como =?base64?…?= (UTF-8). */
function mirrored(value: string | null): string | null {
  const encoded = value === null ? null : /^=\?base64\?(.*)\?=$/.exec(value);
  if (!encoded) return value;
  try {
    const bytes = Uint8Array.from(atob(encoded[1]!), (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Época con handshake (2025-11-25 y anteriores). */
async function dispatchLegacy(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<unknown> {
  const params = namedParams(req.params);
  if (req.method === 'initialize') return initialize(params, ctx.users);

  // Quien declara su versión en `_meta` habla el protocolo sin handshake, que obliga a repetirla en la cabecera.
  const declared = isRecord(params._meta) ? params._meta[META_VERSION] : undefined;
  if (declared !== undefined && declared !== http.version) throw headerMismatch(VERSION_MISMATCH);

  switch (req.method) {
    case 'ping':
      return {};
    case 'tools/list':
      return listTools(ctx.users);
    case 'tools/call':
      return callTool(params, ctx);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${quoted(req.method)}`);
  }
}

/**
 * Época sin handshake (2026-07-28). Las cabeceras repiten campos del cuerpo para que un intermediario pueda
 * enrutar sin leerlo; el servidor tiene que rechazar la petición si no coinciden (400), porque si no cada
 * uno estaría actuando sobre un dato distinto.
 */
async function dispatchModern(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<unknown> {
  const params = namedParams(req.params, 400);
  const meta = isRecord(params._meta) ? params._meta : {};
  const declared = meta[META_VERSION];
  if (typeof declared !== 'string') throw new RpcError(INVALID_PARAMS, `Invalid params: \`_meta["${META_VERSION}"]\` is missing.`, 400);
  if (declared !== http.version) throw headerMismatch(VERSION_MISMATCH);
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    throw new RpcError(INVALID_PARAMS, `Invalid params: \`_meta["${META_CLIENT_CAPABILITIES}"]\` is missing.`, 400);
  }
  if (http.headers.get('Mcp-Method') !== req.method) throw headerMismatch('the Mcp-Method header is missing or is not the method of the request.');
  // Sin un nombre legible en el cuerpo no hay con qué comparar: lo rechaza callTool.
  if (req.method === 'tools/call' && typeof params.name === 'string' && mirrored(http.headers.get('Mcp-Name')) !== params.name) {
    throw headerMismatch('the Mcp-Name header is missing or is not the name of the tool.');
  }

  let result: Record<string, unknown>;
  switch (req.method) {
    case 'server/discover':
      result = { supportedVersions: PROTOCOL_VERSIONS, capabilities: CAPABILITIES, instructions: instructions(ctx.users), ...CACHE_HINTS };
      break;
    case 'tools/list':
      result = { ...listTools(ctx.users), ...CACHE_HINTS };
      break;
    case 'tools/call':
      result = await callTool(params, ctx);
      break;
    default:
      // Aquí un método que no existe es además un 404 (initialize y ping ya no forman parte del protocolo).
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${quoted(req.method)}`, 404);
  }
  // Sin handshake no hay otro momento para presentarse: el servidor se identifica en cada resultado.
  return { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } };
}

interface Answer {
  /** Estado HTTP si el mensaje viaja solo. */
  status: number;
  body: JsonRpcResponse;
}

async function respond(req: RequestMessage, ctx: ServerContext, http: HttpContext): Promise<Answer> {
  // initialize solo existe con handshake, diga lo que diga la cabecera.
  const modern = http.version !== null && isModern(http.version) && req.method !== 'initialize';
  try {
    const result = await (modern ? dispatchModern(req, ctx, http) : dispatchLegacy(req, ctx, http));
    return { status: 200, body: { jsonrpc: '2.0', id: req.id, result } };
  } catch (err) {
    if (err instanceof RpcError) return { status: err.status, body: failure(req.id, err.code, err.message) };
    // Solo lo inesperado va al log, y nunca a la respuesta.
    console.error(`[mcp] ${req.method}`, err);
    return { status: 200, body: failure(req.id, INTERNAL_ERROR, INTERNAL_MESSAGE) };
  }
}

// ── Transporte ───────────────────────────────────────────────────────────────

/** Atiende /mcp. `now` solo se pasa en las pruebas. */
export async function handleMcp(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  // La autenticación va antes que todo lo demás: sin el token no se lee el cuerpo ni se revela qué acepta el servidor.
  // El cuerpo del 401 es el mismo que en el resto de la API (shared/api.ts).
  if (!(await checkBearer(request, env))) {
    return reply(401, errorBody('unauthorized', 'Invalid or missing token.'), { 'WWW-Authenticate': 'Bearer' });
  }
  if (request.method !== 'POST') {
    return reply(405, failure(null, INVALID_REQUEST, 'HTTP method not allowed: this server only accepts POST.'), { Allow: 'POST' });
  }

  try {
    const bytes = await readLimitedBody(request, MAX_BODY_BYTES);
    if (!bytes) return reply(413, failure(null, INVALID_REQUEST, 'The request body is too large.'));

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return reply(400, failure(null, PARSE_ERROR, 'The request body is not valid JSON.'));
    }

    const batch = Array.isArray(payload);
    const raw: unknown[] = batch ? (payload as unknown[]) : [payload];
    if (raw.length === 0) return reply(400, failure(null, INVALID_REQUEST, 'Invalid request: the batch is empty.'));
    if (raw.length > MAX_BATCH) return reply(400, failure(null, INVALID_REQUEST, `Invalid request: a batch allows up to ${MAX_BATCH} messages.`));
    const messages = raw.map(classify);
    const first = messages[0]!;

    // En initialize la versión se negocia en el cuerpo. En todo lo demás la cabecera dice qué versión se habla:
    // si no es ninguna de las soportadas se rechaza diciendo cuáles hay, para que el cliente reintente con una.
    const version = request.headers.get('MCP-Protocol-Version');
    const initializing = messages.some((m) => m.kind === 'request' && m.method === 'initialize');
    if (version !== null && !isSupported(version) && !initializing) {
      const data = { supported: PROTOCOL_VERSIONS, requested: quoted(version) };
      const id = !batch && first.kind === 'request' ? first.id : null;
      return reply(400, failure(id, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${data.requested}.`, data));
    }
    if (batch && version !== null && isModern(version) && !initializing) {
      return reply(400, failure(null, INVALID_REQUEST, 'Invalid request: since version 2026-07-28 each POST carries a single message.'));
    }

    // De uno en uno y en orden: un lote puede registrar algo y pedir el resumen después.
    // Un USERS mal escrito es un error de configuración: lanza aquí y sale como error interno, con el motivo en el log.
    const ctx: ServerContext = { db: env.DB, now, users: configuredUsers(env) };
    const http: HttpContext = { headers: request.headers, version };
    const answers: Answer[] = [];
    for (const m of messages) {
      if (m.kind === 'invalid') answers.push({ status: 400, body: failure(m.id, INVALID_REQUEST, 'Invalid JSON-RPC request.') });
      else if (m.kind === 'request') answers.push(await respond(m, ctx, http));
      // Las notificaciones y las respuestas del cliente se aceptan y no se contestan.
    }

    if (answers.length === 0) return new Response(null, { status: 202, headers: NO_STORE });
    if (batch) return reply(200, answers.map((a) => a.body));
    return reply(answers[0]!.status, answers[0]!.body);
  } catch (err) {
    console.error('[mcp]', err);
    return reply(500, failure(null, INTERNAL_ERROR, INTERNAL_MESSAGE));
  }
}
