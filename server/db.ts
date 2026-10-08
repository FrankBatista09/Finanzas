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
  CloseResponse,
  ContributionCreate,
  ContributionPatch,
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
  SettingsResponse,
  SettingsUpdate,
  TransferCreate,
  TransferPatch,
  TxCreate,
  TxPatch,
} from '../shared/api';
import { accountsById, defaultAccount, monthCalc, rateFor, sortedKeys } from '../shared/calc';
import {
  CURRENCIES,
  DEFAULT_ACCOUNTS,
  DEFAULT_GOALS,
  DEFAULT_MAIN_CURRENCY,
  DEFAULT_RATE,
  DEFAULT_SECOND_CURRENCY,
} from '../shared/constants';
import { applyImportToState } from '../shared/excel/data';
import { DEFAULT_LANGUAGE, isLanguage } from '../shared/i18n';
import { currentMonthKey, isMonthKey, nextKey } from '../shared/month';
import { isDefaultTheme, normalizeTheme } from '../shared/theme';
import type {
  Account,
  AppState,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  Income,
  Language,
  Month,
  MonthKey,
  MonthRate,
  ThemeColors,
  Transaction,
  Transfer,
  TxSource,
} from '../shared/types';
import type { ApiError } from './errors';
import {
  conflictError,
  invalidData,
  monthClosedError,
  monthNotFoundError,
  noAccountsError,
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
}

interface AccountRow {
  id: string;
  name: string;
  currency: Currency;
  opening: number;
  hidden: number;
  sort: number;
}

interface BudgetRow {
  month_key: string;
  account_id: string;
  amount: number;
}

interface RateRow {
  month_key: string;
  from_currency: Currency;
  to_currency: Currency;
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
}

interface IncomeRow {
  id: string;
  date: string;
  description: string;
  account_id: string;
  amount: number;
  currency: Currency;
}

interface GoalRow {
  id: string;
  name: string;
  currency: Currency;
  monthly: number | null;
  start_month: string | null;
  end_month: string | null;
  sort: number;
}

interface ContributionRow {
  id: string;
  goal_id: string;
  date: string;
  amount: number;
  currency: Currency;
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
  };
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
  };
}

function toIncome(r: IncomeRow): Income {
  return { id: r.id, date: r.date, desc: r.description, accountId: r.account_id, amount: r.amount, cur: r.currency };
}

function toGoal(r: GoalRow): Goal {
  return { id: r.id, name: r.name, cur: r.currency, monthly: r.monthly, start: r.start_month, end: r.end_month, sort: r.sort };
}

function toContribution(r: ContributionRow): Contribution {
  return { id: r.id, goalId: r.goal_id, date: r.date, amount: r.amount, cur: r.currency };
}

/** Las filas que cuelgan de los meses, de uno o de todos. */
interface MonthParts {
  budgets: BudgetRow[];
  rates: RateRow[];
  fixed: FixedRow[];
  transfers: TransferRow[];
  tx: TxRow[];
}

/** Arma cada mes con sus filas, que llegan ya en su orden de lectura. */
function toMonths(months: MonthRow[], parts: MonthParts): Record<MonthKey, Month> {
  const byKey: Record<MonthKey, Month> = {};
  for (const r of months) {
    byKey[r.key] = { key: r.key, closed: r.closed === 1, closedAt: r.closed_at, budgets: {}, rates: [], fixed: [], transfers: [], tx: [] };
  }
  for (const r of parts.budgets) {
    const month = byKey[r.month_key];
    if (month) month.budgets[r.account_id] = r.amount;
  }
  for (const r of parts.rates) byKey[r.month_key]?.rates.push({ from: r.from_currency, to: r.to_currency, rate: r.rate });
  for (const r of parts.fixed) byKey[r.month_key]?.fixed.push(toFixed(r));
  for (const r of parts.transfers) byKey[r.month_key]?.transfers.push(toTransfer(r));
  for (const r of parts.tx) byKey[r.month_key]?.tx.push(toTx(r));
  return byKey;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Límite de D1 por sentencia. */
const MAX_PARAMS = 100;

// Orden de lectura = orden de inserción (rowid), como los arreglos del prototipo; la interfaz ordena por fecha.
// Lo que el usuario ordena (cuentas, fijos, metas) se lee por su `sort`.
const BY_SORT = 'sort, rowid';

type MonthTable = 'fixed_expenses' | 'transactions' | 'transfers';

const ACCOUNT_INSERT = ['user_id', 'id', 'name', 'currency', 'opening', 'hidden', 'sort'];
const MONTH_INSERT = ['user_id', 'key', 'closed', 'closed_at'];
const BUDGET_INSERT = ['user_id', 'month_key', 'account_id', 'amount'];
const RATE_INSERT = ['user_id', 'month_key', 'from_currency', 'to_currency', 'rate'];
const FIXED_INSERT = ['user_id', 'id', 'month_key', 'name', 'day', 'amount', 'currency', 'paid', 'account_id', 'sort'];
const TRANSFER_INSERT = ['user_id', 'id', 'month_key', 'date', 'via', 'from_account_id', 'to_account_id', 'amount', 'rate'];
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
];
const INCOME_INSERT = ['user_id', 'id', 'date', 'description', 'account_id', 'amount', 'currency'];
const GOAL_INSERT = ['user_id', 'id', 'name', 'currency', 'monthly', 'start_month', 'end_month', 'sort'];
const CONTRIBUTION_INSERT = ['user_id', 'id', 'goal_id', 'date', 'amount', 'currency'];

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

/** Las cuentas que una escritura nombra tienen que ser del usuario; devuelve el error de la primera que no lo sea. */
async function accountError(db: D1Database, userId: string, accountIds: readonly string[]): Promise<ApiError | null> {
  if (accountIds.length === 0) return null;
  const known = await accountIdsOf(db, userId);
  const missing = accountIds.find((id) => !known.has(id));
  return missing === undefined ? null : unknownAccountError(missing);
}

async function accountIdsOf(db: D1Database, userId: string): Promise<Set<string>> {
  const res = await db.prepare('SELECT id FROM accounts WHERE user_id = ?').bind(userId).all<{ id: string }>();
  return new Set(res.results.map((r) => r.id));
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

/** Condición "esa cuenta es del usuario". Lleva dos parámetros: el usuario y la cuenta. */
const ACCOUNT_EXISTS = 'EXISTS (SELECT 1 FROM accounts WHERE user_id = ? AND id = ?)';

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
// 'language', 'main_currency', 'second_currency', 'default_account' (NULL = la automática) e 'initialized'
// (ya se le crearon las cuentas y metas iniciales).

type SettingKey = 'default_rate' | 'theme' | 'language' | 'main_currency' | 'second_currency' | 'default_account' | 'initialized';

interface Settings {
  defaultRate: number;
  theme: ThemeColors | null;
  language: Language;
  mainCurrency: Currency;
  secondCurrency: Currency;
  /** Tal como está guardada: puede nombrar una cuenta que ya no existe (ver knownAccount). */
  defaultAccountId: string | null;
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
    initialized: map.has('initialized'),
  };
}

/** La cuenta por defecto guardada solo vale si sigue existiendo; si no, null (la automática de shared/calc). */
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
  return [db.prepare(SELECT_SETTINGS).bind(userId), db.prepare('SELECT id FROM accounts WHERE user_id = ?').bind(userId)];
}

function settingsFrom(settings: D1Result<unknown> | undefined, accounts: D1Result<unknown> | undefined) {
  const stored = toSettings(rows<SettingRow>(settings));
  const accountIds = new Set(rows<{ id: string }>(accounts).map((r) => r.id));
  const response: SettingsResponse = {
    theme: stored.theme,
    language: stored.language,
    mainCurrency: stored.mainCurrency,
    secondCurrency: stored.secondCurrency,
    defaultAccountId: knownAccount(stored.defaultAccountId, accountIds),
  };
  return { response, accountIds };
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
 * una igual a la otra que ya tiene, no (400). La cuenta por defecto tiene que ser una del usuario (400) o null.
 * Si algo no cumple no se guarda nada.
 */
export async function updateSettings(db: D1Database, userId: string, update: SettingsUpdate): Promise<SettingsResponse> {
  const stmts: D1PreparedStatement[] = [];
  if (update.theme !== undefined) stmts.push(setSetting(db, userId, 'theme', themeValue(update.theme)));
  if (update.language !== undefined) stmts.push(setSetting(db, userId, 'language', update.language));

  const currencies = update.mainCurrency !== undefined || update.secondCurrency !== undefined;
  const account = update.defaultAccountId;
  if (currencies || account != null) {
    // Lo que hay ahora, para comprobar el resultado antes de escribir nada.
    const [settings, accounts] = await db.batch(settingsStatements(db, userId));
    const { response: current, accountIds } = settingsFrom(settings, accounts);
    if (currencies) {
      const main = update.mainCurrency ?? current.mainCurrency;
      const second = update.secondCurrency ?? current.secondCurrency;
      if (main === second) throw validationError(invalidData(`secondCurrency: ${SAME_CURRENCY}`));
      // Se escriben las dos, no solo la que vino: así lo guardado es siempre un par válido.
      stmts.push(setSetting(db, userId, 'main_currency', main), setSetting(db, userId, 'second_currency', second));
    }
    if (account != null) {
      if (!accountIds.has(account)) throw unknownAccountError(account);
      // La fila sale de las cuentas del usuario: si la cuenta se borró entre la lectura y esto, no se guarda.
      stmts.push(
        db
          .prepare(
            `INSERT INTO settings (user_id, key, value)
             SELECT a.user_id, 'default_account', a.id FROM accounts a WHERE a.user_id = ?1 AND a.id = ?2
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
  const [months, accounts, budgets, rates, fixed, transfers, tx, incomes, goals, contribs, settings] = await db.batch([
    db.prepare('SELECT * FROM months WHERE user_id = ? ORDER BY key').bind(userId),
    db.prepare(`SELECT * FROM accounts WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM month_budgets WHERE user_id = ?').bind(userId),
    db.prepare('SELECT * FROM month_rates WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare(`SELECT * FROM fixed_expenses WHERE user_id = ? ORDER BY ${BY_SORT}`).bind(userId),
    db.prepare('SELECT * FROM transfers WHERE user_id = ? ORDER BY rowid').bind(userId),
    db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY rowid').bind(userId),
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
        budgets: rows<BudgetRow>(budgets),
        rates: rows<RateRow>(rates),
        fixed: rows<FixedRow>(fixed),
        transfers: rows<TransferRow>(transfers),
        tx: rows<TxRow>(tx),
      }),
      accounts: accountList,
      incomes: rows<IncomeRow>(incomes).map(toIncome),
      goals: rows<GoalRow>(goals).map(toGoal),
      contribs: rows<ContributionRow>(contribs).map(toContribution),
      mainCurrency: stored.mainCurrency,
      secondCurrency: stored.secondCurrency,
      defaultAccountId: knownAccount(stored.defaultAccountId, new Set(accountList.map((a) => a.id))),
      defaultRate: stored.defaultRate,
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
          `INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, sort)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort) FROM goals WHERE user_id = ?1), -1) + 1
           WHERE ${fresh}
             AND NOT EXISTS (SELECT 1 FROM goals WHERE user_id = ?1 AND (id = ?2 OR lower(name) = lower(?3)))`,
        )
        .bind(userId, g.id, g.name, g.cur, g.monthly, g.start, g.end),
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
  return { accounts, defaultAccount: defaultAccount({ ...settings, accounts, months: {}, incomes: [], goals: [], contribs: [] }) };
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
    db.prepare('SELECT * FROM month_budgets WHERE user_id = ? AND month_key = ?').bind(userId, key),
    db.prepare('SELECT * FROM month_rates WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
    db.prepare(`SELECT * FROM fixed_expenses WHERE user_id = ? AND month_key = ? ORDER BY ${BY_SORT}`).bind(userId, key),
    db.prepare('SELECT * FROM transfers WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
    db.prepare('SELECT * FROM transactions WHERE user_id = ? AND month_key = ? ORDER BY rowid').bind(userId, key),
  ];
}

const MONTH_READS = 6;

/** El mes que leyeron las últimas sentencias de un batch (monthStatements), o null si el usuario no lo tiene. */
function monthFrom(results: D1Result<unknown>[], key: MonthKey): Month | null {
  const [month, budgets, rates, fixed, transfers, tx] = results.slice(-MONTH_READS);
  const months = toMonths(rows<MonthRow>(month), {
    budgets: rows<BudgetRow>(budgets),
    rates: rows<RateRow>(rates),
    fixed: rows<FixedRow>(fixed),
    transfers: rows<TransferRow>(transfers),
    tx: rows<TxRow>(tx),
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
 * "Algo usa la cuenta": un gasto fijo, una transacción, un envío (de salida o de llegada), un ingreso o una
 * parte del presupuesto de algún mes. ?1 es el usuario y ?2, la cuenta.
 */
const ACCOUNT_IN_USE = `(
  EXISTS (SELECT 1 FROM fixed_expenses WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM transactions WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM transfers WHERE user_id = ?1 AND (from_account_id = ?2 OR to_account_id = ?2))
  OR EXISTS (SELECT 1 FROM incomes WHERE user_id = ?1 AND account_id = ?2)
  OR EXISTS (SELECT 1 FROM month_budgets WHERE user_id = ?1 AND account_id = ?2))`;

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
 * del presupuesto) responde 409: esa cuenta se oculta, no se borra. Tampoco se puede borrar la última: el
 * usuario siempre tiene al menos una en la que registrar. Si era su cuenta por defecto, vuelve a la automática.
 */
export async function deleteAccount(db: D1Database, userId: string, id: string): Promise<void> {
  const [deleted] = await db.batch([
    db
      .prepare(
        `DELETE FROM accounts WHERE user_id = ?1 AND id = ?2 AND NOT ${ACCOUNT_IN_USE}
         AND (SELECT COUNT(*) FROM accounts WHERE user_id = ?1) > 1 RETURNING id`,
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

/**
 * Cambia las partes del presupuesto que vengan (cuenta → monto en la moneda de esa cuenta): las demás se
 * conservan y un 0 quita la parte. Toda cuenta nombrada tiene que ser del usuario (400). No son saldos.
 */
export async function patchMonth(db: D1Database, userId: string, key: MonthKey, patch: MonthPatch): Promise<Month> {
  const parts = Object.entries(patch.budgets ?? {});
  // Patch vacío: no es una escritura, se devuelve el mes tal como está (también si está cerrado).
  if (parts.length === 0) return requireMonth(db, userId, key);

  // Se comprueba antes de escribir para no aplicar unas partes sí y otras no.
  const unknown = await accountError(db, userId, parts.map(([accountId]) => accountId));
  if (unknown) throw unknown;

  const results = await db.batch([
    ...parts.map(([accountId, amount]) =>
      amount === 0
        ? db
            .prepare(`DELETE FROM month_budgets WHERE user_id = ? AND month_key = ? AND account_id = ? AND month_key IN ${OPEN_MONTHS}`)
            .bind(userId, key, accountId, userId)
        : db
            .prepare(
              `INSERT INTO month_budgets (user_id, month_key, account_id, amount)
               SELECT m.user_id, m.key, a.id, ?4 FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?3
               WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0
               ON CONFLICT(user_id, month_key, account_id) DO UPDATE SET amount = excluded.amount`,
            )
            .bind(userId, key, accountId, amount),
    ),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/**
 * Escribe la tasa de un par para ese mes (1 `from` = `rate` `to`). Hay una sola por par, en el sentido en que
 * se escribió la última vez: escribir USD → DOP sustituye a la DOP → USD que hubiera.
 */
export async function setMonthRate(db: D1Database, userId: string, key: MonthKey, rate: MonthRate): Promise<Month> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM month_rates WHERE user_id = ? AND month_key = ? AND from_currency = ? AND to_currency = ? AND month_key IN ${OPEN_MONTHS}`,
      )
      .bind(userId, key, rate.to, rate.from, userId),
    db
      .prepare(
        `INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, rate)
         SELECT m.user_id, m.key, ?3, ?4, ?5 FROM months m WHERE m.user_id = ?1 AND m.key = ?2 AND m.closed = 0
         ON CONFLICT(user_id, month_key, from_currency, to_currency) DO UPDATE SET rate = excluded.rate`,
      )
      .bind(userId, key, rate.from, rate.to, rate.rate),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/**
 * Quita la tasa escrita de ese par, esté guardada en un sentido o en el otro; a partir de ahí la resuelve
 * rateFor (shared/calc.ts). Si el mes no tenía tasa escrita para el par no cambia nada: devuelve el mes igual.
 */
export async function deleteMonthRate(db: D1Database, userId: string, key: MonthKey, from: Currency, to: Currency): Promise<Month> {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM month_rates WHERE user_id = ? AND month_key = ?
         AND ((from_currency = ? AND to_currency = ?) OR (from_currency = ? AND to_currency = ?)) AND month_key IN ${OPEN_MONTHS}`,
      )
      .bind(userId, key, from, to, to, from, userId),
    ...monthStatements(db, userId, key),
  ]);
  return writtenMonth(results, key);
}

/**
 * Sentencias que crean `key` copiando del mes anterior más cercano del usuario los fijos (sin pagar, con su
 * cuenta y con ids nuevos) y las partes del presupuesto; si no hay mes anterior, queda vacío. Las tasas no se
 * copian: son las de cada mes, y las que falten las resuelve rateFor. Todo en SQL para que la copia sea atómica
 * dentro del batch. El INSERT del mes falla (UNIQUE) si el mes ya existe.
 */
function createMonthStatements(db: D1Database, userId: string, key: MonthKey): D1PreparedStatement[] {
  const previous = '(SELECT MAX(key) FROM months WHERE user_id = ?1 AND key < ?2)';
  return [
    db.prepare('INSERT INTO months (user_id, key) VALUES (?1, ?2)').bind(userId, key),
    db
      .prepare(
        `INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort)
         SELECT ?1, lower(hex(randomblob(16))), ?2, name, day, amount, currency, 0, account_id, sort
         FROM fixed_expenses WHERE user_id = ?1 AND month_key = ${previous} ORDER BY ${BY_SORT}`,
      )
      .bind(userId, key),
    db
      .prepare(
        `INSERT INTO month_budgets (user_id, month_key, account_id, amount)
         SELECT ?1, ?2, account_id, amount FROM month_budgets WHERE user_id = ?1 AND month_key = ${previous}`,
      )
      .bind(userId, key),
  ];
}

/**
 * Devuelve el mes `key` del usuario, creándolo si falta (ver createMonthStatements). `created` dice si lo creó
 * esta llamada. No mira si está cerrado: eso lo decide quien llama.
 */
export async function ensureMonth(db: D1Database, userId: string, key: MonthKey): Promise<{ month: Month; created: boolean }> {
  if (!isMonthKey(key)) throw validationError('Invalid month (expected YYYY-MM).');
  const existing = await getMonth(db, userId, key);
  if (existing) return { month: existing, created: false };

  let created = true;
  try {
    await db.batch(createMonthStatements(db, userId, key));
  } catch (err) {
    // Otra petición lo creó entre la lectura y el batch: vale el suyo.
    if (!isUniqueViolation(err)) throw err;
    created = false;
  }
  return { month: await requireMonth(db, userId, key), created };
}

/**
 * Cierra el mes y, si el siguiente no existe, lo crea con los mismos fijos sin pagar y las mismas partes del
 * presupuesto (doClose() del prototipo), todo en un batch. Cerrar un mes ya cerrado no cambia nada (conserva
 * su closed_at), para que un reintento no falle.
 */
export async function closeMonth(db: D1Database, userId: string, key: MonthKey, now: Date = new Date()): Promise<CloseResponse> {
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
    try {
      await db.batch([close(), ...createMonthStatements(db, userId, next)]);
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
 * Borra el mes, abierto o cerrado, con todo lo suyo: fijos, transacciones, envíos, presupuesto y tasas (las
 * claves foráneas lo arrastran). Los saldos cambian en consecuencia, porque se calculan de lo que queda; los
 * ingresos y los aportes no son de ningún mes y se conservan.
 */
export async function deleteMonth(db: D1Database, userId: string, key: MonthKey): Promise<void> {
  const row = await db.prepare('DELETE FROM months WHERE user_id = ? AND key = ? RETURNING key').bind(userId, key).first();
  if (!row) throw monthNotFoundError(key);
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
} as const;
const NO_FIXED = 'Monthly expense not found.';

/** Las cuentas que nombra un patch con `accountId`. */
const patchedAccount = (patch: { accountId?: string }): string[] => (patch.accountId === undefined ? [] : [patch.accountId]);

/** El nuevo fijo va al final del mes: sort = max(sort) + 1. Sin `accountId` se paga de la cuenta por defecto. */
export async function createFixed(db: D1Database, userId: string, input: FixedCreate): Promise<FixedExpense> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  // La fila sale del mes abierto y de la cuenta del usuario: si falta alguno de los dos, no se inserta nada.
  const row = await firstOrConflict<FixedRow>(
    db
      .prepare(
        `INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort)
         SELECT m.user_id, ?2, m.key, ?4, ?5, ?6, ?7, ?8, a.id,
                COALESCE((SELECT MAX(sort) FROM fixed_expenses WHERE user_id = m.user_id AND month_key = m.key), -1) + 1
         FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?9
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.monthKey, input.name, input.day ?? '', input.amount, input.cur, input.paid ? 1 : 0, accountId),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [accountId]);
  return toFixed(row);
}

export async function patchFixed(db: D1Database, userId: string, id: string, patch: FixedPatch): Promise<FixedExpense> {
  const sets = setClause<FixedPatch>(FIXED_PATCH, patch);
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
  const row = await firstOrConflict<TxRow>(
    db
      .prepare(
        `INSERT INTO transactions (${TX_INSERT.join(', ')})
         SELECT m.user_id, ?2, m.key, ?4, ?5, ?6, ?7, ?8, ?9, ?10, a.id, ?12, ?13, ?14
         FROM months m JOIN accounts a ON a.user_id = m.user_id AND a.id = ?11
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
      ),
  );
  if (!row) throw await createError(db, userId, input.monthKey, [accountId]);
  return toTx(row);
}

export async function patchTransaction(db: D1Database, userId: string, id: string, patch: TxPatch): Promise<Transaction> {
  const sets = setClause<TxPatch>(TX_PATCH, patch);
  return toTx(await patchInMonth<TxRow>(db, userId, 'transactions', id, sets, NO_TX, patchedAccount(patch)));
}

export async function deleteTransaction(db: D1Database, userId: string, id: string): Promise<void> {
  await deleteInMonth(db, userId, 'transactions', id, NO_TX);
}

// ── Envíos entre cuentas ─────────────────────────────────────────────────────

const TRANSFER_PATCH = {
  date: 'date',
  via: 'via',
  fromAccountId: 'from_account_id',
  toAccountId: 'to_account_id',
  amount: 'amount',
  rate: 'rate',
} as const;
const NO_TRANSFER = 'Transfer not found.';

function sameAccountError(): ApiError {
  return validationError(invalidData(`toAccountId: ${SAME_ACCOUNT}`));
}

/**
 * Tasa del mes para las monedas de las dos cuentas (rateFor de shared/calc.ts; 1 si son la misma): la que lleva
 * un envío que llega sin la suya.
 */
async function monthTransferRate(db: D1Database, userId: string, input: TransferCreate): Promise<number> {
  const state = await loadState(db, userId);
  const accounts = accountsById(state);
  const from = accounts.get(input.fromAccountId);
  const to = accounts.get(input.toAccountId);
  if (!from) throw unknownAccountError(input.fromAccountId);
  if (!to) throw unknownAccountError(input.toAccountId);
  return rateFor(state, input.monthKey, from.currency, to.currency).rate;
}

/**
 * Mueve `amount` (en la moneda de la cuenta de origen) de una cuenta a otra distinta; a la de destino le entra
 * amount × rate. Sin `rate` se usa la tasa del mes para las monedas de las dos cuentas.
 */
export async function createTransfer(db: D1Database, userId: string, input: TransferCreate): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) throw sameAccountError();
  const rate = input.rate ?? (await monthTransferRate(db, userId, input));
  const row = await firstOrConflict<TransferRow>(
    db
      .prepare(
        `INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate)
         SELECT m.user_id, ?2, m.key, ?4, ?5, f.id, t.id, ?8, ?9
         FROM months m
         JOIN accounts f ON f.user_id = m.user_id AND f.id = ?6
         JOIN accounts t ON t.user_id = m.user_id AND t.id = ?7
         WHERE m.user_id = ?1 AND m.key = ?3 AND m.closed = 0
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.monthKey, input.date, input.via, input.fromAccountId, input.toAccountId, input.amount, rate),
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

const INCOME_PATCH = { date: 'date', desc: 'description', accountId: 'account_id', amount: 'amount', cur: 'currency' } as const;
const NO_INCOME = 'Income not found.';

export async function listIncomes(db: D1Database, userId: string): Promise<Income[]> {
  const res = await db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY rowid').bind(userId).all<IncomeRow>();
  return res.results.map(toIncome);
}

/** Sin `accountId` el ingreso entra a la cuenta por defecto del usuario. */
export async function createIncome(db: D1Database, userId: string, input: IncomeCreate): Promise<Income> {
  const accountId = input.accountId ?? (await defaultAccountId(db, userId));
  // La fila sale de las cuentas del usuario: una cuenta de otro usuario es como una que no existe.
  const row = await firstOrConflict<IncomeRow>(
    db
      .prepare(
        `INSERT INTO incomes (user_id, id, date, description, account_id, amount, currency)
         SELECT a.user_id, ?2, ?3, ?4, a.id, ?6, ?7 FROM accounts a WHERE a.user_id = ?1 AND a.id = ?5
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.date, input.desc ?? '', accountId, input.amount, input.cur),
  );
  if (!row) throw unknownAccountError(accountId);
  return toIncome(row);
}

export async function patchIncome(db: D1Database, userId: string, id: string, patch: IncomePatch): Promise<Income> {
  const sets = setClause<IncomePatch>(INCOME_PATCH, patch);
  let stmt: D1PreparedStatement;
  if (sets.columns.length === 0) {
    stmt = db.prepare('SELECT * FROM incomes WHERE user_id = ? AND id = ?').bind(userId, id);
  } else if (patch.accountId === undefined) {
    stmt = db.prepare(`UPDATE incomes SET ${sets.sql} WHERE user_id = ? AND id = ? RETURNING *`).bind(...sets.values, userId, id);
  } else {
    stmt = db
      .prepare(`UPDATE incomes SET ${sets.sql} WHERE user_id = ? AND id = ? AND ${ACCOUNT_EXISTS} RETURNING *`)
      .bind(...sets.values, userId, id, userId, patch.accountId);
  }
  const row = await stmt.first<IncomeRow>();
  if (row) return toIncome(row);
  const exists = await db.prepare('SELECT 1 AS found FROM incomes WHERE user_id = ? AND id = ?').bind(userId, id).first();
  // Si el ingreso existe, lo único que pudo frenar la escritura es la cuenta.
  throw exists && patch.accountId !== undefined ? unknownAccountError(patch.accountId) : notFoundError(NO_INCOME);
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
        `INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, sort)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort) FROM goals WHERE user_id = ?1), -1) + 1
         WHERE NOT EXISTS (SELECT 1 FROM goals WHERE user_id = ?1 AND lower(name) = lower(?3))
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.name, cur, plan.monthly, plan.start, plan.end),
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

const CONTRIBUTION_PATCH = { goalId: 'goal_id', date: 'date', amount: 'amount', cur: 'currency' } as const;
const NO_CONTRIBUTION = 'Contribution not found.';

export async function listContributions(db: D1Database, userId: string): Promise<Contribution[]> {
  const res = await db
    .prepare('SELECT * FROM contributions WHERE user_id = ? ORDER BY rowid')
    .bind(userId)
    .all<ContributionRow>();
  return res.results.map(toContribution);
}

export async function createContribution(db: D1Database, userId: string, input: ContributionCreate): Promise<Contribution> {
  // La fila sale de las metas del usuario: una meta de otro usuario es como una que no existe.
  const row = await firstOrConflict<ContributionRow>(
    db
      .prepare(
        `INSERT INTO contributions (user_id, id, goal_id, date, amount, currency)
         SELECT g.user_id, ?2, g.id, ?4, ?5, ?6 FROM goals g WHERE g.user_id = ?1 AND g.id = ?3
         RETURNING *`,
      )
      .bind(userId, input.id ?? newId(), input.goalId, input.date, input.amount, input.cur),
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
  'transfers',
  'fixed_expenses',
  'month_budgets',
  'month_rates',
  'months',
  'goals',
  'accounts',
] as const;

/**
 * Las tasas escritas de un mes tal como se pueden guardar: mayores que 0, entre dos monedas distintas y una
 * sola por par (la primera, que es la que usa rateFor). Lo demás la base lo rechazaría y shared/calc lo ignora.
 */
function storableRates(rates: readonly MonthRate[]): MonthRate[] {
  const pairs = new Set<string>();
  return rates.filter((r) => {
    const pair = [r.from, r.to].sort().join('/');
    if (!(r.rate > 0) || r.from === r.to || pairs.has(pair)) return false;
    pairs.add(pair);
    return true;
  });
}

/** Los datos de un usuario: su estado sin los ajustes. */
type UserData = Pick<AppState, 'months' | 'accounts' | 'incomes' | 'goals' | 'contribs'>;

/**
 * Sentencias que dejan como datos del usuario exactamente los de `state`: borran todo lo que tiene (salvo sus
 * ajustes) y lo insertan de nuevo, en el orden del estado. `stamp` es la fecha de alta de las transacciones que
 * no traen la suya. Una parte del presupuesto en 0 no se guarda: es lo mismo que no tenerla.
 */
function dataStatements(db: D1Database, userId: string, state: UserData, stamp: string): D1PreparedStatement[] {
  const months = Object.keys(state.months)
    .sort()
    .map((k) => state.months[k]!);
  return [
    ...DATA_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId)),
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
      state.goals.map((g) => [userId, g.id, g.name, g.cur, g.monthly, g.start, g.end, g.sort]),
    ),
    ...insertMany(
      db,
      'months',
      MONTH_INSERT,
      months.map((m) => [userId, m.key, m.closed ? 1 : 0, m.closedAt]),
    ),
    ...insertMany(
      db,
      'month_budgets',
      BUDGET_INSERT,
      months.flatMap((m) =>
        Object.entries(m.budgets)
          .filter(([, amount]) => amount !== 0)
          .map(([accountId, amount]) => [userId, m.key, accountId, amount]),
      ),
    ),
    ...insertMany(
      db,
      'month_rates',
      RATE_INSERT,
      months.flatMap((m) => storableRates(m.rates).map((r) => [userId, m.key, r.from, r.to, r.rate])),
    ),
    ...insertMany(
      db,
      'fixed_expenses',
      FIXED_INSERT,
      months.flatMap((m) =>
        m.fixed.map((f) => [userId, f.id, m.key, f.name, String(f.day ?? ''), f.amount, f.cur, f.paid ? 1 : 0, f.accountId, f.sort]),
      ),
    ),
    ...insertMany(
      db,
      'transfers',
      TRANSFER_INSERT,
      months.flatMap((m) => m.transfers.map((t) => [userId, t.id, m.key, t.date, t.via, t.fromAccountId, t.toAccountId, t.amount, t.rate])),
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
        ]),
      ),
    ),
    ...insertMany(
      db,
      'incomes',
      INCOME_INSERT,
      state.incomes.map((i) => [userId, i.id, i.date, i.desc, i.accountId, i.amount, i.cur]),
    ),
    ...insertMany(
      db,
      'contributions',
      CONTRIBUTION_INSERT,
      state.contribs.map((c) => [userId, c.id, c.goalId, c.date, c.amount, c.cur]),
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
    months: { [key]: { key, closed: false, closedAt: null, budgets: {}, rates: [], fixed: [], transfers: [], tx: [] } },
    accounts: [...DEFAULT_ACCOUNTS],
    incomes: [],
    goals: [...DEFAULT_GOALS],
    contribs: [],
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
    await db.batch(dataStatements(db, userId, { ...next, months }, stamp));
  }
  return { months: payload.months.map((m) => m.key), contributions: payload.contribs?.length ?? 0 };
}
