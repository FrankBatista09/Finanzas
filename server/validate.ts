// Esquemas zod de todos los cuerpos de petición de shared/api.ts.
// Objetos estrictos (una clave desconocida es un error), textos recortados y montos finitos.
// Categorías, métodos y vías son texto libre: las listas de shared/constants.ts son sugerencias de la interfaz
// y un Excel importado puede traer otros valores.
// Los mensajes van en inglés, como todo lo que responde la API (la web traduce por el código del error).

import { z } from 'zod';
import { en } from 'zod/locales';
import type {
  AccountCreate,
  AccountPatch,
  BudgetEntryCreate,
  CloseRequest,
  ContributionCreate,
  ContributionPatch,
  FixedCreate,
  FixedPatch,
  GoalCreate,
  GoalPatch,
  ImportPayload,
  IncomeCreate,
  IncomePatch,
  MonthPatch,
  SettingsUpdate,
  TransferCreate,
  TransferPatch,
  TxCreate,
  TxPatch,
} from '../shared/api';
import { GOLD, MAX_LEN } from '../shared/constants';
import { isLanguage, LANGUAGES } from '../shared/i18n';
import { isISODate, isMonthKey } from '../shared/month';
import { normalizeTheme } from '../shared/theme';
import type { Currency, ISODate, Language, MonthKey, MonthRate, ThemeColors } from '../shared/types';
import { validationError, zodMessage } from './errors';

/** Ids que puede mandar el cliente al crear (actualizaciones optimistas). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Los topes de texto viven en shared/constants.ts: las celdas del frontend aplican los mismos.
export { MAX_LEN };

/** Tope de cordura para montos: ni la validación ni SQLite tienen problema con más, pero sería un error de dedo. */
export const MAX_AMOUNT = 1e12;

type IssueLike = { input?: unknown };

/** Mensaje de tipo: distingue "falta" de "vino con otro tipo". */
const typed = (message: string) => (issue: IssueLike) => (issue.input === undefined ? 'is required' : message);

const text = (max: number) => z.string({ error: typed('must be text') }).trim().max(max, { error: `allows up to ${max} characters` });
const requiredText = (max: number) => text(max).min(1, { error: 'cannot be empty' });

// z.number() ya rechaza NaN e Infinity (JSON.parse('1e999') da Infinity).
const num = () => z.number({ error: typed('must be a number') });
const TOO_BIG = { error: 'is too large' };
const MUST_BE_POSITIVE = 'must be greater than 0';
const positive = () => num().gt(0, { error: MUST_BE_POSITIVE }).max(MAX_AMOUNT, TOO_BIG);
const nonNegative = () => num().min(0, { error: 'cannot be negative' }).max(MAX_AMOUNT, TOO_BIG);
const anyAmount = () => num().min(-MAX_AMOUNT, { error: 'is too small' }).max(MAX_AMOUNT, TOO_BIG);
const sortIndex = () => num().int({ error: 'must be an integer' }).min(0, { error: 'cannot be negative' }).max(1_000_000, TOO_BIG);

const id = () => z.string({ error: typed('must be text') }).regex(ID_RE, { error: 'only letters, numbers, "-" and "_" are allowed (up to 64)' });
const monthKey = () => z.string({ error: typed('must be a month (YYYY-MM)') }).refine(isMonthKey, { error: 'is not a valid month (YYYY-MM)' });
const isoDate = () => z.string({ error: typed('must be a date (YYYY-MM-DD)') }).refine(isISODate, { error: 'is not a valid date (YYYY-MM-DD)' });
const currency = () => z.enum(['DOP', 'USD', 'TRY'], { error: 'must be DOP, USD or TRY' });
// El oro ('XAU', en gramos) solo se acepta donde va una cuenta: su moneda y la de un ingreso que le entra.
const accountCurrency = () => z.enum(['DOP', 'USD', 'TRY', GOLD], { error: 'must be DOP, USD, TRY or XAU (gold, in grams)' });
const bool = () => z.boolean({ error: typed('must be true or false') });

// ── Ajustes del usuario ──────────────────────────────────────────────────────

const LANGUAGE_IDS = LANGUAGES.map((l) => l.id).join(', ');

/** null vuelve a la paleta original; un tema son los tres colores, que salen normalizados ('#rrggbb' en minúsculas). */
const theme = () =>
  z.unknown().transform((value, ctx): ThemeColors | null => {
    if (value === null) return null;
    const colors = normalizeTheme(value);
    if (colors) return colors;
    ctx.issues.push({ code: 'custom', input: value, message: 'must be null or the three colors accent, header and background as "#rrggbb"' });
    return z.NEVER;
  });

export const SAME_CURRENCY = 'must be different from mainCurrency';

// Que las dos monedas queden distintas se comprueba aquí solo si vienen las dos; si viene una, lo comprueba
// updateSettings (server/db.ts) contra la que el usuario ya tiene. Igual con la cuenta por defecto: que exista.
export const settingsUpdateSchema = z
  .strictObject({
    theme: theme().optional(),
    language: z.custom<Language>(isLanguage, { error: `must be one of: ${LANGUAGE_IDS}` }).optional(),
    mainCurrency: currency().optional(),
    secondCurrency: currency().optional(),
    defaultAccountId: id().nullable().optional(),
    // Lo que vale 1 gramo de oro, en una moneda normal; null quita el precio.
    goldPrice: z.strictObject({ amount: positive(), currency: currency() }, { error: typed('must be null or { amount, currency }') }).nullable().optional(),
  })
  .refine((s) => Object.values(s).some((value) => value !== undefined), {
    error: 'nothing to change: send theme, language, mainCurrency, secondCurrency, defaultAccountId or goldPrice',
  })
  .refine((s) => s.mainCurrency === undefined || s.mainCurrency !== s.secondCurrency, {
    error: SAME_CURRENCY,
    path: ['secondCurrency'],
  }) satisfies z.ZodType<SettingsUpdate>;

// ── Cuentas ──────────────────────────────────────────────────────────────────

// El saldo inicial puede ser negativo (una cuenta que arranca en sobregiro, o un saldo corregido a la baja).
export const accountCreateSchema = z.strictObject({
  id: id().optional(),
  name: requiredText(MAX_LEN.name),
  currency: accountCurrency(),
  opening: anyAmount().optional(),
}) satisfies z.ZodType<AccountCreate>;

export const accountPatchSchema = z.strictObject({
  name: requiredText(MAX_LEN.name).optional(),
  currency: accountCurrency().optional(),
  opening: anyAmount().optional(),
  hidden: bool().optional(),
  sort: sortIndex().optional(),
}) satisfies z.ZodType<AccountPatch>;

// ── Meses ────────────────────────────────────────────────────────────────────

/** Un usuario tiene un puñado de cuentas; el tope solo evita que un cuerpo absurdo se convierta en miles de sentencias. */
export const MAX_BUDGET_PARTS = 100;

const budgetParts = () =>
  z
    .record(id(), nonNegative(), { error: typed('must be an object of account id → amount') })
    .refine((parts) => Object.keys(parts).length <= MAX_BUDGET_PARTS, { error: `allows up to ${MAX_BUDGET_PARTS} accounts` });

// Partes del presupuesto por cuenta: el monto en que queda cada una. Que la cuenta exista lo comprueba patchMonth (server/db.ts).
export const monthPatchSchema = z.strictObject({
  budgets: budgetParts().optional(),
}) satisfies z.ZodType<MonthPatch>;

// Un movimiento del presupuesto: suma o resta, pero no 0 (no cambiaría nada). El sobrante tiene su propia ruta.
// Que la fecha caiga en el mes y que la cuenta exista lo comprueba addBudgetEntry (server/db.ts).
export const budgetEntryCreateSchema = z.strictObject({
  id: id().optional(),
  date: isoDate().optional(),
  accountId: id(),
  amount: anyAmount().refine((n) => n !== 0, { error: 'cannot be 0' }),
  kind: z.enum(['initial', 'adjust'], { error: 'must be initial or adjust' }).optional(),
  note: text(MAX_LEN.desc).optional(),
}) satisfies z.ZodType<BudgetEntryCreate>;

// Cuerpo opcional del cierre de mes: las partes iniciales del mes siguiente y si se le suma el sobrante.
export const closeRequestSchema = z.strictObject({
  budgets: budgetParts().optional(),
  addLeftover: bool().optional(),
}) satisfies z.ZodType<CloseRequest>;

const DIFFERENT_RATE_CURRENCIES = 'must be different from `from`';

/** Tasa escrita a mano: 1 `from` = `rate` `to` desde `date`. Que la fecha caiga en el mes lo comprueba setMonthRate (server/db.ts). */
export const monthRateSchema = z
  .strictObject({ from: currency(), to: currency(), rate: positive(), date: isoDate() })
  .refine((r) => r.from !== r.to, { error: DIFFERENT_RATE_CURRENCIES, path: ['to'] }) satisfies z.ZodType<MonthRate>;

/** El par y la fecha de DELETE /api/months/:key/rates/:from/:to?date= (vienen en la ruta y en la consulta). */
export const ratePairSchema = z
  .strictObject({ from: currency(), to: currency(), date: isoDate() })
  .refine((r) => r.from !== r.to, { error: DIFFERENT_RATE_CURRENCIES, path: ['to'] });

// ── Gastos fijos ─────────────────────────────────────────────────────────────

export const fixedCreateSchema = z.strictObject({
  id: id().optional(),
  monthKey: monthKey(),
  name: requiredText(MAX_LEN.name),
  day: text(MAX_LEN.day).optional(),
  amount: positive(),
  cur: currency(),
  paid: bool().optional(),
  accountId: id().optional(),
}) satisfies z.ZodType<FixedCreate>;

// Al editar una celda el monto puede quedar en 0 (el prototipo deja vaciar el campo); al crear no.
export const fixedPatchSchema = z.strictObject({
  name: requiredText(MAX_LEN.name).optional(),
  day: text(MAX_LEN.day).optional(),
  amount: nonNegative().optional(),
  cur: currency().optional(),
  paid: bool().optional(),
  accountId: id().optional(),
  sort: sortIndex().optional(),
}) satisfies z.ZodType<FixedPatch>;

// ── Transacciones ────────────────────────────────────────────────────────────

export const txCreateSchema = z.strictObject({
  id: id().optional(),
  monthKey: monthKey(),
  date: isoDate(),
  desc: requiredText(MAX_LEN.desc),
  place: text(MAX_LEN.place).optional(),
  cat: requiredText(MAX_LEN.label),
  method: requiredText(MAX_LEN.label),
  amount: positive(),
  cur: currency(),
  accountId: id().optional(),
  notes: text(MAX_LEN.notes).optional(),
}) satisfies z.ZodType<TxCreate>;

export const txPatchSchema = z.strictObject({
  date: isoDate().optional(),
  desc: requiredText(MAX_LEN.desc).optional(),
  place: text(MAX_LEN.place).optional(),
  cat: requiredText(MAX_LEN.label).optional(),
  method: requiredText(MAX_LEN.label).optional(),
  amount: nonNegative().optional(),
  cur: currency().optional(),
  accountId: id().optional(),
  notes: text(MAX_LEN.notes).optional(),
}) satisfies z.ZodType<TxPatch>;

// ── Envíos ───────────────────────────────────────────────────────────────────

export const SAME_ACCOUNT = 'must be different from fromAccountId';

// La vía es texto libre: Remitly y PayPal (shared/constants.ts VIAS) son solo sugerencias.
// Sin `rate`, createTransfer (server/db.ts) pone la tasa del mes para las monedas de las dos cuentas.
export const transferCreateSchema = z
  .strictObject({
    id: id().optional(),
    monthKey: monthKey(),
    date: isoDate(),
    via: requiredText(MAX_LEN.label),
    fromAccountId: id(),
    toAccountId: id(),
    amount: positive(),
    rate: positive().optional(),
    budget: bool().optional(),
    fee: nonNegative().optional(),
  })
  .refine((t) => t.fromAccountId !== t.toAccountId, { error: SAME_ACCOUNT, path: ['toAccountId'] }) satisfies z.ZodType<TransferCreate>;

// Si solo viene una de las dos cuentas, que no coincida con la otra lo comprueba patchTransfer (server/db.ts).
export const transferPatchSchema = z
  .strictObject({
    date: isoDate().optional(),
    via: requiredText(MAX_LEN.label).optional(),
    fromAccountId: id().optional(),
    toAccountId: id().optional(),
    amount: positive().optional(),
    rate: positive().optional(),
    budget: bool().optional(),
    fee: nonNegative().optional(),
  })
  .refine((t) => t.fromAccountId === undefined || t.fromAccountId !== t.toAccountId, {
    error: SAME_ACCOUNT,
    path: ['toAccountId'],
  }) satisfies z.ZodType<TransferPatch>;

// ── Ingresos ─────────────────────────────────────────────────────────────────

export const GOLD_NO_BUDGET = 'an income in gold (XAU, grams) cannot add to the budget';

// Los gramos de oro no son presupuesto. Que `cur` sea XAU si y solo si la cuenta es de oro lo comprueban
// createIncome y patchIncome (server/db.ts), que son quienes conocen la cuenta.
const goldNoBudget = (i: { cur?: string | undefined; budget?: boolean | undefined }) => !(i.cur === GOLD && i.budget === true);

export const incomeCreateSchema = z
  .strictObject({
    id: id().optional(),
    date: isoDate(),
    desc: text(MAX_LEN.desc).optional(),
    accountId: id().optional(),
    amount: positive(),
    cur: accountCurrency(),
    budget: bool().optional(),
  })
  .refine(goldNoBudget, { error: GOLD_NO_BUDGET, path: ['budget'] }) satisfies z.ZodType<IncomeCreate>;

export const incomePatchSchema = z
  .strictObject({
    date: isoDate().optional(),
    desc: text(MAX_LEN.desc).optional(),
    accountId: id().optional(),
    amount: nonNegative().optional(),
    cur: accountCurrency().optional(),
    budget: bool().optional(),
  })
  .refine(goldNoBudget, { error: GOLD_NO_BUDGET, path: ['budget'] }) satisfies z.ZodType<IncomePatch>;

// ── Metas y aportes ──────────────────────────────────────────────────────────

export interface GoalPlan {
  /** Ahorro mensual planeado, en la moneda de la meta. */
  monthly: number | null;
  start: MonthKey | null;
  end: MonthKey | null;
}

export interface GoalPlanIssue {
  /** 'partial': falta parte del plan; 'amount': el mensual no es mayor que 0; 'order': el inicio va después del fin. */
  kind: 'partial' | 'amount' | 'order';
  /** Campo al que se atribuye: el del mensual (`field`) o 'end'. */
  path: string;
  message: string;
}

const START_AFTER_END = 'the start month cannot be after the end month';

/**
 * Regla del plan de una meta (shared/api.ts): o van los tres juntos (monthly > 0 y start <= end) o los tres
 * son null (aportes variables). Devuelve el problema, o null si cumple. La usan el esquema de creación, el de
 * importación y server/db.ts, que al editar la aplica sobre la meta resultante (lo que hay más lo que cambia).
 * `field` es cómo se llama el mensual en el cuerpo que se valida: 'monthly' en la API, 'monthlyUSD' en el Excel.
 */
export function goalPlanIssue(plan: GoalPlan, field = 'monthly'): GoalPlanIssue | null {
  const { monthly, start, end } = plan;
  if (monthly === null && start === null && end === null) return null;
  if (monthly === null || start === null || end === null) {
    return {
      kind: 'partial',
      path: field,
      message: `${field}, start and end go together: set all three, or leave all three null`,
    };
  }
  if (!(monthly > 0)) return { kind: 'amount', path: field, message: MUST_BE_POSITIVE };
  // Solo se comparan meses de verdad: uno mal escrito ya tiene su propio error.
  if (isMonthKey(start) && isMonthKey(end) && start > end) return { kind: 'order', path: 'end', message: START_AFTER_END };
  return null;
}

type PlanMonths = { start?: string | null | undefined; end?: string | null | undefined };

/** La meta completa (crear, importar): lo que no viene cuenta como null. */
function wholePlan(ctx: z.RefinementCtx, monthly: number | null | undefined, months: PlanMonths, field: string): void {
  const issue = goalPlanIssue({ monthly: monthly ?? null, start: months.start ?? null, end: months.end ?? null }, field);
  // Un mensual que no es mayor que 0 ya lo señala su propio campo: no se repite.
  if (issue && issue.kind !== 'amount') ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
}

// Sin `cur`, createGoal (server/db.ts) pone la moneda principal del usuario.
export const goalCreateSchema = z
  .strictObject({
    id: id().optional(),
    name: requiredText(MAX_LEN.name),
    cur: currency().optional(),
    monthly: positive().nullable().optional(),
    start: monthKey().nullable().optional(),
    end: monthKey().nullable().optional(),
    approxCur: currency().nullable().optional(),
  })
  .superRefine((g, ctx) => wholePlan(ctx, g.monthly, g, 'monthly')) satisfies z.ZodType<GoalCreate>;

// Un patch trae solo parte de la meta: aquí se valida cada campo y que lo que venga no se contradiga;
// la regla completa del plan la aplica patchGoal (server/db.ts) sobre la meta resultante.
export const goalPatchSchema = z
  .strictObject({
    name: requiredText(MAX_LEN.name).optional(),
    cur: currency().optional(),
    monthly: positive().nullable().optional(),
    start: monthKey().nullable().optional(),
    end: monthKey().nullable().optional(),
    approxCur: currency().nullable().optional(),
    sort: sortIndex().optional(),
  })
  .refine((g) => !g.start || !g.end || g.start <= g.end, { error: START_AFTER_END, path: ['end'] }) satisfies z.ZodType<GoalPatch>;

export const contributionCreateSchema = z.strictObject({
  id: id().optional(),
  goalId: id(),
  date: isoDate(),
  amount: positive(),
  cur: currency(),
}) satisfies z.ZodType<ContributionCreate>;

export const contributionPatchSchema = z.strictObject({
  goalId: id().optional(),
  date: isoDate().optional(),
  amount: nonNegative().optional(),
  cur: currency().optional(),
}) satisfies z.ZodType<ContributionPatch>;

// ── Registro desde Claude ────────────────────────────────────────────────────

/** IngestTransaction ya validado; los campos opcionales siguen sin valor por defecto (los pone server/ingest.ts). */
export interface IngestInput {
  /** Tal como vino: quién es lo resuelve server/ingest.ts contra los usuarios configurados. */
  user?: string | undefined;
  date?: ISODate | undefined;
  description: string;
  place?: string | undefined;
  category?: string | undefined;
  method?: string | undefined;
  amount: number;
  currency?: Currency | undefined;
  /** Id o nombre de la cuenta, tal como vino: cuál es lo resuelve server/ingest.ts (matchAccount). */
  account?: string | undefined;
  notes?: string | undefined;
}

// Un modelo suele mandar null o '' en lo que no sabe: se toma como "no vino" y se aplica el valor por defecto.
const blank = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const optionalField = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

export const ingestSchema = z.strictObject({
  user: optionalField(text(MAX_LEN.label)),
  date: optionalField(isoDate()),
  description: requiredText(MAX_LEN.desc),
  place: optionalField(text(MAX_LEN.place)),
  category: optionalField(text(MAX_LEN.label)),
  method: optionalField(text(MAX_LEN.label)),
  amount: positive(),
  currency: optionalField(currency()),
  account: optionalField(text(MAX_LEN.name)),
  notes: optionalField(text(MAX_LEN.notes)),
}) satisfies z.ZodType<IngestInput>;

// ── Importación ──────────────────────────────────────────────────────────────
// Más laxa que las rutas de edición, como el importador del prototipo: una fila del Excel puede traer
// monto 0, descripción vacía o tasa 0. Lo que no se acepta son tipos equivocados ni fechas ilegibles.
// El libro conserva el diseño original (shared/api.ts, "Excel"): solo conoce DOP y USD, dos cuentas y metas
// en USD. Cómo se vuelca eso al modelo de cuentas es cosa de shared/excel/data.ts (applyImportToState).

const bookCurrency = () => z.enum(['DOP', 'USD'], { error: 'must be DOP or USD' });

export const MAX_IMPORT = { months: 600, fixed: 500, transfers: 2000, tx: 20000, contribs: 20000, goals: 200 } as const;

const tooMany = (max: number) => ({ error: `allows up to ${max} items` });

const importFixedSchema = z.strictObject({
  name: requiredText(MAX_LEN.name),
  // En la hoja el día suele ser una celda numérica.
  day: z.union([text(MAX_LEN.day), num().transform((n) => String(n))], { error: 'must be text' }),
  amount: nonNegative(),
  cur: bookCurrency(),
  paid: bool(),
});

const importTransferSchema = z.strictObject({
  date: isoDate(),
  via: text(MAX_LEN.label),
  usd: nonNegative(),
  rate: nonNegative(),
});

const importTxSchema = z.strictObject({
  date: isoDate(),
  desc: text(MAX_LEN.desc),
  place: text(MAX_LEN.place),
  cat: text(MAX_LEN.label),
  method: text(MAX_LEN.label),
  amount: nonNegative(),
  cur: bookCurrency(),
  notes: text(MAX_LEN.notes),
});

const importMonthSchema = z.strictObject({
  key: monthKey(),
  closed: bool(),
  budget: nonNegative(),
  incomeUSD: nonNegative(),
  accounts: z.strictObject({ usd: anyAmount(), dop: anyAmount() }),
  fixed: z.array(importFixedSchema).max(MAX_IMPORT.fixed, tooMany(MAX_IMPORT.fixed)),
  transfers: z.array(importTransferSchema).max(MAX_IMPORT.transfers, tooMany(MAX_IMPORT.transfers)),
  tx: z.array(importTxSchema).max(MAX_IMPORT.tx, tooMany(MAX_IMPORT.tx)),
});

// El plan de una meta sí se exige completo: medio plan guardado no significa nada, y es mejor rechazar el
// archivo diciendo dónde está que borrar o inventar un objetivo.
const importGoalSchema = z
  .strictObject({
    name: requiredText(MAX_LEN.name),
    monthlyUSD: positive().nullable(),
    start: monthKey().nullable(),
    end: monthKey().nullable(),
  })
  .superRefine((g, ctx) => wholePlan(ctx, g.monthlyUSD, g, 'monthlyUSD'));

export const importSchema = z
  .strictObject({
    months: z.array(importMonthSchema).max(MAX_IMPORT.months, tooMany(MAX_IMPORT.months)),
    contribs: z
      .array(z.strictObject({ date: isoDate(), goalName: requiredText(MAX_LEN.name), amount: nonNegative(), cur: bookCurrency() }))
      .max(MAX_IMPORT.contribs, tooMany(MAX_IMPORT.contribs))
      .nullable(),
    goals: z.array(importGoalSchema).max(MAX_IMPORT.goals, tooMany(MAX_IMPORT.goals)).nullable(),
  })
  .refine((p) => new Set(p.months.map((m) => m.key)).size === p.months.length, {
    error: 'there are repeated months',
    path: ['months'],
  }) satisfies z.ZodType<ImportPayload>;

// ── Uso ──────────────────────────────────────────────────────────────────────

// Se fija el idioma en cada llamada en vez de fiarse de la configuración global de zod: los mensajes que no se
// escribieron a mano (clave desconocida, tipo equivocado del cuerpo) también tienen que salir en inglés.
const english = en().localeError;

/** Valida `data` y devuelve el valor ya normalizado (textos recortados); si no cumple, lanza ApiError 400 `validation`. */
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data, { error: english });
  if (!result.success) throw validationError(zodMessage(result.error));
  return result.data;
}
