// Repositorio sobre D1: lo único que sabe de SQL. Convierte filas (snake_case, 0/1) al modelo de dominio
// de shared/types.ts y hace cumplir las reglas de escritura del contrato (shared/api.ts) lanzando ApiError.
//
// Cada usuario tiene sus finanzas aparte (migrations/0001_init.sql: todas las claves son (user_id, …)). Por eso
// todas las funciones reciben el id del usuario y todas las sentencias filtran por user_id o lo escriben: un id
// que existe pero es de otro usuario se comporta exactamente igual que uno que no existe.
//
// Aquí no se guarda ni se calcula dinero convertido: ni saldos, ni el ingreso del mes, ni totales. Cada fila
// lleva su monto y su moneda originales y todo lo demás sale de shared/calc.ts sobre el estado cargado.
//
// D1 no tiene transacciones interactivas. Por eso:
//   · las escrituras de varias sentencias van en un solo db.batch([...]) (atómico);
//   · la regla "mes cerrado = solo lectura" y la de "la cuenta tiene que existir" van dentro del propio
//     INSERT/UPDATE/DELETE (… WHERE el mes está abierto, … JOIN accounts), no en una lectura previa: así no hay
//     ventana entre comprobar y escribir. Las lecturas previas solo sirven para dar el error exacto.
//   · una sentencia admite como mucho 100 parámetros: los INSERT de muchas filas se parten (insertMany).

import type {
  AccountCreate,
  AccountPatch,
  BudgetEntryCreate,
  CardPayRequest,
  CloseRequest,
  CloseResponse,
  ContributionCreate,
  ContributionPatch,
  CreditCardCreate,
  CreditCardPatch,
  FixedCreate,
  FixedPatch,
  GoalCreate,
  GoalPatch,
  ImportPayload,
  ImportResponse,
  IncomeCreate,
  IncomePatch,
  MonthPatch,
  MonthSummary,
  MoveToBudgetRequest,
  OutsideCreate,
  OutsidePatch,
  SettingsResponse,
  SettingsUpdate,
  TransferCreate,
  TransferPatch,
  TxCreate,
  TxPatch,
} from '../shared/api';
import {
  accountsById,
  budgetsFromLog,
  cardAccountFor,
  cardCalc,
  cardOffBlocked,
  convert,
  defaultAccount,
  leftoverFor,
  monthCalc,
  outsideOf,
  rateFor,
  sortedKeys,
} from '../shared/calc';
import {
  CREDIT_CARD_METHOD,
  CURRENCIES,
  DEFAULT_ACCOUNTS,
  DEFAULT_GOALS,
  DEFAULT_MAIN_CURRENCY,
  DEFAULT_RATE,
  DEFAULT_SECOND_CURRENCY,
  GOLD,
  isGold,
  MAX_LEN,
  MOVED_TO_BUDGET,
} from '../shared/constants';
import { applyImportToState } from '../shared/excel/data';
import { DEFAULT_LANGUAGE, isLanguage } from '../shared/i18n';
import { clampToMonth, currentMonthKey, firstDay, inMonth, isMonthKey, lastDay, nextKey, todayISO } from '../shared/month';
import { isDefaultTheme, normalizeTheme } from '../shared/theme';
import type {
  Account,
  CardPayment,
  AccountCurrency,
  CreditCard,
  MonthCard,
  AppState,
  BudgetEntryKind,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  GoldPrice,
  Income,
  ISODate,
  Language,
  Month,
  MonthKey,
  MonthRate,
  OutsideExpense,
  ThemeColors,
  Transaction,
  Transfer,
  TxSource,
} from '../shared/types';
import type { ApiError } from './errors';
import {
  conflictError,
  goldAccountError,
  invalidData,
  monthClosedError,
  monthNotFoundError,
  noAccountsError,
  unknownCardError,
  notFoundError,
  unknownAccountError,
  validationError,
} from './errors';
import { goalPlanIssue, SAME_ACCOUNT, SAME_CURRENCY } from './validate';
import type { GoalPlan } from './validate';

// ── Filas ────────────────────────────────────────────────────────────────────
// Todas traen además user_id; no pasa al modelo: el usuario es siempre el de la petición.

interface MonthRow {
  key: string;
  closed: number;
  closed_at: string | null;
  // card_other / card_paid / card_account_id (0009) ya no se leen ni se escriben: viven en month_cards y card_payments (0011).
}

interface AccountRow {
  id: string;
  name: string;
  currency: AccountCurrency;
  opening: number;
  hidden: number;
  sort: number;
}

interface BudgetLogRow {
  id: string;
  month_key: string;
  date: string;
  account_id: string;
  amount: number;
  kind: BudgetEntryKind;
  note: string;
}

interface RateRow {
  month_key: string;
  from_currency: Currency;
  to_currency: Currency;
  date: string;
  rate: number;
}

interface FixedRow {
  id: string;
  month_key: string;
  name: string;
  day: string;
  amount: number;
  currency: Currency;
  paid: number;
  account_id: string;
  sort: number;
  on_card?: number | null;
  card_id?: string | null;
}

interface TxRow {
  id: string;
  month_key: string;
  date: string;
  description: string;
  place: string;
  category: string;
  method: string;
  amount: number;
  currency: Currency;
  account_id: string;
  notes: string;
  source: TxSource;
  created_at: string | null;
  card_id?: string | null;
}

interface OutsideRow {
  id: string;
  month_key: string;
  date: string;
  name: string;
  description: string;
  account_id: string;
  amount: number;
  currency: Currency;
  sort: number;
}

interface CreditCardRow {
  id: string;
  name: string;
  bank: string | null;
  last4: string | null;
  currency: Currency;
  credit_limit: number | null;
  cutoff_day: number | null;
  due_day: number | null;
  active: number;
  sort: number;
}

interface MonthCardRow {
  month_key: string;
  card_id: string;
  other: number;
}

interface CardPaymentRow {
  card_id: string;
  id: string;
  month_key: string;
  date: string;
  account_id: string;
  amount: number;
  sort: number;
}

interface TransferRow {
  id: string;
  month_key: string;
  date: string;
  via: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  rate: number;
  budget: number;
  fee: number;
}

interface IncomeRow {
  id: string;
  date: string;
  description: string;
  account_id: string;
  amount: number;
  currency: AccountCurrency;
  budget: number;
  rate: number | null;
  recurring: number;
}

interface GoalRow {
  id: string;
  name: string;
  currency: Currency;
  monthly: number | null;
  start_month: string | null;
  end_month: string | null;
  approx_currency: Currency | null;
  sort: number;
}

interface ContributionRow {
  id: string;
  goal_id: string;
  date: string;
  amount: number;
  currency: Currency;
  rate: number | null;
  account_id: string | null;
}

interface SettingRow {
  key: string;
  value: string | null;
}

function toAccount(r: AccountRow): Account {
  return { id: r.id, name: r.name, currency: r.currency, opening: r.opening, hidden: r.hidden === 1, sort: r.sort };
}

function toFixed(r: FixedRow): FixedExpense {
  return {
    id: r.id,
    monthKey: r.month_key,
    name: r.name,
    day: r.day,
    amount: r.amount,
    cur: r.currency,
    paid: r.paid === 1,
    accountId: r.account_id,
    sort: r.sort,
    ...(r.on_card === 1 ? { onCard: true } : {}),
    ...(r.on_card === 1 && r.card_id ? { cardId: r.card_id } : {}),
  };
}

function toTx(r: TxRow): Transaction {
  return {
    id: r.id,
    monthKey: r.month_key,
    date: r.date,
    desc: r.description,
    place: r.place,
    cat: r.category,
    method: r.method,
    amount: r.amount,
    cur: r.currency,
    accountId: r.account_id,
    notes: r.notes,
    source: r.source,
    createdAt: r.created_at,
    ...(r.card_id ? { cardId: r.card_id } : {}),
  };
}

function toCreditCard(r: CreditCardRow): CreditCard {
  return {
    id: r.id,
    name: r.name,
    bank: r.bank,
    last4: r.last4,
    cur: r.currency,
    limit: r.credit_limit,
    cutoffDay: r.cutoff_day,
    dueDay: r.due_day,
    active: r.active === 1,
    sort: r.sort,
  };
}

function toCardPayment(r: CardPaymentRow): CardPayment {
  return { id: r.id, date: r.date, accountId: r.account_id, amount: r.amount };
}

function toOutside(r: OutsideRow): OutsideExpense {
  return { id: r.id, monthKey: r.month_key, date: r.date, name: r.name, desc: r.description, accountId: r.account_id, amount: r.amount, cur: r.currency };
}

function toTransfer(r: TransferRow): Transfer {
  return {
    id: r.id,
    monthKey: r.month_key,
    date: r.date,
    via: r.via,
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    amount: r.amount,
    rate: r.rate,
    budget: r.budget === 1,
    fee: r.fee,
  };
}

function toIncome(r: IncomeRow): Income {
  return { id: r.id, date: r.date, desc: r.description, accountId: r.account_id, amount: r.amount, cur: r.currency, budget: r.budget === 1, rate: r.rate ?? null, recurring: r.recurring === 1 };
}

function toGoal(r: GoalRow): Goal {
  return {
    id: r.id,
    name: r.name,
    cur: r.currency,
    monthly: r.monthly,
    start: r.start_month,
    end: r.end_month,
    approxCur: r.approx_currency,
    sort: r.sort,
  };
}

function toContribution(r: ContributionRow): Contribution {
  return { id: r.id, goalId: r.goal_id, date: r.date, amount: r.amount, cur: r.currency, rate: r.rate ?? null, accountId: r.account_id ?? null };
}

/** Las filas que cuelgan de los meses, de uno o de todos. */
interface MonthParts {
  budgetLog: BudgetLogRow[];
  rates: RateRow[];
  fixed: FixedRow[];
  transfers: TransferRow[];
  tx: TxRow[];
  outside: OutsideRow[];
  cardPayments: CardPaymentRow[];
  monthCards: MonthCardRow[];
}

/** Arma cada mes con sus filas, que llegan ya en su orden de lectura. */
function toMonths(months: MonthRow[], parts: MonthParts): Record<MonthKey, Month> {
  const byKey: Record<MonthKey, Month> = {};
  for (const r of months) {
    byKey[r.key] = { key: r.key, closed: r.closed === 1, closedAt: r.closed_at, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
  }
  // Month.cards solo existe en los meses que tienen algo de alguna tarjeta (un mes sin ellas queda como siempre).
  const entry = (month: Month, cardId: string): MonthCard => {
    const cards = (month.cards ??= []);
    let hit = cards.find((c) => c.cardId === cardId);
    if (!hit) cards.push((hit = { cardId, other: 0, payments: [] }));
    return hit;
  };
  for (const r of parts.monthCards) {
    const month = byKey[r.month_key];
    if (month && r.other !== 0) entry(month, r.card_id).other = r.other;
  }
  for (const r of parts.cardPayments) {
    const month = byKey[r.month_key];
    if (month) entry(month, r.card_id).payments.push(toCardPayment(r));
  }
  // Un orden fijo, el mismo se lea como se lea.
  for (const month of Object.values(byKey)) month.cards?.sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  for (const r of parts.budgetLog) {
    byKey[r.month_key]?.budgetLog.push({ id: r.id, date: r.date, accountId: r.account_id, amount: r.amount, kind: r.kind, note: r.note });
  }
  // Las partes por cuenta no se guardan: son la suma del registro, hecha al leer.
  for (const month of Object.values(byKey)) month.budgets = budgetsFromLog(month.budgetLog);
  for (const r of parts.rates) byKey[r.month_key]?.rates.push({ from: r.from_currency, to: r.to_currency, rate: r.rate, date: r.date });
  for (const r of parts.fixed) byKey[r.month_key]?.fixed.push(toFixed(r));
  for (const r of parts.transfers) byKey[r.month_key]?.transfers.push(toTransfer(r));
  for (const r of parts.tx) byKey[r.month_key]?.tx.push(toTx(r));
  // Month.outside solo existe en los meses que tienen alguno (un mes sin ellos queda como siempre).
  for (const r of parts.outside) {
    const month = byKey[r.month_key];
    if (month) (month.outside ??= []).push(toOutside(r));
  }
  return byKey;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Límite de D1 por sentencia. */
const MAX_PARAMS = 100;

// Orden de lectura = orden de inserción (rowid), como los arreglos del prototipo; la interfaz ordena por fecha.
// Lo que el usuario ordena (cuentas, fijos, metas) se lee por su `sort`.
const BY_SORT = 'sort, rowid';
// Lo que es una historia (tasas, registro del presupuesto) se lee por fecha; con la misma, en el orden de alta.
const BY_DATE = 'date, rowid';

type MonthTable = 'fixed_expenses' | 'transactions' | 'transfers' | 'outside_expenses';

const ACCOUNT_INSERT = ['user_id', 'id', 'name', 'currency', 'opening', 'hidden', 'sort'];
const MONTH_INSERT = ['user_id', 'key', 'closed', 'closed_at'];
const CREDIT_CARD_INSERT = ['user_id', 'id', 'name', 'bank', 'last4', 'currency', 'credit_limit', 'cutoff_day', 'due_day', 'active', 'sort'];
const MONTH_CARD_INSERT = ['user_id', 'month_key', 'card_id', 'other'];
const CARD_PAYMENT_INSERT = ['user_id', 'id', 'month_key', 'card_id', 'date', 'account_id', 'amount', 'sort'];
const BUDGET_LOG_INSERT = ['user_id', 'id', 'month_key', 'date', 'account_id', 'amount', 'kind', 'note'];
const RATE_INSERT = ['user_id', 'month_key', 'from_currency', 'to_currency', 'date', 'rate'];
const FIXED_INSERT = ['user_id', 'id', 'month_key', 'name', 'day', 'amount', 'currency', 'paid', 'account_id', 'sort', 'on_card', 'card_id'];
const TRANSFER_INSERT = ['user_id', 'id', 'month_key', 'date', 'via', 'from_account_id', 'to_account_id', 'amount', 'rate', 'budget', 'fee'];
const TX_INSERT = [
  'user_id',
  'id',
  'month_key',
  'date',
  'description',
  'place',
  'category',
  'method',
  'amount',
  'currency',
  'account_id',
  'notes',
  'source',
  'created_at',
  'card_id',
];
const OUTSIDE_INSERT = ['user_id', 'id', 'month_key', 'date', 'name', 'description', 'account_id', 'amount', 'currency', 'sort'];
const INCOME_INSERT = ['user_id', 'id', 'date', 'description', 'account_id', 'amount', 'currency', 'budget', 'rate', 'recurring'];
const GOAL_INSERT = ['user_id', 'id', 'name', 'currency', 'monthly', 'start_month', 'end_month', 'approx_currency', 'sort'];
const CONTRIBUTION_INSERT = ['user_id', 'id', 'goal_id', 'date', 'amount', 'currency', 'rate', 'account_id'];

export function newId(): string {
  return crypto.randomUUID();
}

function rows<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isCurrency(value: unknown): value is Currency {
  return (CURRENCIES as readonly unknown[]).includes(value);
}

/** INSERT multi-fila partido para no pasar de 100 parámetros por sentencia. Tabla y columnas son constantes del código. */
function insertMany(db: D1Database, table: string, columns: readonly string[], data: readonly unknown[][]): D1PreparedStatement[] {
  const one = `(${columns.map(() => '?').join(', ')})`;
  return chunks(data, Math.floor(MAX_PARAMS / columns.length)).map((part) =>
    db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${part.map(() => one).join(', ')}`).bind(...part.flat()),
  );
}

/** Los mensajes de D1 ("D1_ERROR: UNIQUE constraint failed: transactions.user_id, transactions.id: SQLITE_CONSTRAINT") son la única señal. */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = err.cause instanceof Error ? err.cause.message : '';
  return /UNIQUE constraint failed/i.test(`${err.message} ${cause}`);
}

/** El id ya existe entre las filas de ese usuario (dos usuarios sí pueden tener filas con el mismo id). */
function duplicateId(): ApiError {
  return conflictError('A record with that id already exists.');
}

async function firstOrConflict<T>(stmt: D1PreparedStatement): Promise<T | null> {
  try {
    return await stmt.first<T>();
  } catch (err) {
    throw isUniqueViolation(err) ? duplicateId() : err;
  }
}

interface SetClause {
  sql: string;
  values: unknown[];
  columns: string[];
}

/** Arma "col = ?, …" solo con los campos presentes en el patch. Las columnas salen del mapa, nunca del cliente. */
function setClause<P extends object>(map: { readonly [K in keyof P]-?: string }, patch: P): SetClause {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const field of Object.keys(map) as (keyof P)[]) {
    const value: unknown = patch[field];
    if (value === undefined) continue;
    columns.push(map[field]);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  return { sql: columns.map((c) => `${c} = ?`).join(', '), values, columns };
}

// El nombre de una cuenta y el de una meta son únicos por usuario sin distinguir mayúsculas (el Excel identifica
// las metas por nombre y sus fórmulas tampoco distinguen; dos cuentas "PayPal" y "paypal" no se podrían elegir
// de palabra). La comparación se hace aquí y no en SQL porque lower() de SQLite solo conoce las letras ASCII
// ("TURQUÍA" y "turquía" le parecerían distintos).
const foldName = (name: string) => name.normalize('NFC').toLowerCase();
const sameName = (a: string, b: string) => foldName(a) === foldName(b);

/**
 * Las cuentas que nombra una escritura de dinero (presupuesto, fijo, transacción, envío) tienen que ser del
 * usuario y no ser de oro; devuelve el error de la primera que no cumpla.
 */
async function accountError(db: D1Database, userId: string, accountIds: readonly string[]): Promise<ApiError | null> {
  if (accountIds.length === 0) return null;
  const res = await db.prepare('SELECT id, name, currency FROM accounts WHERE user_id = ?').bind(userId).all<AccountRow>();
  const known = new Map(res.results.map((r) => [r.id, r]));
  for (const id of accountIds) {
    const account = known.get(id);
    if (!account) return unknownAccountError(id);
    if (isGold(account.currency)) return goldAccountError(account.name);
  }
  return null;
}

/** Una escritura condicionada a "el mes está abierto" no tocó nada: averigua por qué. */
async function monthWriteError(db: D1Database, userId: string, key: MonthKey): Promise<ApiError> {
  const row = await db
    .prepare('SELECT closed FROM months WHERE user_id = ? AND key = ?')
    .bind(userId, key)
    .first<{ closed: number }>();
  if (!row) return monthNotFoundError(key);
  if (row.closed === 1) return monthClosedError(key);
  // El mes se reabrió (o la fila cambió) entre la escritura y esta lectura.
  return conflictError('The month changed while it was being saved. Try again.');
}

/** Un alta en un mes no insertó nada: una cuenta que no existe (400), el mes que falta (404) o que está cerrado (409). */
async function createError(db: D1Database, userId: string, key: MonthKey, accountIds: readonly string[]): Promise<ApiError> {
  return (await accountError(db, userId, accountIds)) ?? monthWriteError(db, userId, key);
}

async function rowWriteError(
  db: D1Database,
  userId: string,
  table: MonthTable,
  id: string,
  missing: string,
  accountIds: readonly string[] = [],
): Promise<ApiError> {
  const row = await db
    .prepare(`SELECT month_key FROM ${table} WHERE user_id = ? AND id = ?`)
    .bind(userId, id)
    .first<{ month_key: string }>();
  if (!row) return notFoundError(missing);
  return (await accountError(db, userId, accountIds)) ?? monthWriteError(db, userId, row.month_key);
}

/** Los meses abiertos del usuario. Lleva un parámetro: su id. */
const OPEN_MONTHS = '(SELECT key FROM months WHERE user_id = ? AND closed = 0)';

/**
 * Condición "esa cuenta es del usuario y es de dinero" (no de oro). Lleva dos parámetros: el usuario y la cuenta.
 * Es la de todo lo que cuelga de un mes: un fijo, una transacción o un envío no pueden nombrar una cuenta de oro.
 */
const ACCOUNT_EXISTS = `EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND id = ? AND currency <> '${GOLD}')`;

/** Lo mismo dentro de un JOIN con la tabla de cuentas: `alias` es el de esa tabla. */
const moneyOnly = (alias: string) => `AND ${alias}.currency <> '${GOLD}'`;

/**
 * Edita una fila de un mes abierto. `accountIds` son las cuentas que el patch nombra (tienen que existir) y
 * `extra`, una condición más con sus parámetros; las dos van dentro del propio UPDATE.
 */
async function patchInMonth<R>(
  db: D1Database,
  userId: string,
  table: MonthTable,
  id: string,
  sets: SetClause,
  missing: string,
  accountIds: readonly string[] = [],
  extra: { sql: string; values: unknown[] } = { sql: '', values: [] },
): Promise<R> {
  if (sets.columns.length === 0) {
    // Patch vacío: no es una escritura, se devuelve la fila tal como está.
    const current = await db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND id = ?`).bind(userId, id).first<R>();
    if (!current) throw notFoundError(missing);
    return current;
  }
  const row = await db
    .prepare(
      `UPDATE ${table} SET ${sets.sql}
       WHERE user_id = ? AND id = ? AND month_key IN ${OPEN_MONTHS}${accountIds.map(() => ` AND ${ACCOUNT_EXISTS}`).join('')}${extra.sql}
       RETURNING *`,
    )
    .bind(...sets.values, userId, id, userId, ...accountIds.flatMap((accountId) => [userId, accountId]), ...extra.values)
    .first<R>();
  if (!row) throw await rowWriteError(db, userId, table, id, missing, accountIds);
  return row;
}

async function deleteInMonth(db: D1Database, userId: string, table: MonthTable, id: string, missing: string): Promise<void> {
  const row = await db
    .prepare(`DELETE FROM ${table} WHERE user_id = ? AND id = ? AND month_key IN ${OPEN_MONTHS} RETURNING id`)
    .bind(userId, id, userId)
    .first();
  if (!row) throw await rowWriteError(db, userId, table, id, missing);
}

// ── Ajustes del usuario ──────────────────────────────────────────────────────
// Tabla clave/valor por usuario: 'default_rate', 'theme' (JSON de ThemeColors; NULL = paleta original),
// 'language', 'main_currency', 'second_currency', 'default_account' (NULL = la automática), 'gold_price' (JSON de
// GoldPrice: lo que vale 1 gramo de oro; NULL o sin fila = sin precio) e 'initialized' (ya se le crearon las
// cuentas y metas iniciales).

type SettingKey =
  | 'default_rate'
  | 'theme'
  | 'language'
  | 'main_currency'
  | 'second_currency'
  | 'default_account'
  | 'gold_price'
  | 'initialized';

interface Settings {
  defaultRate: number;
  theme: ThemeColors | null;
  language: Language;
  mainCurrency: Currency;
  secondCurrency: Currency;
  /** Tal como está guardada: puede nombrar una cuenta que ya no existe (ver knownAccount). */
  defaultAccountId: string | null;
  goldPrice: GoldPrice | null;
  initialized: boolean;
}

const SELECT_SETTINGS = 'SELECT key, value FROM settings WHERE user_id = ?';

/** Un tema guardado que no se puede leer (JSON roto, falta un color) es como no tener tema. */
function readTheme(value: string | null | undefined): ThemeColors | null {
  if (!value) return null;
  try {
    const theme = normalizeTheme(JSON.parse(value));
    return isDefaultTheme(theme) ? null : theme;
  } catch {
    return null;
  }
}

/** La paleta original se guarda como NULL, para que siga al diseño si este cambia. */
function themeValue(theme: ThemeColors | null): string | null {
  if (!theme || isDefaultTheme(theme)) return null;
  return JSON.stringify({ accent: theme.accent, header: theme.header, background: theme.background });
}

/** Un precio del oro guardado que no se puede leer (JSON roto, monto que no es mayor que 0, otra moneda) es como no tenerlo. */
function readGoldPrice(value: string | null | undefined): GoldPrice | null {
  if (!value) return null;
  try {
    const price = JSON.parse(value) as { amount?: unknown; currency?: unknown } | null;
    const amount = price?.amount;
    const currency = price?.currency;
    return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && isCurrency(currency) ? { amount, currency } : null;
  } catch {
    return null;
  }
}

function goldPriceValue(price: GoldPrice | null): string | null {
  return price ? JSON.stringify({ amount: price.amount, currency: price.currency }) : null;
}

function toSettings(list: SettingRow[]): Settings {
  const map = new Map(list.map((r) => [r.key, r.value]));
  const rate = Number(map.get('default_rate'));
  const language = map.get('language');
  const main = map.get('main_currency');
  const second = map.get('second_currency');
  const mainCurrency = isCurrency(main) ? main : DEFAULT_MAIN_CURRENCY;
  let secondCurrency = isCurrency(second) ? second : DEFAULT_SECOND_CURRENCY;
  // Las dos monedas nunca pueden coincidir: si lo guardado no sirve, la segunda vuelve a una que sí.
  if (secondCurrency === mainCurrency) {
    secondCurrency = mainCurrency === DEFAULT_SECOND_CURRENCY ? DEFAULT_MAIN_CURRENCY : DEFAULT_SECOND_CURRENCY;
  }
  return {
    defaultRate: rate > 0 ? rate : DEFAULT_RATE,
    theme: readTheme(map.get('theme')),
    language: isLanguage(language) ? language : DEFAULT_LANGUAGE,
    mainCurrency,
    secondCurrency,
    defaultAccountId: map.get('default_account') || null,
    goldPrice: readGoldPrice(map.get('gold_price')),
    initialized: map.has('initialized'),
  };
}

/**
 * La cuenta por defecto guardada solo vale si sigue existiendo y es de dinero (`accountIds` son las que pueden
 * serlo: una que pasó a ser de oro ya no cuenta); si no, null (la automática de shared/calc).
 */
function knownAccount(id: string | null, accountIds: ReadonlySet<string>): string | null {
  return id !== null && accountIds.has(id) ? id : null;
}

function setSetting(db: D1Database, userId: string, key: SettingKey, value: string | null): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
    )
    .bind(userId, key, value);
}

/** Como setSetting, pero respeta el valor que ya hubiera. */
function setSettingIfMissing(db: D1Database, userId: string, key: SettingKey, value: string): D1PreparedStatement {
  return db
    .prepare('INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING')
    .bind(userId, key, value);
}

/** Las dos lecturas con las que se arman los ajustes: lo guardado y las cuentas que existen. */
function settingsStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [db.prepare(SELECT_SETTINGS).bind(userId), db.prepare('SELECT id, name, currency FROM accounts WHERE user_id = ?').bind(userId)];
}

type AccountRef = Pick<AccountRow, 'id' | 'name' | 'currency'>;

const moneyIds = (accounts: readonly Pick<AccountRow, 'id' | 'currency'>[]) => new Set(accounts.filter((a) => !isGold(a.currency)).map((a) => a.id));

function settingsFrom(settings: D1Result<unknown> | undefined, accounts: D1Result<unknown> | undefined) {
  const stored = toSettings(rows<SettingRow>(settings));
  const accountList = rows<AccountRef>(accounts);
  const response: SettingsResponse = {
    theme: stored.theme,
    language: stored.language,
    mainCurrency: stored.mainCurrency,
    secondCurrency: stored.secondCurrency,
    defaultAccountId: knownAccount(stored.defaultAccountId, moneyIds(accountList)),
    goldPrice: stored.goldPrice,
  };
  return { response, accounts: new Map(accountList.map((a) => [a.id, a])) };
}

/**
 * Los ajustes del usuario. Sin nada guardado (o ilegible): la paleta original (null), el idioma y las monedas
 * por defecto, y la cuenta por defecto automática (null).
 */
export async function getSettings(db: D1Database, userId: string): Promise<SettingsResponse> {
  const [settings, accounts] = await db.batch(settingsStatements(db, userId));
  return settingsFrom(settings, accounts).response;
}

/**
 * Cambia solo lo que venga en `update` (ya validado) y devuelve cómo quedan los ajustes. Las dos monedas se
 * comprueban sobre el par resultante (lo que hay más lo que cambia): mandar las dos intercambiadas vale; mandar
 * una igual a la otra que ya tiene, no (400). La cuenta por defecto tiene que ser una del usuario y de dinero,
 * no de oro (400), o null. Si algo no cumple no se guarda nada.
 */
export async function updateSettings(db: D1Database, userId: string, update: SettingsUpdate): Promise<SettingsResponse> {
  const stmts: D1PreparedStatement[] = [];
  if (update.theme !== undefined) stmts.push(setSetting(db, userId, 'theme', themeValue(update.theme)));
  if (update.language !== undefined) stmts.push(setSetting(db, userId, 'language', update.language));
  if (update.goldPrice !== undefined) stmts.push(setSetting(db, userId, 'gold_price', goldPriceValue(update.goldPrice)));

  const currencies = update.mainCurrency !== undefined || update.secondCurrency !== undefined;
  const account = update.defaultAccountId;
  if (currencies || account != null) {
    // Lo que hay ahora, para comprobar el resultado antes de escribir nada.
    const [settings, accounts] = await db.batch(settingsStatements(db, userId));
    const { response: current, accounts: known } = settingsFrom(settings, accounts);
    if (currencies) {
      const main = update.mainCurrency ?? current.mainCurrency;
      const second = update.secondCurrency ?? current.secondCurrency;
      if (main === second) throw validationError(invalidData(`secondCurrency: ${SAME_CURRENCY}`));
      // Se escriben las dos, no solo la que vino: así lo guardado es siempre un par válido.
      stmts.push(setSetting(db, userId, 'main_currency', main), setSetting(db, userId, 'second_currency', second));
    }
    if (account != null) {
      const chosen = known.get(account);
      if (!chosen) throw unknownAccountError(account);
      if (isGold(chosen.currency)) throw goldAccountError(chosen.name);
      // La fila sale de las cuentas del usuario: si la cuenta se borró entre la lectura y esto, no se guarda.
      stmts.push(
        db
          .prepare(
            `INSERT INTO settings (user_id, key, value)
             SELECT a.user_id, 'default_account', a.id FROM accounts a WHERE a.user_id = ?1 AND a.id = ?2 ${moneyOnly('a')}
             ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
          )
          .bind(userId, account),
      );
    }
  }
  if (account === null) stmts.push(setSetting(db, userId, 'default_account', null));

  const results = await db.batch([...stmts, ...settingsStatements(db, userId)]);
  return settingsFrom(results[results.length - 2], results[results.length - 1]).response;
}

// ── Lectura ──────────────────────────────────────────────────────────────────

async function readState(db: D1Database, userId: string): Promise<{ state: AppState; initialized: boolean }> {
  const [months, accounts, budgets, rates, fixed, transfers, tx, outside, cardPayments, monthCards, cards, incomes, goals, contribs, settings] = await db.batch([
    db.prepare('SELECT * FROM months WHERE user_id = ? ORDER BY key').bind(userId),
    db.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare(`SELECT * FROM month_budget_log WHERE user_id = ? ORDER BY ${BY_DATE}`).bind(userId),
    db.prepare(`SELECT * FROM month_rates WHERE user_id = ? ORDER BY ${BY_DATE}`).bind(userId),
    db.prepare(`SELECT * FROM fixed_expenses WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM transfers WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare(`SELECT * FROM outside_expenses WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare(`SELECT * FROM card_payments WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM month_cards WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare(`SELECT * FROM credit_cards WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare(`SELECT * FROM goals WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM contributions WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare(SELECT_SETTINGS).bind(userId),
  ]);

  const accountList = rows<AccountRow>(accounts).map(toAccount);
  const stored = toSettings(rows<SettingRow>(settings));
  return {
    state: {
      months: toMonths(rows<MonthRow>(months), {
        budgetLog: rows<BudgetLogRow>(budgets),
        rates: rows<RateRow>(rates),
        fixed: rows<FixedRow>(fixed),
        transfers: rows<TransferRow>(transfers),
        tx: rows<TxRow>(tx),
        outside: rows<OutsideRow>(outside),
        cardPayments: rows<CardPaymentRow>(cardPayments),
        monthCards: rows<MonthCardRow>(monthCards),
      }),
      accounts: accountList,
      cards: rows<CreditCardRow>(cards).map(toCreditCard),
      incomes: rows<IncomeRow>(incomes).map(toIncome),
      goals: rows<GoalRow>(goals).map(toGoal),
      contribs: rows<ContributionRow>(contribs).map(toContribution),
      mainCurrency: stored.mainCurrency,
      secondCurrency: stored.secondCurrency,
      defaultAccountId: knownAccount(stored.defaultAccountId, moneyIds(accountList)),
      defaultRate: stored.defaultRate,
      goldPrice: stored.goldPrice,
      theme: stored.theme,
      language: stored.language,
    },
    initialized: stored.initialized,
  };
}

/** Todo el histórico del usuario en un solo viaje a D1. Solo lee: un usuario que nunca entró sale vacío. */
export async function loadState(db: D1Database, userId: string): Promise<AppState> {
  return (await readState(db, userId)).state;
}

/**
 * Sentencias de la primera visita de un usuario: sus cuentas y metas iniciales, su tasa por defecto y la marca
 * 'initialized'. Van condicionadas en SQL para no depender de una lectura previa: si el usuario ya está
 * marcado no crean nada (quien borró o renombró lo suyo no lo recupera) y dos primeras visitas a la vez no
 * duplican. Una cuenta o una meta inicial tampoco se crea si ya hay otra con su id o con su nombre.
 */
function initStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  const fresh = "NOT EXISTS (SELECT 1 FROM settings WHERE user_id = ?1 AND key = 'initialized')";
  return [
    ...DEFAULT_ACCOUNTS.map((a) =>
      db
        .prepare(
          `INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(sort) FROM accounts WHERE user_id = ?1), -1) + 1
           WHERE ${fresh}
             AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = ?1 AND (id = ?2 OR lower(name) = lower(?3)))`,
        )
        .bind(userId, a.id, a.name, a.currency, a.opening, a.hidden ? 1 : 0),
    ),
    ...DEFAULT_GOALS.map((g) =>
      db
        .prepare(
          `INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, approx_currency, sort)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE((SELECT MAX(sort) FROM goals WHERE user_id = ?1), -1) + 1
           WHERE ${fresh}
             AND NOT EXISTS (SELECT 1 FROM goals WHERE user_id = ?1 AND (id = ?2 OR lower(name) = lower(?3)))`,
        )
        .bind(userId, g.id, g.name, g.cur, g.monthly, g.start, g.end, g.approxCur),
    ),
    setSettingIfMissing(db, userId, 'default_rate', String(DEFAULT_RATE)),
    setSettingIfMissing(db, userId, 'initialized', '1'),
  ];
}

/** Prepara a un usuario la primera vez que se le ve (ver initStatements), en un batch. Llamarla de más no hace nada. */
export async function initUser(db: D1Database, userId: string): Promise<void> {
  await db.batch(initStatements(db, userId));
}

/**
 * El histórico del usuario, preparándolo antes si nunca se le había visto (initUser): así tiene cuentas en las
 * que registrar. No crea ningún mes. Es de lo que parte lo que necesita todo el histórico y puede llegar sin
 * que haya abierto la web (un Excel que importa). Para resolver solo una cuenta, ver userAccounts.
 */
export async function userState(db: D1Database, userId: string): Promise<AppState> {
  const { state, initialized } = await readState(db, userId);
  if (initialized) return state;
  await initUser(db, userId);
  return loadState(db, userId);
}

/**
 * Las cuentas del usuario (todas, en su orden) y cuál es su cuenta por defecto (defaultAccount de shared/calc.ts:
 * la elegida en los ajustes si sigue visible; si no, la primera visible en su moneda principal…), preparándolo
 * antes si nunca se le había visto. Es lo que necesita una escritura que no dice de qué cuenta sale, o que la
 * nombra de palabra; no carga el histórico. `defaultAccount` solo es null si el usuario no tiene ninguna cuenta.
 */
export async function userAccounts(db: D1Database, userId: string): Promise<{ accounts: Account[]; defaultAccount: Account | null }> {
  const read = async () => {
    const [accounts, settings] = await db.batch([
      db.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
      db.prepare(SELECT_SETTINGS).bind(userId),
    ]);
    return { accounts: rows<AccountRow>(accounts).map(toAccount), stored: toSettings(rows<SettingRow>(settings)) };
  };
  let { accounts, stored } = await read();
  if (!stored.initialized) {
    await initUser(db, userId);
    ({ accounts, stored } = await read());
  }
  // defaultAccount solo mira las cuentas y los ajustes: el resto del estado va vacío.
  const { initialized: _initialized, ...settings } = stored;
  return { accounts, defaultAccount: defaultAccount({ ...settings, accounts, months: {}, incomes: [], goals: [], contribs: [], cards: [] }) };
}

/**
 * El histórico del usuario para abrir la app (GET /api/state), dejándolo listo si hace falta: la primera vez
 * se le crean sus cuentas y metas iniciales (initUser) y, si no tiene ningún mes, el mes `key` (por defecto,
 * el actual). Quien borra todos sus meses encuentra así otra vez el mes en curso.
 */
export async function openState(db: D1Database, userId: string, key: MonthKey = currentMonthKey()): Promise<AppState> {
  const { state, initialized } = await readState(db, userId);
  const noMonths = Object.keys(state.months).length === 0;
  if (initialized && !noMonths) return state;
  if (!initialized) await initUser(db, userId);
  if (noMonths) await ensureMonth(db, userId, key);
  return loadState(db, userId);
}

/** Resumen de cada mes en la moneda principal del usuario, calculado igual que en el frontend (shared/calc). */
export async function listMonths(db: D1Database, userId: string): Promise<MonthSummary[]> {
  const state = await loadState(db, userId);
  return sortedKeys(state).map((key) => {
    const m = state.months[key]!;
    const c = monthCalc(state, key);
    return { key, closed: m.closed, closedAt: m.closedAt, main: c.main, budget: c.budget, used: c.used, txCount: c.txCount };
  });
}

/** Las lecturas de un mes completo; `monthFrom` arma el mes con sus resultados. */
function monthStatements(db: D1Database, userId: string, key: MonthKey): D1PreparedStatement[] {
  return [
    db.prepare('SELECT * FROM months WHERE user_id = ? AND key = ?').bind(userId, key),
    db.prepare(`SELECT * FROM month_budget_log WHERE user_id = ? AND month_key = ? ORDER BY ${BY_DATE}`).bind(userId, key),
    db.prepare(`SELECT * FROM month_rates WHERE user_id = ? AND month_key = ? ORDER BY ${BY_DATE}`).bind(userId, key),
    db.prepare(`SELECT * FROM fixed_expenses WHERE user_id = ? AND month_key = ? ORDER BY ${BY_SORT}`).bind(userId, key),
    db.prepare('SELECT * FROM transfers WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
    db.prepare('SELECT * FROM transactions WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
    db.prepare(`SELECT * FROM outside_expenses WHERE user_id = ? AND month_key = ? ORDER BY ${BY_SORT}`).bind(userId, key),
    db.prepare(`SELECT * FROM card_payments WHERE user_id = ? AND month_key = ? ORDER BY ${BY_SORT}`).bind(userId, key),
    db.prepare('SELECT * FROM month_cards WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
  ];
}

const MONTH_READS = 9;

/** El mes que leyeron las últimas sentencias de un batch (monthStatements), o null si el usuario no lo tiene. */
function monthFrom(results: D1Result<unknown>[], key: MonthKey): Month | null {
  const [month, budgets, rates, fixed, transfers, tx, outside, cardPayments, monthCards] = results.slice(-MONTH_READS);
  const months = toMonths(rows<MonthRow>(month), {
    budgetLog: rows<BudgetLogRow>(budgets),
    rates: rows<RateRow>(rates),
    fixed: rows<FixedRow>(fixed),
    transfers: rows<TransferRow>(transfers),
    tx: rows<TxRow>(tx),
    outside: rows<OutsideRow>(outside),
    cardPayments: rows<CardPaymentRow>(cardPayments),
    monthCards: rows<MonthCardRow>(monthCards),
  });
  return months[key] ?? null;
}

/** El mes completo (presupuesto, tasas, fijos, envíos y transacciones), o null si el usuario no lo tiene. */
export async function getMonth(db: D1Database, userId: string, key: MonthKey): Promise<Month | null> {
  return monthFrom(await db.batch(monthStatements(db, userId, key)), key);
}

async function requireMonth(db: D1Database, userId: string, key: MonthKey): Promise<Month> {
  const month = await getMonth(db, userId, key);
  if (!month) throw monthNotFoundError(key);
  return month;
}

// ── Cuentas ──────────────────────────────────────────────────────────────────

const ACCOUNT_PATCH = { name: 'name', currency: 'currency', opening: 'opening', hidden: 'hidden', sort: 'sort' } as const;
const NO_ACCOUNT = 'Account not found.';

/**
 * "Algo usa la cuenta": un gasto fijo, una transacción, un gasto fuera de presupuesto, un envío (de salida o de llegada), un ingreso o un
 * movimiento del presupuesto de algún mes, un pago de la tarjeta de crédito o un aporte a una meta. ?1 es el usuario y ?2, la cuenta.
 */
const ACCOUNT_IN_USE = `(
  EXISTS (SELECT 1 FROM fixed_expenses WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM card_payments WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM transactions WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM outside_expenses WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM transfers WHERE user_id = ?1 AND (from_account_id = ?2 OR to_account_id = ?2))
  OR EXISTS (SELECT 1 FROM incomes WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM contributions WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM month_budget_log WHERE user_id = ?1 AND account_id = ?2))`;

function accountNameTaken(): ApiError {
  return conflictError('There is already an account with that name.');
}

/** Las cuentas del usuario (también las ocultas), en su orden. */
export async function listAccounts(db: D1Database, userId: string): Promise<Account[]> {
  const res = await db.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId).all<AccountRow>();
  return res.results.map(toAccount);
}

/** La cuenta nueva va al final: sort = max(sort) + 1. 409 `conflict` si el usuario ya tiene otra con ese nombre. */
export async function createAccount(db: D1Database, userId: string, input: AccountCreate): Promise<Account> {
  if ((await listAccounts(db, userId)).some((a) => sameName(a.name, input.name))) throw accountNameTaken();

  // El NOT EXISTS repite la regla del nombre dentro de la propia escritura: dos altas iguales a la vez
  // (un doble clic) pasarían las dos la lectura de arriba.
  const row = await firstOrConflict<AccountRow>(
    db
      .prepare(
        `INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort)
         SELECT ?1, ?2, ?3, ?4, ?5, 0, COALESCE((SELECT MAX(sort) FROM accounts WHERE user_id = ?1), -1) + 1
         WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = ?1 AND lower(name) = lower(?3))
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.name, input.currency, input.opening ?? 0),
  );
  if (!row) throw accountNameTaken();
  return toAccount(row);
}

/**
 * Edita una cuenta: nombre, saldo inicial ("corregir el saldo" es ajustar este número, ver openingFor en
 * shared/calc.ts), oculta y orden. La moneda solo se puede cambiar mientras nada use la cuenta (409): sus
 * movimientos y su parte del presupuesto están escritos pensando en la que tiene.
 */
export async function patchAccount(db: D1Database, userId: string, id: string, patch: AccountPatch): Promise<Account> {
  const accounts = await listAccounts(db, userId);
  const current = accounts.find((a) => a.id === id);
  if (!current) throw notFoundError(NO_ACCOUNT);
  const name = patch.name;
  if (name !== undefined && accounts.some((a) => a.id !== id && sameName(a.name, name))) throw accountNameTaken();

  const sets = setClause<AccountPatch>(ACCOUNT_PATCH, patch);
  // Patch vacío: no es una escritura, se devuelve la cuenta tal como está.
  if (sets.columns.length === 0) return current;
  // La condición va en el UPDATE (y no sobre la moneda leída arriba) para que no dependa de esa lectura.
  // Escribir la moneda que ya tiene no es un cambio.
  const guard = patch.currency === undefined ? '' : ` AND (currency = ?3 OR NOT ${ACCOUNT_IN_USE})`;
  const offset = patch.currency === undefined ? 3 : 4;
  const row = await db
    .prepare(
      `UPDATE accounts SET ${sets.columns.map((column, i) => `${column} = ?${i + offset}`).join(', ')}
       WHERE user_id = ?1 AND id = ?2${guard} RETURNING *`,
    )
    .bind(userId, id, ...(patch.currency === undefined ? [] : [patch.currency]), ...sets.values)
    .first<AccountRow>();
  if (row) return toAccount(row);
  const exists = await db.prepare('SELECT 1 AS found FROM accounts WHERE user_id = ? AND id = ?').bind(userId, id).first();
  throw exists ? conflictError('The account is in use: its currency cannot be changed.') : notFoundError(NO_ACCOUNT);
}

/**
 * Borra una cuenta que nada usa. Si algo la usa (un fijo, una transacción, un envío, un ingreso o una parte
 * del presupuesto) responde 409: esa cuenta se oculta, no se borra. Tampoco se puede borrar la última, ni la
 * última de dinero aunque queden cuentas de oro: el usuario siempre tiene al menos una de la que pagar. Si era
 * su cuenta por defecto, vuelve a la automática.
 */
export async function deleteAccount(db: D1Database, userId: string, id: string): Promise<void> {
  const [deleted] = await db.batch([
    db
      .prepare(
        `DELETE FROM accounts WHERE user_id = ?1 AND id = ?2 AND NOT ${ACCOUNT_IN_USE}
         AND (SELECT COUNT(*) FROM accounts WHERE user_id = ?1) > 1
         AND (currency = '${GOLD}' OR (SELECT COUNT(*) FROM accounts WHERE user_id = ?1 AND currency <> '${GOLD}') > 1)
         RETURNING id`,
      )
      .bind(userId, id),
    db
      .prepare(
        `DELETE FROM settings WHERE user_id = ?1 AND key = 'default_account' AND value = ?2
         AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = ?1 AND id = ?2)`,
      )
      .bind(userId, id),
  ]);
  if (rows(deleted).length > 0) return;

  const why = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM accounts WHERE user_id = ?1 AND id = ?2) AS found, ${ACCOUNT_IN_USE} AS used`,
    )
    .bind(userId, id)
    .first<{ found: number; used: number }>();
  if (!why?.found) throw notFoundError(NO_ACCOUNT);
  throw why.used
    ? conflictError('The account is in use: hide it instead of deleting it.')
    : conflictError('The last account cannot be deleted: there must always be one.');
}

/** La cuenta por defecto del usuario, para las altas que no dicen de cuál sale. */
async function defaultAccountId(db: D1Database, userId: string): Promise<string> {
  const { defaultAccount: account } = await userAccounts(db, userId);
  // Solo le pasa a quien se quedó sin cuentas por fuera de la API (borrar la última está prohibido).
  if (!account) throw noAccountsError();
  return account.id;
}

// ── Meses ────────────────────────────────────────────────────────────────────

/** Tras un batch de escrituras condicionadas a "el mes está abierto": si no lo estaba, no se escribió nada. */
function writtenMonth(results: D1Result<unknown>[], key: MonthKey): Month {
  const month = monthFrom(results, key);
  if (!month) throw monthNotFoundError(key);
  if (month.closed) throw monthClosedError(key);
  return month;
}

/** Fecha de un movimiento que se escribe ahora en el mes `key`: hoy (en la zona de los usuarios), llevado al mes si cae fuera. */
function entryDate(key: MonthKey, now: Date): ISODate {
  return clampToMonth(todayISO(now), key);
}

/** Suma del registro del presupuesto de una cuenta en un mes. ?1 usuario, ?2 mes, ?3 cuenta. */
const LOG_SUM = 'COALESCE((SELECT SUM(amount) FROM month_budget_log WHERE user_id = ?1 AND month_key = ?2 AND account_id = ?3), 0)';

/**
 * Fija la parte del presupuesto de las cuentas que vengan (cuenta → monto en la moneda de esa cuenta): por cada
 * una añade al registro un movimiento con la diferencia entre ese monto y lo que suma hoy su registro; si no hay
 * diferencia, nada. El movimiento es 'initial' si la cuenta no tenía ninguno en el mes y 'adjust' si ya tenía,
 * con fecha de hoy llevada al mes. La diferencia se calcula dentro del propio INSERT, no con una lectura previa:
 * dos guardados seguidos del mismo monto no lo suman dos veces. Toda cuenta nombrada tiene que ser del usuario
 * (400). Los ingresos que suben el presupuesto y los envíos que lo mueven no entran en esta cuenta: se fija lo
 * que suma el registro.
 */
export async function patchMonth(db: D1Database, userId: string, key: MonthKey, patch: MonthPatch, now: Date = new Date()): Promise<Month> {
  const parts = Object.entries(patch.budgets ?? {});
  // Patch vacío: no es una escritura, se devuelve el mes tal como está (también si está cerrado).
  if (parts.length === 0) return requireMonth(db, userId, key);

  // Se comprueba antes de escribir para no aplicar unas partes sí y otras no.
  const unknown = await accountError(db, userId, parts.map(([accountId]) => accountId));
  if (unknown) throw unknown;

  const date = entryDate(key, now);
  const results = await db.batch([
    ...parts.map(([accountId, amount]) =>
      db
        .prepare(
          // ROUND quita el ruido de la coma flotante: una diferencia de 1e-12 no es un cambio.
          `INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note)
           SELECT m.user_id, ?4, m.key, ?5, a.id, ROUND(?6 - ${LOG_SUM}, 6),
                  CASE WHEN EXISTS (SELECT 1 FROM month_budget_log WHERE user_id = ?1 AND month_key = ?2 AND account_id = ?3)
                       THEN 'adjust' ELSE 'initial' END, ''
           FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?3 ${moneyOnly('a')}
           WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0 AND ROUND(?6 - ${LOG_SUM}, 6) <> 0`,
        )
        .bind(userId, key, accountId, newId(), date, amount),
    ),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

const NO_BUDGET_ENTRY = 'Budget entry not found.';

function outsideMonth(field: string, key: MonthKey): ApiError {
  return validationError(invalidData(`${field}: must be a date in ${key}`));
}

/**
 * Añade un movimiento al registro del presupuesto del mes: suma (o resta) `amount` a la parte de esa cuenta.
 * Sin fecha lleva la de hoy, llevada al mes; con fecha, tiene que caer dentro del mes (400). 'leftover' no se
 * escribe por aquí (addLeftover).
 */
export async function addBudgetEntry(
  db: D1Database,
  userId: string,
  key: MonthKey,
  input: BudgetEntryCreate,
  now: Date = new Date(),
): Promise<Month> {
  if (input.date !== undefined && !inMonth(input.date, key)) throw outsideMonth('date', key);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note)
           SELECT m.user_id, ?3, m.key, ?4, a.id, ?6, ?7, ?8
           FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?5 ${moneyOnly('a')}
           WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0 RETURNING id`,
        )
        .bind(userId, key, input.id ?? newId(), input.date ?? entryDate(key, now), input.accountId, input.amount, input.kind ?? 'adjust', input.note ?? ''),
      ...monthStatements(db, userId, key),
    ]);
  } catch (err) {
    throw isUniqueViolation(err) ? duplicateId() : err;
  }
  if (rows(results[0]).length === 0) throw await createError(db, userId, key, [input.accountId]);
  return writtenMonth(results, key);
}

/** Quita un movimiento del registro del presupuesto de un mes abierto; 404 si ese mes no lo tiene. */
export async function deleteBudgetEntry(db: D1Database, userId: string, key: MonthKey, id: string): Promise<Month> {
  const results = await db.batch([
    db
      .prepare(`DELETE FROM month_budget_log WHERE user_id = ? AND month_key = ? AND id = ? AND month_key IN ${OPEN_MONTHS} RETURNING id`)
      .bind(userId, key, id, userId),
    ...monthStatements(db, userId, key),
  ]);
  const month = writtenMonth(results, key);
  if (rows(results[0]).length === 0) throw notFoundError(NO_BUDGET_ENTRY);
  return month;
}

/**
 * Sentencia que suma un sobrante al presupuesto del mes `key`: un movimiento 'leftover' en `accountId`, solo si
 * el mes está abierto y todavía no tiene uno (el índice único budget_log_leftover lo garantiza además).
 */
function leftoverStatement(db: D1Database, userId: string, key: MonthKey, accountId: string, amount: number, date: ISODate): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note)
       SELECT m.user_id, ?3, m.key, ?4, a.id, ?6, 'leftover', ''
       FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?5 ${moneyOnly('a')}
       WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0
         AND NOT EXISTS (SELECT 1 FROM month_budget_log WHERE user_id = ?1 AND month_key = ?2 AND kind = 'leftover')
       RETURNING id`,
    )
    .bind(userId, key, newId(), date, accountId, amount);
}

/**
 * Lo que sobró del mes `from` (su disponible: presupuesto − usado, en la moneda principal) tal como se suma al
 * mes `to`: en la cuenta por defecto del usuario y en su moneda, convertido con la última tasa del mes `to`.
 */
function leftoverEntry(state: AppState, from: MonthKey, to: MonthKey): { accountId: string; amount: number } {
  const account = defaultAccount(state);
  if (!account) throw noAccountsError();
  const leftover = monthCalc(state, from).avail;
  return { accountId: account.id, amount: convert(state, to, leftover, state.mainCurrency, account.currency) };
}

function leftoverTaken(key: MonthKey): ApiError {
  return conflictError(`The leftover of the previous month was already added to ${key}.`);
}

/**
 * Suma al presupuesto del mes `key` lo que sobró del mes registrado anterior (leftoverFor en shared/calc.ts),
 * como un movimiento 'leftover' con fecha de hoy llevada al mes. Si sobró en negativo, el movimiento es
 * negativo. 400 si no hay mes anterior; 409 `conflict` si el mes ya tiene el suyo; 409 `month_closed` si está
 * cerrado. La cifra sale del estado leído justo antes: no hay forma de calcularla dentro de la escritura.
 */
export async function addLeftover(db: D1Database, userId: string, key: MonthKey, now: Date = new Date()): Promise<Month> {
  const state = await loadState(db, userId);
  const month = state.months[key];
  if (!month) throw monthNotFoundError(key);
  if (month.closed) throw monthClosedError(key);
  const { previousKey, added } = leftoverFor(state, key);
  if (previousKey === null) throw validationError(`There is no month before ${key} to take a leftover from.`);
  if (added) throw leftoverTaken(key);

  const entry = leftoverEntry(state, previousKey, key);
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      leftoverStatement(db, userId, key, entry.accountId, entry.amount, entryDate(key, now)),
      ...monthStatements(db, userId, key),
    ]);
  } catch (err) {
    throw isUniqueViolation(err) ? leftoverTaken(key) : err;
  }
  const written = writtenMonth(results, key);
  // Otra petición lo sumó entre la lectura y la escritura.
  if (rows(results[0]).length === 0) throw leftoverTaken(key);
  return written;
}

/**
 * Escribe la tasa de un par desde una fecha del mes (1 `from` = `rate` `to`). Hay una por par y fecha, en el
 * sentido en que se escribió la última vez: escribir USD → DOP sustituye a la DOP → USD de esa misma fecha.
 * Las de otras fechas no se tocan: siguen valiendo para lo registrado entre su fecha y esta.
 */
export async function setMonthRate(db: D1Database, userId: string, key: MonthKey, rate: MonthRate): Promise<Month> {
  if (!inMonth(rate.date, key)) throw outsideMonth('date', key);
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM month_rates WHERE user_id = ? AND month_key = ? AND from_currency = ? AND to_currency = ? AND date = ? AND month_key IN ${OPEN_MONTHS}`,
      )
      .bind(userId, key, rate.to, rate.from, rate.date, userId),
    db
      .prepare(
        `INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, date, rate)
         SELECT m.user_id, m.key, ?3, ?4, ?5, ?6 FROM months m WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0
         ON CONFLICT(user_id, month_key, from_currency, to_currency, date) DO UPDATE SET rate = excluded.rate`,
      )
      .bind(userId, key, rate.from, rate.to, rate.date, rate.rate),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/**
 * Quita la tasa escrita de ese par y esa fecha, esté guardada en un sentido o en el otro; a partir de ahí vale
 * la anterior del par o, si no hay, lo que resuelva rateFor (shared/calc.ts). Si el mes no tenía esa tasa no
 * cambia nada: devuelve el mes igual.
 */
export async function deleteMonthRate(
  db: D1Database,
  userId: string,
  key: MonthKey,
  from: Currency,
  to: Currency,
  date: ISODate,
): Promise<Month> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM month_rates WHERE user_id = ? AND month_key = ? AND date = ?
         AND ((from_currency = ? AND to_currency = ?) OR (from_currency = ? AND to_currency = ?)) AND month_key IN ${OPEN_MONTHS}`,
      )
      .bind(userId, key, date, from, to, to, from, userId),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/** El mes registrado anterior más cercano a ?2 del usuario ?1. */
const PREVIOUS_MONTH = '(SELECT MAX(key) FROM months WHERE user_id = ?1 AND key < ?2)';

/**
 * Copia a `key` los ingresos recurrentes del mes registrado anterior más cercano (el mismo que usan los fijos y
 * el presupuesto), dentro del batch que crea el mes: o se crea el mes con sus copias o no se crea nada, y como el
 * INSERT del mes falla si ya existe, abrirlo otra vez o correr el flujo dos veces no copia de nuevo. La copia
 * lleva la misma descripción, cuenta, monto, moneda y casilla de presupuesto, sigue siendo recurrente (así la
 * cadena continúa), cae el mismo día del mes recortado al largo del nuevo, y su tasa vuelve a ser automática
 * porque la manual era de aquella operación. Si el mes nuevo ya tiene un ingreso con la misma descripción, cuenta,
 * monto y moneda (lo cargó el usuario o Claude antes de que el mes existiera), no se duplica. Dos recurrentes
 * idénticos del mes anterior sí se copian los dos: la comparación es contra lo que ya había, no contra la copia.
 */
function recurringIncomesStatement(db: D1Database, userId: string, key: MonthKey): D1PreparedStatement {
  const last = Number(lastDay(key).slice(8));
  return db
    .prepare(
      `INSERT INTO incomes (user_id, id, date, description, account_id, amount, currency, budget, rate, recurring)
       SELECT ?1, lower(hex(randomblob(16))), ?2 || '-' || printf('%02d', MIN(CAST(substr(i.date, 9, 2) AS INTEGER), ?3)),
              i.description, i.account_id, i.amount, i.currency, i.budget, NULL, 1
       FROM incomes i
       WHERE i.user_id = ?1 AND i.recurring = 1 AND substr(i.date, 1, 7) = ${PREVIOUS_MONTH}
         AND NOT EXISTS (
           SELECT 1 FROM incomes n WHERE n.user_id = ?1 AND substr(n.date, 1, 7) = ?2 AND n.description = i.description
             AND n.account_id = i.account_id AND n.amount = i.amount AND n.currency = i.currency)
       ORDER BY i.rowid`,
    )
    .bind(userId, key, last);
}

/**
 * Sentencias que crean `key` con los fijos del mes anterior más cercano del usuario (sin pagar, con su cuenta
 * y con ids nuevos); si no hay mes anterior, queda sin fijos. Las tasas no se copian: la última escrita sigue
 * vigente hasta que se escriba otra (rateFor). Todo en SQL para que la copia sea atómica dentro del batch.
 * El INSERT del mes falla (UNIQUE) si el mes ya existe.
 */
function createMonthStatements(db: D1Database, userId: string, key: MonthKey): D1PreparedStatement[] {
  return [
    db.prepare('INSERT INTO months (user_id, key) VALUES (?1, ?2)').bind(userId, key),
    recurringIncomesStatement(db, userId, key),
    db
      .prepare(
        `INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort, on_card, card_id)
         SELECT ?1, lower(hex(randomblob(16))), ?2, name, day, amount, currency, 0, account_id, sort, on_card, card_id
         FROM fixed_expenses WHERE user_id = ?1 AND month_key = ${PREVIOUS_MONTH} ORDER BY ${BY_SORT}`,
      )
      .bind(userId, key),
  ];
}

/**
 * Sentencia que arranca el presupuesto de un mes recién creado con las partes del mes anterior más cercano:
 * un movimiento 'initial' por cuenta, con fecha del primer día, por lo que suma el registro de esa cuenta en el
 * mes anterior (los ingresos que subieron aquel presupuesto no se heredan). Va después de createMonthStatements.
 */
function copyBudgetStatement(db: D1Database, userId: string, key: MonthKey): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note)
       SELECT ?1, lower(hex(randomblob(16))), ?2, ?3, account_id, ROUND(SUM(amount), 6), 'initial', ''
       FROM month_budget_log WHERE user_id = ?1 AND month_key = ${PREVIOUS_MONTH}
       GROUP BY account_id HAVING ROUND(SUM(amount), 6) <> 0 ORDER BY MIN(rowid)`,
    )
    .bind(userId, key, firstDay(key));
}

/** Como copyBudgetStatement, pero con las partes que se indican (cuenta → monto; un 0 no deja movimiento). */
function initialBudgetStatements(db: D1Database, userId: string, key: MonthKey, budgets: Record<string, number>): D1PreparedStatement[] {
  return insertMany(
    db,
    'month_budget_log',
    BUDGET_LOG_INSERT,
    Object.entries(budgets)
      .filter(([, amount]) => amount !== 0)
      .map(([accountId, amount]) => [userId, newId(), key, firstDay(key), accountId, amount, 'initial', '']),
  );
}

/**
 * Devuelve el mes `key` del usuario, creándolo si falta con los fijos y las partes del presupuesto del mes
 * anterior más cercano (createMonthStatements, copyBudgetStatement). `created` dice si lo creó esta llamada.
 * No mira si está cerrado: eso lo decide quien llama.
 */
export async function ensureMonth(db: D1Database, userId: string, key: MonthKey): Promise<{ month: Month; created: boolean }> {
  if (!isMonthKey(key)) throw validationError('Invalid month (expected YYYY-MM).');
  const existing = await getMonth(db, userId, key);
  if (existing) return { month: existing, created: false };

  let created = true;
  try {
    await db.batch([...createMonthStatements(db, userId, key), copyBudgetStatement(db, userId, key)]);
  } catch (err) {
    // Otra petición lo creó entre la lectura y el batch: vale el suyo.
    if (!isUniqueViolation(err)) throw err;
    created = false;
  }
  return { month: await requireMonth(db, userId, key), created };
}

/**
 * Cierra el mes y, si el siguiente no existe, lo crea con los mismos fijos sin pagar y su presupuesto inicial,
 * todo en un batch: un movimiento 'initial' por cuenta con las partes de `request.budgets` o, si no vienen, las
 * del mes que se cierra; con `request.addLeftover`, además el sobrante del mes que se cierra (como addLeftover).
 * Si el mes siguiente ya existe no se le toca nada. Cerrar un mes ya cerrado no cambia nada (conserva su
 * closed_at), para que un reintento no falle.
 */
export async function closeMonth(
  db: D1Database,
  userId: string,
  key: MonthKey,
  request: CloseRequest = {},
  now: Date = new Date(),
): Promise<CloseResponse> {
  const next = nextKey(key);
  const found = await db
    .prepare('SELECT key FROM months WHERE user_id = ?1 AND key IN (?2, ?3)')
    .bind(userId, key, next)
    .all<{ key: string }>();
  const have = new Set(found.results.map((r) => r.key));
  if (!have.has(key)) throw monthNotFoundError(key);

  const close = () =>
    db
      .prepare(
        `UPDATE months
         SET closed_at = CASE WHEN closed = 1 AND closed_at IS NOT NULL THEN closed_at ELSE ?1 END, closed = 1
         WHERE user_id = ?2 AND key = ?3`,
      )
      .bind(now.toISOString(), userId, key);

  if (have.has(next)) {
    await db.batch([close()]);
  } else {
    const budgets = request.budgets;
    if (budgets) {
      // Se comprueba antes de escribir: una cuenta desconocida no debe dejar el mes cerrado a medias.
      const unknown = await accountError(db, userId, Object.keys(budgets));
      if (unknown) throw unknown;
    }
    const extra: D1PreparedStatement[] = budgets ? initialBudgetStatements(db, userId, next, budgets) : [copyBudgetStatement(db, userId, next)];
    if (request.addLeftover) {
      // El sobrante sale del estado de ahora, antes de cerrar: cerrar no cambia ninguna cifra del mes.
      const entry = leftoverEntry(await loadState(db, userId), key, next);
      extra.push(leftoverStatement(db, userId, next, entry.accountId, entry.amount, entryDate(next, now)));
    }
    try {
      await db.batch([close(), ...createMonthStatements(db, userId, next), ...extra]);
    } catch (err) {
      // El mes siguiente apareció entre la lectura y el batch (que se deshizo entero): solo queda cerrar.
      if (!isUniqueViolation(err)) throw err;
      await db.batch([close()]);
    }
  }

  const [closed, following] = await Promise.all([requireMonth(db, userId, key), requireMonth(db, userId, next)]);
  return { closed, next: following };
}

export async function reopenMonth(db: D1Database, userId: string, key: MonthKey): Promise<Month> {
  const row = await db
    .prepare('UPDATE months SET closed = 0, closed_at = NULL WHERE user_id = ? AND key = ? RETURNING key')
    .bind(userId, key)
    .first();
  if (!row) throw monthNotFoundError(key);
  return requireMonth(db, userId, key);
}

/**
 * Borra el mes, abierto o cerrado, con todo lo suyo: fijos, transacciones, envíos, registro del presupuesto y tasas (las
 * claves foráneas lo arrastran). Los saldos cambian en consecuencia, porque se calculan de lo que queda; los
 * ingresos y los aportes no son de ningún mes y se conservan.
 */
export async function deleteMonth(db: D1Database, userId: string, key: MonthKey): Promise<void> {
  const row = await db.prepare('DELETE FROM months WHERE user_id = ? AND key = ? RETURNING key').bind(userId, key).first();
  if (!row) throw monthNotFoundError(key);
}

// ── Tarjetas de crédito ──────────────────────────────────────────────────────

const CARD_PATCH = {
  name: 'name',
  bank: 'bank',
  last4: 'last4',
  cur: 'currency',
  limit: 'credit_limit',
  cutoffDay: 'cutoff_day',
  dueDay: 'due_day',
  active: 'active',
  sort: 'sort',
} as const;
const NO_CARD = 'Credit card not found.';

/**
 * "Algo usa la tarjeta": otros cargos o pagos en algún mes, un gasto fijo o una transacción que la nombran, o los
 * que no nombran ninguna (van a la primera activa) cuando esta lo es. ?1 es el usuario y ?2, la tarjeta.
 */
const CARD_IN_USE = `(
  EXISTS (SELECT 1 FROM month_cards WHERE user_id = ?1 AND card_id = ?2)
  OR EXISTS (SELECT 1 FROM card_payments WHERE user_id = ?1 AND card_id = ?2)
  OR EXISTS (SELECT 1 FROM fixed_expenses WHERE user_id = ?1 AND card_id = ?2)
  OR EXISTS (SELECT 1 FROM transactions WHERE user_id = ?1 AND card_id = ?2)
  OR (?2 = (SELECT id FROM credit_cards WHERE user_id = ?1 AND active = 1 ORDER BY sort, rowid LIMIT 1)
      AND (EXISTS (SELECT 1 FROM fixed_expenses WHERE user_id = ?1 AND on_card = 1 AND card_id IS NULL)
        OR EXISTS (SELECT 1 FROM transactions WHERE user_id = ?1 AND method = '${CREDIT_CARD_METHOD}' AND card_id IS NULL))))`;

/** Las tarjetas del usuario (también las apagadas), en su orden. */
export async function listCards(db: D1Database, userId: string): Promise<CreditCard[]> {
  const res = await db.prepare(`SELECT * FROM credit_cards WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId).all<CreditCardRow>();
  return res.results.map(toCreditCard);
}

const cardNameTaken = () => conflictError('There is already a credit card with that name.');
/** Un texto opcional del formulario: vacío = sin dato. */
const orNull = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);

/** La tarjeta nueva va al final. Sin `cur`, la moneda principal del usuario. 409 si ya hay otra con ese nombre. */
export async function createCard(db: D1Database, userId: string, input: CreditCardCreate): Promise<CreditCard> {
  if ((await listCards(db, userId)).some((c) => sameName(c.name, input.name))) throw cardNameTaken();
  const row = await firstOrConflict<CreditCardRow>(
    db
      .prepare(
        `INSERT INTO credit_cards (${CREDIT_CARD_INSERT.join(', ')})
         SELECT ?1, ?2, ?3, ?4, ?5,
                COALESCE(?6, (SELECT value FROM settings WHERE user_id = ?1 AND key = 'main_currency' AND value IN ('DOP','USD','TRY')), '${DEFAULT_MAIN_CURRENCY}'),
                ?7, ?8, ?9, ?10, COALESCE((SELECT MAX(sort) FROM credit_cards WHERE user_id = ?1), -1) + 1
         WHERE NOT EXISTS (SELECT 1 FROM credit_cards WHERE user_id = ?1 AND lower(name) = lower(?3))
         RETURNING *`,
      )
      .bind(
        userId,
        input.id ?? newId(),
        input.name,
        orNull(input.bank),
        orNull(input.last4),
        input.cur ?? null,
        input.limit ?? null,
        input.cutoffDay ?? null,
        input.dueDay ?? null,
        input.active === false ? 0 : 1,
      ),
  );
  if (!row) throw cardNameTaken();
  return toCreditCard(row);
}

/**
 * Edita una tarjeta. Apagarla solo se puede si en el último mes no debe nada y no tiene cargos (cardOffBlocked): 409.
 * Cambiar su moneda, solo si nada la usa (409): reinterpretaría sus importes.
 */
export async function patchCard(db: D1Database, userId: string, id: string, patch: CreditCardPatch): Promise<CreditCard> {
  const current = (await listCards(db, userId)).find((c) => c.id === id);
  if (!current) throw notFoundError(NO_CARD);
  if (patch.name !== undefined && (await listCards(db, userId)).some((c) => c.id !== id && sameName(c.name, patch.name!))) throw cardNameTaken();
  if (patch.active === false && current.active) {
    const state = await loadState(db, userId);
    if (cardOffBlocked(state, id)) throw conflictError(`Pay off ${current.name} before turning it off.`);
  }
  if (patch.cur !== undefined && patch.cur !== current.cur) {
    const used = await db.prepare(`SELECT ${CARD_IN_USE} AS used`).bind(userId, id).first<{ used: number }>();
    if (used?.used) throw conflictError(`${current.name} has activity: its currency cannot change.`);
  }
  const normalized = { ...patch, ...(patch.bank !== undefined && { bank: orNull(patch.bank) }), ...(patch.last4 !== undefined && { last4: orNull(patch.last4) }) };
  const sets = setClause<CreditCardPatch>(CARD_PATCH, normalized);
  if (sets.columns.length === 0) return current;
  const row = await db
    .prepare(`UPDATE credit_cards SET ${sets.sql} WHERE user_id = ? AND id = ? RETURNING *`)
    .bind(...sets.values, userId, id)
    .first<CreditCardRow>();
  if (!row) throw notFoundError(NO_CARD);
  return toCreditCard(row);
}

/** Borra la tarjeta solo si nada la usa (409 si no: se apaga). Sus «otros cargos» en 0 no cuentan como uso. */
export async function deleteCard(db: D1Database, userId: string, id: string): Promise<void> {
  const results = await db.batch([
    db.prepare('DELETE FROM month_cards WHERE user_id = ?1 AND card_id = ?2 AND other = 0').bind(userId, id),
    db.prepare(`DELETE FROM credit_cards WHERE user_id = ?1 AND id = ?2 AND NOT ${CARD_IN_USE} RETURNING id`).bind(userId, id),
  ]);
  if (rows<{ id: string }>(results[1]).length) return;
  const exists = await db.prepare('SELECT 1 AS found FROM credit_cards WHERE user_id = ? AND id = ?').bind(userId, id).first();
  if (!exists) throw notFoundError(NO_CARD);
  throw conflictError('This credit card is in use: turn it off instead of deleting it.');
}

/**
 * La tarjeta a la que va un gasto fijo o una transacción nueva: la que nombra (tiene que existir y estar activa) o, si
 * no nombra ninguna, la primera activa. Sin ninguna tarjeta → 400.
 */
async function cardForCharge(db: D1Database, userId: string, cardId: string | null | undefined): Promise<string> {
  const cards = await listCards(db, userId);
  if (cardId != null) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw unknownCardError(cardId);
    if (!card.active) throw validationError(`${card.name} is turned off: turn it on first.`);
    return card.id;
  }
  const first = cards.find((c) => c.active);
  if (!first) throw validationError('There is no active credit card: add one first.');
  return first.id;
}

async function requireCard(db: D1Database, userId: string, cardId: string): Promise<void> {
  const row = await db.prepare('SELECT 1 AS found FROM credit_cards WHERE user_id = ? AND id = ?').bind(userId, cardId).first();
  if (!row) throw notFoundError(NO_CARD);
}

/** Los «otros cargos» de una tarjeta en el mes (>= 0, en la moneda de la tarjeta; 0 borra la fila). Mes cerrado → 409. */
export async function setCardOther(db: D1Database, userId: string, key: MonthKey, cardId: string, other: number): Promise<Month> {
  await requireCard(db, userId, cardId);
  const write =
    other === 0
      ? db
          .prepare(`DELETE FROM month_cards WHERE user_id = ?1 AND month_key = ?2 AND card_id = ?3 AND month_key IN (SELECT key FROM months WHERE user_id = ?1 AND closed = 0)`)
          .bind(userId, key, cardId)
      : db
          .prepare(
            `INSERT INTO month_cards (${MONTH_CARD_INSERT.join(', ')})
             SELECT m.user_id, m.key, ?3, ?4 FROM months m WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0
             ON CONFLICT (user_id, month_key, card_id) DO UPDATE SET other = excluded.other`,
          )
          .bind(userId, key, cardId, other);
  const results = await db.batch([write, ...monthStatements(db, userId, key)]);
  return writtenMonth(results, key);
}

/**
 * Añade un pago de una tarjeta en el mes (puede haber varios, cada uno con su cuenta y su fecha). El importe tiene que
 * ser > 0 y no pasar de lo que falta por pagar, que se calcula aquí con el estado (shared/calc.ts cardCalc) y no se fía del
 * cliente. Sin `accountId` se usa cardAccountFor; sin `date`, hoy llevado al mes. Cuenta de oro o desconocida → 400,
 * mes cerrado → 409, nada que pagar → 400, tarjeta desconocida → 404. Lo que falta sale de una lectura previa a la
 * escritura, como en addLeftover.
 */
export async function payCard(db: D1Database, userId: string, key: MonthKey, cardId: string, input: CardPayRequest, now: Date = new Date()): Promise<Month> {
  const state = await loadState(db, userId);
  const month = state.months[key];
  if (!month) throw monthNotFoundError(key);
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) throw notFoundError(NO_CARD);
  if (month.closed) throw monthClosedError(key);
  const { remainder } = cardCalc(state, key, cardId);
  // Tolerancia de coma flotante: el diálogo propone lo que falta tal cual y no debe rechazarse por un 1e-12.
  if (!(remainder > 1e-6)) throw validationError(`There is nothing left to pay on ${card.name} in ${key}.`);
  if (!(input.amount <= remainder + 1e-6)) {
    throw validationError(`amount: ${card.name} has ${remainder.toFixed(2)} left to pay in ${key}; it cannot be paid for more than that.`);
  }
  if (input.date !== undefined && !inMonth(input.date, key)) throw outsideMonth('date', key);
  const accountId = input.accountId ?? cardAccountFor(state, key, cardId)?.id;
  if (!accountId) throw noAccountsError();
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO card_payments (${CARD_PAYMENT_INSERT.join(', ')})
           SELECT m.user_id, ?3, m.key, ?7, ?4, a.id, ?5,
                  COALESCE((SELECT MAX(sort) FROM card_payments WHERE user_id = m.user_id AND month_key = m.key), -1) + 1
           FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?6 ${moneyOnly('a')}
           WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0`,
        )
        .bind(userId, key, input.id ?? newId(), input.date ?? entryDate(key, now), Math.min(input.amount, remainder), accountId, cardId),
      ...monthStatements(db, userId, key),
    ]);
  } catch (err) {
    throw isUniqueViolation(err) ? duplicateId() : err;
  }
  // La cuenta no sirvió (no existe o es de oro): nada se escribió y el error dice por qué.
  if (!results[0]!.meta.changes) throw await createError(db, userId, key, [accountId]);
  return writtenMonth(results, key);
}

/** Quita todos los pagos de esa tarjeta en el mes. Mes cerrado → 409. */
export async function unpayCard(db: D1Database, userId: string, key: MonthKey, cardId: string): Promise<Month> {
  await requireCard(db, userId, cardId);
  const results = await db.batch([
    db
      .prepare(`DELETE FROM card_payments WHERE user_id = ?1 AND month_key = ?2 AND card_id = ?3 AND month_key IN (SELECT key FROM months WHERE user_id = ?1 AND closed = 0)`)
      .bind(userId, key, cardId),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/** Quita un pago de esa tarjeta en el mes. Mes cerrado → 409; un pago que no existe en ese mes y tarjeta → 404. */
export async function removeCardPayment(db: D1Database, userId: string, key: MonthKey, cardId: string, paymentId: string): Promise<Month> {
  await requireCard(db, userId, cardId);
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM card_payments WHERE user_id = ?1 AND month_key = ?2 AND card_id = ?4 AND id = ?3 AND month_key IN (SELECT key FROM months WHERE user_id = ?1 AND closed = 0)`,
      )
      .bind(userId, key, paymentId, cardId),
    ...monthStatements(db, userId, key),
  ]);
  const month = writtenMonth(results, key);
  if (!results[0]!.meta.changes) throw notFoundError('Credit card payment not found.');
  return month;
}

// ── Gastos fijos ─────────────────────────────────────────────────────────────

const FIXED_PATCH = {
  name: 'name',
  day: 'day',
  amount: 'amount',
  cur: 'currency',
  paid: 'paid',
  accountId: 'account_id',
  sort: 'sort',
  onCard: 'on_card',
  cardId: 'card_id',
} as const;
const NO_FIXED = 'Monthly expense not found.';

/** Las cuentas que nombra un patch con `accountId`. */
const patchedAccount = (patch: { accountId?: string }): string[] => (patch.accountId === undefined ? [] : [patch.accountId]);

/** El patch de una fila con tarjeta, ya resuelto: `cardId` null deja la fila sin tarjeta. */
type CardResolved<P> = Omit<P, 'cardId'> & { cardId?: string | null };

/** El nuevo fijo va al final del mes: sort = max(sort) + 1. Sin `accountId` se paga de la cuenta por defecto. */
export async function createFixed(db: D1Database, userId: string, input: FixedCreate): Promise<FixedExpense> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  // Con tarjeta: la que diga o la primera activa. Sin tarjeta, `cardId` no cuenta.
  const cardId = input.onCard ? await cardForCharge(db, userId, input.cardId) : null;
  // La fila sale del mes abierto y de la cuenta del usuario: si falta alguno de los dos, no se inserta nada.
  const row = await firstOrConflict<FixedRow>(
    db
      .prepare(
        `INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort, on_card, card_id)
         SELECT m.user_id, ?2, m.key, ?4, ?5, ?6, ?7, ?8, a.id,
                COALESCE((SELECT MAX(sort) FROM fixed_expenses WHERE user_id = m.user_id AND month_key = m.key), -1) + 1, ?10, ?11
         FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?9 ${moneyOnly('a')}
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.monthKey, input.name, input.day ?? '', input.amount, input.cur, input.paid ? 1 : 0, accountId, input.onCard ? 1 : 0, cardId),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [accountId]);
  return toFixed(row);
}

export async function patchFixed(db: D1Database, userId: string, id: string, patch: FixedPatch): Promise<FixedExpense> {
  let resolved: CardResolved<FixedPatch> = patch;
  if (patch.onCard !== undefined || patch.cardId !== undefined) {
    const row = await db.prepare('SELECT on_card, card_id FROM fixed_expenses WHERE user_id = ? AND id = ?').bind(userId, id).first<{ on_card: number; card_id: string | null }>();
    if (row) {
      const onCard = patch.onCard ?? row.on_card === 1;
      if (!onCard) resolved = { ...patch, cardId: row.card_id === null ? undefined : null };
      else if (patch.cardId !== undefined || row.card_id === null) resolved = { ...patch, cardId: await cardForCharge(db, userId, patch.cardId) };
    }
  }
  const sets = setClause<CardResolved<FixedPatch>>(FIXED_PATCH, resolved);
  return toFixed(await patchInMonth<FixedRow>(db, userId, 'fixed_expenses', id, sets, NO_FIXED, patchedAccount(patch)));
}

export async function deleteFixed(db: D1Database, userId: string, id: string): Promise<void> {
  await deleteInMonth(db, userId, 'fixed_expenses', id, NO_FIXED);
}

// ── Transacciones ────────────────────────────────────────────────────────────

const TX_PATCH = {
  date: 'date',
  desc: 'description',
  place: 'place',
  cat: 'category',
  method: 'method',
  amount: 'amount',
  cur: 'currency',
  accountId: 'account_id',
  notes: 'notes',
  cardId: 'card_id',
} as const;
const NO_TX = 'Transaction not found.';

/** Sin `accountId` el gasto sale de la cuenta por defecto del usuario. */
export async function createTransaction(
  db: D1Database,
  userId: string,
  input: TxCreate,
  source: TxSource = 'web',
  now: Date = new Date(),
): Promise<Transaction> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  // Solo una transacción con tarjeta de crédito lleva tarjeta: la que diga o la primera activa.
  const cardId = input.method === CREDIT_CARD_METHOD ? await cardForCharge(db, userId, input.cardId) : null;
  const row = await firstOrConflict<TxRow>(
    db
      .prepare(
        `INSERT INTO transactions (${TX_INSERT.join(', ')})
         SELECT m.user_id, ?2, m.key, ?4, ?5, ?6, ?7, ?8, ?9, ?10, a.id, ?12, ?13, ?14, ?15
         FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?11 ${moneyOnly('a')}
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(
        userId,
        input.id ?? newId(),
        input.monthKey,
        input.date,
        input.desc,
        input.place ?? '',
        input.cat,
        input.method,
        input.amount,
        input.cur,
        accountId,
        input.notes ?? '',
        source,
        now.toISOString(),
        cardId,
      ),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [accountId]);
  return toTx(row);
}

export async function patchTransaction(db: D1Database, userId: string, id: string, patch: TxPatch): Promise<Transaction> {
  let resolved: CardResolved<TxPatch> = patch;
  if (patch.method !== undefined || patch.cardId !== undefined) {
    const row = await db.prepare('SELECT method, card_id FROM transactions WHERE user_id = ? AND id = ?').bind(userId, id).first<{ method: string; card_id: string | null }>();
    if (row) {
      const method = patch.method ?? row.method;
      if (method !== CREDIT_CARD_METHOD) resolved = { ...patch, cardId: row.card_id === null ? undefined : null };
      else if (patch.cardId !== undefined || row.card_id === null) resolved = { ...patch, cardId: await cardForCharge(db, userId, patch.cardId) };
    }
  }
  const sets = setClause<CardResolved<TxPatch>>(TX_PATCH, resolved);
  return toTx(await patchInMonth<TxRow>(db, userId, 'transactions', id, sets, NO_TX, patchedAccount(patch)));
}

export async function deleteTransaction(db: D1Database, userId: string, id: string): Promise<void> {
  await deleteInMonth(db, userId, 'transactions', id, NO_TX);
}

// ── Fuera de presupuesto ─────────────────────────────────────────────────────

const OUTSIDE_PATCH = { date: 'date', name: 'name', desc: 'description', accountId: 'account_id', amount: 'amount', cur: 'currency' } as const;
const NO_OUTSIDE = 'Outside-budget expense not found.';

/** Sin `accountId` sale de la cuenta por defecto; sin `cur`, la moneda de la cuenta. Va al final de la lista del mes. */
export async function createOutside(db: D1Database, userId: string, input: OutsideCreate): Promise<OutsideExpense> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  const row = await firstOrConflict<OutsideRow>(
    db
      .prepare(
        `INSERT INTO outside_expenses (${OUTSIDE_INSERT.join(', ')})
         SELECT m.user_id, ?2, m.key, ?4, ?5, ?6, a.id, ?8, COALESCE(?9, a.currency),
                COALESCE((SELECT MAX(sort) FROM outside_expenses WHERE user_id = m.user_id AND month_key = m.key), -1) + 1
         FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?7 ${moneyOnly('a')}
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.monthKey, input.date, input.name, input.desc ?? '', accountId, input.amount, input.cur ?? null),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [accountId]);
  return toOutside(row);
}

export async function patchOutside(db: D1Database, userId: string, id: string, patch: OutsidePatch): Promise<OutsideExpense> {
  const sets = setClause<OutsidePatch>(OUTSIDE_PATCH, patch);
  return toOutside(await patchInMonth<OutsideRow>(db, userId, 'outside_expenses', id, sets, NO_OUTSIDE, patchedAccount(patch)));
}

export async function deleteOutside(db: D1Database, userId: string, id: string): Promise<void> {
  await deleteInMonth(db, userId, 'outside_expenses', id, NO_OUTSIDE);
}

/**
 * Pasa una transacción a "fuera de presupuesto": mismo mes, fecha, concepto (name), notas (description; si tenía
 * lugar, va delante porque esta tabla no lo guarda), cuenta, monto y moneda. Un solo batch: el INSERT lee la
 * transacción y el DELETE la quita bajo las mismas condiciones (mes abierto), así que o pasan las dos o ninguna.
 */
export async function moveTransactionOutside(db: D1Database, userId: string, id: string, newRowId: string = newId()): Promise<OutsideExpense> {
  const results = await moveBatch(
    db,
    db.prepare(
      `INSERT INTO outside_expenses (${OUTSIDE_INSERT.join(', ')})
       SELECT t.user_id, ?3, t.month_key, t.date, t.description,
              substr(CASE WHEN t.place <> '' THEN t.place || CASE WHEN t.notes <> '' THEN ' · ' || t.notes ELSE '' END ELSE t.notes END, 1, ${MAX_LEN.notes}),
              t.account_id, t.amount, t.currency,
              COALESCE((SELECT MAX(sort) FROM outside_expenses WHERE user_id = t.user_id AND month_key = t.month_key), -1) + 1
       FROM transactions t
       WHERE t.user_id = ?1 AND t.id = ?2 AND t.month_key IN ${OPEN_MONTHS.replace('?', '?1')}
       RETURNING *`,
    ).bind(userId, id, newRowId),
    db.prepare(`DELETE FROM transactions WHERE user_id = ?1 AND id = ?2 AND month_key IN ${OPEN_MONTHS.replace('?', '?1')}`).bind(userId, id),
  );
  const row = rows<OutsideRow>(results[0])[0];
  if (!row) throw await rowWriteError(db, userId, 'transactions', id, NO_TX);
  return toOutside(row);
}

/**
 * El camino inverso: la fila fuera de presupuesto pasa a ser una transacción (categoría y método de MOVED_TO_BUDGET
 * si no se dicen otros, sin lugar; su descripción pasa a las notas). También en un solo batch.
 */
export async function moveOutsideToBudget(
  db: D1Database,
  userId: string,
  id: string,
  request: MoveToBudgetRequest = {},
  now: Date = new Date(),
): Promise<Transaction> {
  const results = await moveBatch(
    db,
    db.prepare(
      `INSERT INTO transactions (${TX_INSERT.join(', ')})
       SELECT o.user_id, ?3, o.month_key, o.date, o.name, '', ?4, ?5, o.amount, o.currency, o.account_id, o.description, 'web', ?6, NULL
       FROM outside_expenses o
       WHERE o.user_id = ?1 AND o.id = ?2 AND o.month_key IN ${OPEN_MONTHS.replace('?', '?1')}
       RETURNING *`,
    ).bind(userId, id, request.id ?? newId(), request.cat ?? MOVED_TO_BUDGET.cat, request.method ?? MOVED_TO_BUDGET.method, now.toISOString()),
    db.prepare(`DELETE FROM outside_expenses WHERE user_id = ?1 AND id = ?2 AND month_key IN ${OPEN_MONTHS.replace('?', '?1')}`).bind(userId, id),
  );
  const row = rows<TxRow>(results[0])[0];
  if (!row) throw await rowWriteError(db, userId, 'outside_expenses', id, NO_OUTSIDE);
  return toTx(row);
}

/** El batch de un "mover" (INSERT … RETURNING y DELETE); un id repetido en el destino deshace los dos. */
async function moveBatch(db: D1Database, insert: D1PreparedStatement, remove: D1PreparedStatement): Promise<D1Result<unknown>[]> {
  try {
    return await db.batch([insert, remove]);
  } catch (err) {
    throw isUniqueViolation(err) ? duplicateId() : err;
  }
}

// ── Envíos entre cuentas ─────────────────────────────────────────────────────

const TRANSFER_PATCH = {
  date: 'date',
  via: 'via',
  fromAccountId: 'from_account_id',
  toAccountId: 'to_account_id',
  amount: 'amount',
  rate: 'rate',
  budget: 'budget',
  fee: 'fee',
} as const;
const NO_TRANSFER = 'Transfer not found.';

function sameAccountError(): ApiError {
  return validationError(invalidData(`toAccountId: ${SAME_ACCOUNT}`));
}

/**
 * Tasa vigente en la fecha del envío para las monedas de las dos cuentas (rateFor de shared/calc.ts; 1 si son
 * la misma): la que lleva un envío que llega sin la suya.
 */
async function monthTransferRate(db: D1Database, userId: string, input: TransferCreate): Promise<number> {
  const state = await loadState(db, userId);
  const accounts = accountsById(state);
  const from = accounts.get(input.fromAccountId);
  const to = accounts.get(input.toAccountId);
  if (!from) throw unknownAccountError(input.fromAccountId);
  if (!to) throw unknownAccountError(input.toAccountId);
  if (isGold(from.currency)) throw goldAccountError(from.name);
  if (isGold(to.currency)) throw goldAccountError(to.name);
  return rateFor(state, input.monthKey, from.currency, to.currency, input.date).rate;
}

/**
 * Mueve `amount` (en la moneda de la cuenta de origen) de una cuenta a otra distinta; a la de destino le entra
 * amount × rate. Sin `rate` se usa la tasa vigente en su fecha para las monedas de las dos cuentas. Con
 * `budget: true` mueve además presupuesto de su mes, de la parte de la cuenta de origen a la de destino: como
 * con los ingresos, no se escribe nada en el registro, lo hace shared/calc.ts al calcular. `fee` es la comisión,
 * en la moneda de la cuenta de origen (0 si no viene).
 */
export async function createTransfer(db: D1Database, userId: string, input: TransferCreate): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw sameAccountError();
  const rate = input.rate ?? (await monthTransferRate(db, userId, input));
  const row = await firstOrConflict<TransferRow>(
    db
      .prepare(
        `INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate, budget, fee)
         SELECT m.user_id, ?2, m.key, ?4, ?5, f.id, t.id, ?8, ?9, ?10, ?11
         FROM months m
         JOIN accounts f ON f.user_id = m.user_id AND f.id = ?6 ${moneyOnly('f')}
         JOIN accounts t ON t.user_id = m.user_id AND t.id = ?7 ${moneyOnly('t')}
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(
        userId,
        input.id ?? newId(),
        input.monthKey,
        input.date,
        input.via,
        input.fromAccountId,
        input.toAccountId,
        input.amount,
        rate,
        input.budget ? 1 : 0,
        input.fee ?? 0,
      ),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [input.fromAccountId, input.toAccountId]);
  return toTransfer(row);
}

/**
 * Edita un envío. Las dos cuentas tienen que seguir siendo distintas, contando la que no cambia. La tasa
 * guardada no se recalcula sola: si cambian las cuentas y con ellas las monedas, quien edita manda la nueva.
 */
export async function patchTransfer(db: D1Database, userId: string, id: string, patch: TransferPatch): Promise<Transfer> {
  const sets = setClause<TransferPatch>(TRANSFER_PATCH, patch);
  const accountIds = [patch.fromAccountId, patch.toAccountId].filter((accountId) => accountId !== undefined);
  if (accountIds.length > 0) {
    // Solo para dar el error exacto; la regla va también dentro del UPDATE.
    const current = await db.prepare('SELECT * FROM transfers WHERE user_id = ? AND id = ?').bind(userId, id).first<TransferRow>();
    if (!current) throw notFoundError(NO_TRANSFER);
    if ((patch.fromAccountId ?? current.from_account_id) === (patch.toAccountId ?? current.to_account_id)) throw sameAccountError();
  }
  const distinct = {
    sql: ' AND COALESCE(?, from_account_id) <> COALESCE(?, to_account_id)',
    values: [patch.fromAccountId ?? null, patch.toAccountId ?? null],
  };
  return toTransfer(await patchInMonth<TransferRow>(db, userId, 'transfers', id, sets, NO_TRANSFER, accountIds, distinct));
}

export async function deleteTransfer(db: D1Database, userId: string, id: string): Promise<void> {
  await deleteInMonth(db, userId, 'transfers', id, NO_TRANSFER);
}

// ── Ingresos ─────────────────────────────────────────────────────────────────
// No pertenecen a un mes: cuentan en el de su fecha (shared/calc.ts incomeInMonth) y se pueden crear, editar y
// borrar siempre, esté ese mes cerrado o ni siquiera exista.

const INCOME_PATCH = {
  date: 'date',
  desc: 'description',
  accountId: 'account_id',
  amount: 'amount',
  cur: 'currency',
  budget: 'budget',
  rate: 'rate',
  recurring: 'recurring',
} as const;
const NO_INCOME = 'Income not found.';

/**
 * Condición de un ingreso sobre su cuenta `a`: gramos de oro (XAU) si y solo si la cuenta es de oro, y un
 * ingreso a una cuenta de oro nunca sube el presupuesto. `cur` y `budget` son las expresiones SQL de esos dos datos.
 */
const incomeFits = (cur: string, budget: string) =>
  `((a.currency = '${GOLD}') = (${cur} = '${GOLD}')) AND NOT (a.currency = '${GOLD}' AND ${budget} = 1)`;

/** Por qué un ingreso no se puede guardar en esa cuenta (ver incomeFits), o null si sí se puede. */
async function incomeAccountError(
  db: D1Database,
  userId: string,
  accountId: string,
  cur: AccountCurrency,
  budget: boolean,
): Promise<ApiError | null> {
  const account = await db.prepare('SELECT id, name, currency FROM accounts WHERE user_id = ? AND id = ?').bind(userId, accountId).first<AccountRef>();
  if (!account) return unknownAccountError(accountId);
  const name = account.name.slice(0, 64);
  if (isGold(account.currency)) {
    if (!isGold(cur)) return validationError(invalidData(`cur: must be ${GOLD} (grams) because "${name}" is a gold account`));
    if (budget) return validationError(invalidData(`budget: an income into a gold account cannot add to the budget ("${name}" holds grams of gold)`));
  } else if (isGold(cur)) {
    return validationError(invalidData(`cur: ${GOLD} (grams of gold) is only valid for an income into a gold account, and "${name}" is not one`));
  }
  return null;
}

export async function listIncomes(db: D1Database, userId: string): Promise<Income[]> {
  const res = await db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY rowid').bind(userId).all<IncomeRow>();
  return res.results.map(toIncome);
}

/**
 * Sin `accountId` el ingreso entra a la cuenta por defecto del usuario. Con `budget: true` sube además el
 * presupuesto del mes de su fecha: no se escribe nada en el registro, lo suma shared/calc.ts al calcular.
 * A una cuenta de oro le entran gramos: `cur` tiene que ser XAU (y solo ahí) y nunca lleva `budget` (400).
 */
export async function createIncome(db: D1Database, userId: string, input: IncomeCreate): Promise<Income> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  // La fila sale de las cuentas del usuario: una cuenta de otro usuario es como una que no existe.
  const row = await firstOrConflict<IncomeRow>(
    db
      .prepare(
        `INSERT INTO incomes (user_id, id, date, description, account_id, amount, currency, budget, rate, recurring)
         SELECT a.user_id, ?2, ?3, ?4, a.id, ?6, ?7, ?8, ?9, ?10 FROM accounts a
         WHERE a.user_id = ?1 AND a.id = ?5 AND ${incomeFits('?7', '?8')}
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.date, input.desc ?? '', accountId, input.amount, input.cur, input.budget ? 1 : 0, input.rate ?? null, input.recurring ? 1 : 0),
  );
  if (!row) {
    throw (
      (await incomeAccountError(db, userId, accountId, input.cur, input.budget ?? false)) ??
      conflictError('The account changed while the income was being saved. Try again.')
    );
  }
  return toIncome(row);
}

export async function patchIncome(db: D1Database, userId: string, id: string, patch: IncomePatch): Promise<Income> {
  const sets = setClause<IncomePatch>(INCOME_PATCH, patch);
  let stmt: D1PreparedStatement;
  if (sets.columns.length === 0) {
    stmt = db.prepare('SELECT * FROM incomes WHERE user_id = ? AND id = ?').bind(userId, id);
  } else {
    // La regla se comprueba dentro del UPDATE sobre el ingreso resultante (lo que hay más lo que cambia): la
    // cuenta tiene que existir y cuadrar con la moneda y con `budget` (incomeFits).
    const budget = patch.budget === undefined ? null : patch.budget ? 1 : 0;
    stmt = db
      .prepare(
        `UPDATE incomes SET ${sets.sql}
         WHERE user_id = ? AND id = ?
           AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = incomes.user_id AND a.id = COALESCE(?, incomes.account_id)
                       AND ${incomeFits('COALESCE(?, incomes.currency)', 'COALESCE(?, incomes.budget)')})
         RETURNING *`,
      )
      .bind(...sets.values, userId, id, patch.accountId ?? null, patch.cur ?? null, budget);
  }
  const row = await stmt.first<IncomeRow>();
  if (row) return toIncome(row);
  const current = await db.prepare('SELECT * FROM incomes WHERE user_id = ? AND id = ?').bind(userId, id).first<IncomeRow>();
  if (!current) throw notFoundError(NO_INCOME);
  // El ingreso existe: lo único que pudo frenar la escritura es su cuenta.
  throw (
    (await incomeAccountError(db, userId, patch.accountId ?? current.account_id, patch.cur ?? current.currency, patch.budget ?? current.budget === 1)) ??
    conflictError('The income changed while it was being saved. Try again.')
  );
}

export async function deleteIncome(db: D1Database, userId: string, id: string): Promise<void> {
  const row = await db.prepare('DELETE FROM incomes WHERE user_id = ? AND id = ? RETURNING id').bind(userId, id).first();
  if (!row) throw notFoundError(NO_INCOME);
}

// ── Metas ────────────────────────────────────────────────────────────────────

const GOAL_PATCH = {
  name: 'name',
  cur: 'currency',
  monthly: 'monthly',
  start: 'start_month',
  end: 'end_month',
  approxCur: 'approx_currency',
  sort: 'sort',
} as const;
const NO_GOAL = 'Goal not found.';

function goalNameTaken(): ApiError {
  return conflictError('There is already a goal with that name.');
}

/** Regla del plan (shared/api.ts): los tres campos juntos o los tres null. Lanza ApiError 400 `validation`. */
function assertPlan(plan: GoalPlan): void {
  const issue = goalPlanIssue(plan);
  if (issue) throw validationError(invalidData(`${issue.path}: ${issue.message}`));
}

export async function listGoals(db: D1Database, userId: string): Promise<Goal[]> {
  const res = await db.prepare(`SELECT * FROM goals WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId).all<GoalRow>();
  return res.results.map(toGoal);
}

/**
 * La meta nueva va al final: sort = max(sort) + 1. Sin `cur` queda en la moneda principal del usuario.
 * 409 `conflict` si el usuario ya tiene otra con ese nombre.
 */
export async function createGoal(db: D1Database, userId: string, input: GoalCreate): Promise<Goal> {
  const plan: GoalPlan = { monthly: input.monthly ?? null, start: input.start ?? null, end: input.end ?? null };
  assertPlan(plan);
  const [goals, settings] = await db.batch([
    db.prepare('SELECT name FROM goals WHERE user_id = ?').bind(userId),
    db.prepare(SELECT_SETTINGS).bind(userId),
  ]);
  if (rows<{ name: string }>(goals).some((g) => sameName(g.name, input.name))) throw goalNameTaken();
  const cur = input.cur ?? toSettings(rows<SettingRow>(settings)).mainCurrency;

  // El NOT EXISTS repite la regla del nombre dentro de la propia escritura: dos altas iguales a la vez
  // (un doble clic) pasarían las dos la lectura de arriba.
  const row = await firstOrConflict<GoalRow>(
    db
      .prepare(
        `INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, approx_currency, sort)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE((SELECT MAX(sort) FROM goals WHERE user_id = ?1), -1) + 1
         WHERE NOT EXISTS (SELECT 1 FROM goals WHERE user_id = ?1 AND lower(name) = lower(?3))
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.name, cur, plan.monthly, plan.start, plan.end, input.approxCur ?? null),
  );
  if (!row) throw goalNameTaken();
  return toGoal(row);
}

/**
 * Edita una meta. La regla del plan se comprueba sobre la meta resultante (lo que hay más lo que cambia): mandar
 * solo `end` a una meta con plan vale; mandar solo `monthly` a una sin plan, no (400).
 */
export async function patchGoal(db: D1Database, userId: string, id: string, patch: GoalPatch): Promise<Goal> {
  const goals = await listGoals(db, userId);
  const current = goals.find((g) => g.id === id);
  if (!current) throw notFoundError(NO_GOAL);

  let changes = patch;
  if (patch.monthly !== undefined || patch.start !== undefined || patch.end !== undefined) {
    const plan: GoalPlan = {
      monthly: patch.monthly !== undefined ? patch.monthly : current.monthly,
      start: patch.start !== undefined ? patch.start : current.start,
      end: patch.end !== undefined ? patch.end : current.end,
    };
    assertPlan(plan);
    // Se escriben los tres campos del plan ya comprobado, no solo los que vinieron: así lo guardado es siempre
    // un plan válido aunque otra petición haya cambiado la meta entre la lectura y la escritura.
    changes = { ...patch, ...plan };
  }
  const name = patch.name;
  if (name !== undefined && goals.some((g) => g.id !== id && sameName(g.name, name))) throw goalNameTaken();

  const sets = setClause<GoalPatch>(GOAL_PATCH, changes);
  // Patch vacío: no es una escritura, se devuelve la meta tal como está.
  if (sets.columns.length === 0) return current;
  const row = await db
    .prepare(`UPDATE goals SET ${sets.sql} WHERE user_id = ? AND id = ? RETURNING *`)
    .bind(...sets.values, userId, id)
    .first<GoalRow>();
  if (!row) throw notFoundError(NO_GOAL);
  return toGoal(row);
}

/** Una meta con aportes no se puede borrar (409): primero hay que borrar o mover sus aportes. */
export async function deleteGoal(db: D1Database, userId: string, id: string): Promise<void> {
  const row = await db
    .prepare(
      `DELETE FROM goals WHERE user_id = ?1 AND id = ?2
       AND NOT EXISTS (SELECT 1 FROM contributions WHERE user_id = ?1 AND goal_id = ?2) RETURNING id`,
    )
    .bind(userId, id)
    .first();
  if (row) return;
  const exists = await db.prepare('SELECT 1 AS found FROM goals WHERE user_id = ? AND id = ?').bind(userId, id).first();
  throw exists ? conflictError('The goal has contributions: delete or move them before deleting it.') : notFoundError(NO_GOAL);
}

// ── Aportes ──────────────────────────────────────────────────────────────────
// Son un apartado, no un movimiento: no llevan cuenta y no cambian ningún saldo.

const CONTRIBUTION_PATCH = { goalId: 'goal_id', date: 'date', amount: 'amount', cur: 'currency', rate: 'rate', accountId: 'account_id' } as const;
const NO_CONTRIBUTION = 'Contribution not found.';

export async function listContributions(db: D1Database, userId: string): Promise<Contribution[]> {
  const res = await db
    .prepare('SELECT * FROM contributions WHERE user_id = ? ORDER BY rowid')
    .bind(userId)
    .all<ContributionRow>();
  return res.results.map(toContribution);
}

export async function createContribution(db: D1Database, userId: string, input: ContributionCreate): Promise<Contribution> {
  // La cuenta de origen: del usuario y de dinero (una de oro, o una que no existe, es 400).
  const bad = input.accountId ? await accountError(db, userId, [input.accountId]) : null;
  if (bad) throw bad;
  // La fila sale de las metas del usuario: una meta de otro usuario es como una que no existe.
  const row = await firstOrConflict<ContributionRow>(
    db
      .prepare(
        `INSERT INTO contributions (user_id, id, goal_id, date, amount, currency, rate, account_id)
         SELECT g.user_id, ?2, g.id, ?4, ?5, ?6, ?7, ?8 FROM goals g WHERE g.user_id = ?1 AND g.id = ?3
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.goalId, input.date, input.amount, input.cur, input.rate ?? null, input.accountId ?? null),
  );
  if (!row) throw notFoundError(NO_GOAL);
  return toContribution(row);
}

export async function patchContribution(
  db: D1Database,
  userId: string,
  id: string,
  patch: ContributionPatch,
): Promise<Contribution> {
  const bad = patch.accountId ? await accountError(db, userId, [patch.accountId]) : null;
  if (bad) throw bad;
  const sets = setClause<ContributionPatch>(CONTRIBUTION_PATCH, patch);
  let stmt: D1PreparedStatement;
  if (sets.columns.length === 0) {
    stmt = db.prepare('SELECT * FROM contributions WHERE user_id = ? AND id = ?').bind(userId, id);
  } else if (patch.goalId === undefined) {
    stmt = db
      .prepare(`UPDATE contributions SET ${sets.sql} WHERE user_id = ? AND id = ? RETURNING *`)
      .bind(...sets.values, userId, id);
  } else {
    // La meta de destino tiene que existir y ser del usuario (se comprueba en la misma sentencia, antes que la clave foránea).
    stmt = db
      .prepare(
        `UPDATE contributions SET ${sets.sql}
         WHERE user_id = ? AND id = ? AND EXISTS (SELECT 1 FROM goals WHERE user_id = ? AND id = ?) RETURNING *`,
      )
      .bind(...sets.values, userId, id, userId, patch.goalId);
  }
  const row = await stmt.first<ContributionRow>();
  if (row) return toContribution(row);
  const exists = await db.prepare('SELECT 1 AS found FROM contributions WHERE user_id = ? AND id = ?').bind(userId, id).first();
  throw notFoundError(exists ? NO_GOAL : NO_CONTRIBUTION);
}

export async function deleteContribution(db: D1Database, userId: string, id: string): Promise<void> {
  const row = await db.prepare('DELETE FROM contributions WHERE user_id = ? AND id = ? RETURNING id').bind(userId, id).first();
  if (!row) throw notFoundError(NO_CONTRIBUTION);
}

// ── Carga masiva: datos de ejemplo, empezar en blanco e importación ──────────

/** Todas las tablas con datos del usuario (todas menos sus ajustes). Hijos antes que padres, por las claves foráneas. */
const DATA_TABLES = [
  'contributions',
  'incomes',
  'transactions',
  'outside_expenses',
  'card_payments',
  'month_cards',
  'transfers',
  'fixed_expenses',
  'month_budget_log',
  'month_rates',
  'months',
  'goals',
  'credit_cards',
  'accounts',
] as const;

/**
 * Las tasas escritas de un mes tal como se pueden guardar: mayores que 0, entre dos monedas distintas, con
 * fecha dentro del mes (una sin fecha, o con fecha de otro mes, pasa al primer día) y una sola por par y fecha
 * (la última, que es la que usa rateFor). Lo demás la base lo rechazaría y shared/calc lo ignora.
 */
function storableRates(key: MonthKey, rates: readonly MonthRate[]): MonthRate[] {
  const byPairDate = new Map<string, MonthRate>();
  for (const r of rates) {
    if (!(r.rate > 0) || r.from === r.to) continue;
    const date = r.date && inMonth(r.date, key) ? r.date : firstDay(key);
    byPairDate.set(`${[r.from, r.to].sort().join('/')}|${date}`, { ...r, date });
  }
  return [...byPairDate.values()];
}

/** Los datos de un usuario: su estado sin los ajustes. */
type UserData = Pick<AppState, 'months' | 'accounts' | 'incomes' | 'goals' | 'contribs' | 'cards'>;

/**
 * Sentencias que dejan como datos del usuario exactamente los de `state`: borran todo lo que tiene (salvo sus
 * ajustes) y lo insertan de nuevo, en el orden del estado. `stamp` es la fecha de alta de las transacciones que
 * no traen la suya. Del presupuesto se guarda el registro (Month.budgetLog); Month.budgets es su suma y no se guarda.
 */
function dataStatements(db: D1Database, userId: string, state: UserData, stamp: string, keepCards = false): D1PreparedStatement[] {
  const months = Object.keys(state.months)
    .sort()
    .map((k) => state.months[k]!);
  return [
    // Un Excel importado no trae tarjetas: se conservan (credit_cards no se borra) y solo se reescribe lo que cuelga de los meses.
    ...DATA_TABLES.filter((table) => !(keepCards && table === 'credit_cards')).map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
    ...insertMany(
      db,
      'accounts',
      ACCOUNT_INSERT,
      state.accounts.map((a) => [userId, a.id, a.name, a.currency, a.opening, a.hidden ? 1 : 0, a.sort]),
    ),
    ...insertMany(
      db,
      'goals',
      GOAL_INSERT,
      state.goals.map((g) => [userId, g.id, g.name, g.cur, g.monthly, g.start, g.end, g.approxCur ?? null, g.sort]),
    ),
    ...(keepCards
      ? []
      : insertMany(
          db,
          'credit_cards',
          CREDIT_CARD_INSERT,
          state.cards.map((c) => [userId, c.id, c.name, c.bank, c.last4, c.cur, c.limit, c.cutoffDay, c.dueDay, c.active ? 1 : 0, c.sort]),
        )),
    ...insertMany(
      db,
      'months',
      MONTH_INSERT,
      months.map((m) => [userId, m.key, m.closed ? 1 : 0, m.closedAt]),
    ),
    ...insertMany(
      db,
      'month_cards',
      MONTH_CARD_INSERT,
      months.flatMap((m) => (m.cards ?? []).filter((c) => c.other !== 0).map((c) => [userId, m.key, c.cardId, c.other])),
    ),
    ...insertMany(
      db,
      'card_payments',
      CARD_PAYMENT_INSERT,
      months.flatMap((m) =>
        (m.cards ?? []).flatMap((c) =>
          c.payments.map((p, i) => [userId, p.id, m.key, c.cardId, clampToMonth(p.date || lastDay(m.key), m.key), p.accountId, p.amount, i]),
        ),
      ),
    ),
    ...insertMany(
      db,
      'month_budget_log',
      BUDGET_LOG_INSERT,
      // La base exige la fecha dentro del mes: una que venga de fuera se lleva a él en vez de tumbar toda la carga.
      months.flatMap((m) =>
        m.budgetLog.map((e) => [userId, e.id, m.key, clampToMonth(e.date || firstDay(m.key), m.key), e.accountId, e.amount, e.kind, e.note ?? '']),
      ),
    ),
    ...insertMany(
      db,
      'month_rates',
      RATE_INSERT,
      months.flatMap((m) => storableRates(m.key, m.rates).map((r) => [userId, m.key, r.from, r.to, r.date, r.rate])),
    ),
    ...insertMany(
      db,
      'fixed_expenses',
      FIXED_INSERT,
      months.flatMap((m) =>
        m.fixed.map((f) => [userId, f.id, m.key, f.name, String(f.day ?? ''), f.amount, f.cur, f.paid ? 1 : 0, f.accountId, f.sort, f.onCard ? 1 : 0, f.onCard ? (f.cardId ?? null) : null]),
      ),
    ),
    ...insertMany(
      db,
      'transfers',
      TRANSFER_INSERT,
      months.flatMap((m) => m.transfers.map((t) => [userId, t.id, m.key, t.date, t.via, t.fromAccountId, t.toAccountId, t.amount, t.rate, t.budget ? 1 : 0, t.fee || 0])),
    ),
    ...insertMany(
      db,
      'transactions',
      TX_INSERT,
      months.flatMap((m) =>
        m.tx.map((t) => [
          userId,
          t.id,
          m.key,
          t.date,
          t.desc,
          t.place,
          t.cat,
          t.method,
          t.amount,
          t.cur,
          t.accountId,
          t.notes,
          t.source,
          t.createdAt ?? stamp,
          t.method === CREDIT_CARD_METHOD ? (t.cardId ?? null) : null,
        ]),
      ),
    ),
    ...insertMany(
      db,
      'outside_expenses',
      OUTSIDE_INSERT,
      months.flatMap((m) => outsideOf(m).map((o, i) => [userId, o.id, m.key, o.date, o.name, o.desc, o.accountId, o.amount, o.cur, i])),
    ),
    ...insertMany(
      db,
      'incomes',
      INCOME_INSERT,
      state.incomes.map((i) => [userId, i.id, i.date, i.desc, i.accountId, i.amount, i.cur, i.budget ? 1 : 0, i.rate ?? null, i.recurring ? 1 : 0]),
    ),
    ...insertMany(
      db,
      'contributions',
      CONTRIBUTION_INSERT,
      state.contribs.map((c) => [userId, c.id, c.goalId, c.date, c.amount, c.cur, c.rate ?? null, c.accountId ?? null]),
    ),
  ];
}

/**
 * Sustituye TODO lo del usuario por `state`: cuentas, meses, ingresos, metas, aportes y también sus ajustes
 * (monedas, cuenta por defecto, tasa por defecto, colores e idioma), de modo que loadState devuelve después ese
 * mismo estado. Lo de los demás usuarios no se toca. Para /api/dev/seed y las pruebas.
 */
export async function replaceAll(db: D1Database, userId: string, state: AppState, now: Date = new Date()): Promise<void> {
  await db.batch([
    setSetting(db, userId, 'default_rate', String(state.defaultRate)),
    setSetting(db, userId, 'theme', themeValue(state.theme)),
    setSetting(db, userId, 'language', state.language),
    setSetting(db, userId, 'main_currency', state.mainCurrency),
    setSetting(db, userId, 'second_currency', state.secondCurrency),
    setSetting(db, userId, 'default_account', state.defaultAccountId),
    setSetting(db, userId, 'gold_price', goldPriceValue(state.goldPrice)),
    // Ya tiene sus cuentas y sus metas (las de `state`): la primera visita no debe añadirle las iniciales.
    setSettingIfMissing(db, userId, 'initialized', '1'),
    ...dataStatements(db, userId, state, now.toISOString()),
  ]);
}

/**
 * "Start blank": borra todo lo del usuario y lo deja como recién llegado, con las cuentas y las metas iniciales
 * y solo el mes `key` vacío. Sus ajustes (idioma, colores, monedas, tasa por defecto) se conservan, salvo la
 * cuenta por defecto: las cuentas son otras y vuelve a la automática.
 */
export async function resetAll(db: D1Database, userId: string, key: MonthKey = currentMonthKey()): Promise<void> {
  const blank: UserData = {
    months: { [key]: { key, closed: false, closedAt: null, budgetLog: [], budgets: {}, rates: [], fixed: [], transfers: [], tx: [] } },
    accounts: [...DEFAULT_ACCOUNTS],
    incomes: [],
    goals: [...DEFAULT_GOALS],
    contribs: [],
    cards: [],
  };
  await db.batch([
    ...dataStatements(db, userId, blank, new Date().toISOString()),
    setSetting(db, userId, 'default_account', null),
    setSettingIfMissing(db, userId, 'default_rate', String(DEFAULT_RATE)),
    setSettingIfMissing(db, userId, 'initialized', '1'),
  ]);
}

/**
 * Aplica un Excel ya leído al usuario. El libro conserva el diseño original (dos monedas, dos cuentas, metas en
 * USD); cómo se vuelca al modelo de cuentas lo decide applyImportToState (shared/excel/data.ts), que es pura:
 * aquí se carga el estado del usuario (preparándolo antes si nunca había entrado, para que tenga cuentas), se
 * calcula el nuevo y se guarda entero en un solo batch, con la misma maquinaria que replaceAll pero sin tocar
 * sus ajustes. Si algo falla no cambia nada.
 *
 * La función pura no tiene reloj: las fechas las pone esta. Un mes del archivo que llega cerrado conserva la
 * fecha de cierre que ya tuviera y, si no tenía, es `now`; las transacciones nuevas se dan de alta con `now`.
 */
export async function applyImport(
  db: D1Database,
  userId: string,
  payload: ImportPayload,
  now: Date = new Date(),
): Promise<ImportResponse> {
  const stamp = now.toISOString();
  const base = await userState(db, userId);
  const next = applyImportToState(base, payload, newId);
  // Un archivo sin nada que aplicar devuelve el mismo estado: no hay nada que reescribir.
  if (next !== base) {
    const months = { ...next.months };
    for (const { key } of payload.months) {
      const month = months[key];
      if (month?.closed && month.closedAt === null) months[key] = { ...month, closedAt: stamp };
    }
    await db.batch(dataStatements(db, userId, { ...next, months }, stamp, true));
  }
  return { months: payload.months.map((m) => m.key), contributions: payload.contribs?.length ?? 0 };
}
