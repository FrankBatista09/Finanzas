// Contrato HTTP entre el frontend (src/api) y la API (server/app.ts). Ambos lados importan estos tipos.
//
// Autenticación (quién puede entrar)
//   · /api/*           → Cloudflare Access delante del sitio (y se valida su JWT si ACCESS_TEAM_DOMAIN + ACCESS_AUD
//                        están definidos, ver server/auth.ts).
//   · /api/ingest/*    → Authorization: Bearer <API_TOKEN>  (lo usa Claude; queda fuera de Access)
//   · /mcp             → Authorization: Bearer <API_TOKEN>
//
// Usuario (de quién son los datos)
//   · Los usuarios salen de la variable de entorno USERS (shared/users.ts). Cada uno tiene sus finanzas aparte.
//   · Toda ruta de /api/* salvo /api/session y /api/ingest/* exige la cabecera `X-User: <id>` (USER_HEADER).
//     Falta o no es un usuario configurado → 400 validation. Todo lo que la ruta lee o escribe es de ese usuario;
//     un id (de gasto, cuenta, meta…) que exista pero sea de otro usuario responde 404, como si no existiera.
//   · No es un control de acceso: cualquiera que pase Access puede elegir cualquier usuario en el selector.
//   · /api/ingest/* y /mcp reciben el usuario en el cuerpo (`user`), obligatorio si hay más de uno configurado.
//
// Idioma: la interfaz se traduce (inglés, español, turco; lo elige cada usuario), pero la API siempre responde en
// inglés. El cliente no muestra `error.message` tal cual: traduce por `error.code` y deja el mensaje como detalle.
//
// Errores: cualquier respuesta no-2xx de /api/* tiene cuerpo ApiErrorBody. En /mcp solo el 401 lo tiene;
// el resto de sus fallos son errores JSON-RPC (server/mcp.ts).
//
// Dinero (shared/types.ts y shared/calc.ts): tres monedas (DOP, USD, TRY); cada usuario tiene su moneda principal,
// su segunda moneda y sus cuentas. El servidor guarda montos y monedas originales y nunca cifras convertidas ni
// saldos: los saldos, el ingreso del mes y los totales se calculan del estado (shared/calc.ts), igual en la web,
// en el servidor y en el MCP.
//
// Rutas (todas JSON salvo export.xlsx):
//   GET    /api/session                       → SessionResponse   (sin X-User: lista de usuarios para el selector)
//   GET    /api/state                         → StateResponse     (la primera vez de un usuario le crea sus cuentas
//                                                                  y metas iniciales y el mes actual)
//   PATCH  /api/settings         SettingsUpdate → SettingsResponse (idioma, colores, monedas y cuenta por defecto)
//
//   GET    /api/accounts                      → Account[]
//   POST   /api/accounts         AccountCreate → Account           (201)
//   PATCH  /api/accounts/:id     AccountPatch → Account            (cambiar `currency` → 409 si la cuenta tiene movimientos)
//   DELETE /api/accounts/:id                  → OkResponse        (409 conflict si algo la usa: se oculta, no se borra)
//
//   GET    /api/months                        → MonthSummary[]
//   GET    /api/months/:key                   → Month
//   PATCH  /api/months/:key      MonthPatch   → Month             (partes del presupuesto por cuenta)
//   PUT    /api/months/:key/rates MonthRate   → Month             (escribe la tasa de un par; una sola por par)
//   DELETE /api/months/:key/rates/:from/:to   → Month             (quita la tasa escrita de ese par)
//   POST   /api/months/:key/close             → CloseResponse     (cierra y crea el siguiente, en un batch de D1)
//   POST   /api/months/:key/reopen            → Month
//   DELETE /api/months/:key                   → OkResponse        (borra el mes con sus gastos, transacciones,
//                                                                  envíos, presupuesto y tasas; abierto o cerrado)
//
//   POST   /api/fixed            FixedCreate  → FixedExpense      (201)
//   PATCH  /api/fixed/:id        FixedPatch   → FixedExpense
//   DELETE /api/fixed/:id                     → OkResponse
//   POST   /api/transactions     TxCreate     → Transaction       (201)
//   PATCH  /api/transactions/:id TxPatch      → Transaction
//   DELETE /api/transactions/:id              → OkResponse
//   POST   /api/transfers        TransferCreate → Transfer        (201)
//   PATCH  /api/transfers/:id    TransferPatch  → Transfer
//   DELETE /api/transfers/:id                 → OkResponse
//
//   GET    /api/incomes                       → Income[]
//   POST   /api/incomes          IncomeCreate → Income            (201)
//   PATCH  /api/incomes/:id      IncomePatch  → Income
//   DELETE /api/incomes/:id                   → OkResponse
//   GET    /api/goals                         → Goal[]
//   POST   /api/goals            GoalCreate   → Goal              (201)
//   PATCH  /api/goals/:id        GoalPatch    → Goal
//   DELETE /api/goals/:id                     → OkResponse        (409 conflict si tiene aportes)
//   GET    /api/contributions                 → Contribution[]
//   POST   /api/contributions    ContributionCreate → Contribution (201)
//   PATCH  /api/contributions/:id ContributionPatch → Contribution
//   DELETE /api/contributions/:id             → OkResponse
//
//   GET    /api/export.xlsx                   → binario .xlsx (Content-Disposition: attachment)
//   POST   /api/import           ImportPayload (JSON) o el .xlsx crudo → ImportResponse
//          (la web genera y lee el .xlsx en el navegador con shared/excel; ver "Excel" más abajo)
//   POST   /api/ingest/transaction IngestTransaction → IngestResponse (201)   [Bearer, usuario en el cuerpo]
//   POST   /api/dev/seed                      → OkResponse   (solo si ALLOW_DEV_RESET=1) datos de ejemplo para ese usuario
//   POST   /api/dev/reset                     → OkResponse   (solo si ALLOW_DEV_RESET=1) deja en blanco a ese usuario
//
// Reglas de escritura
//   · Un mes cerrado es de solo lectura: crear/editar/borrar sus fijos, transacciones o envíos, y cambiar su
//     presupuesto o sus tasas → 409 month_closed. Sí se puede reabrir y borrar.
//   · Ingresos y aportes no pertenecen a un mes: se pueden crear, editar y borrar siempre, con cualquier fecha.
//   · El cliente puede mandar `id` al crear (actualizaciones optimistas sin reconciliar ids). Si falta, lo genera el servidor.
//   · Montos: números finitos; amount > 0 al crear y >= 0 al editar; rate > 0. Las partes del presupuesto son >= 0
//     (0 quita la parte) y el saldo inicial de una cuenta puede ser cualquier número finito, también negativo.
//     Quitar una tasa que no estaba escrita no es un error: responde el mes tal cual.
//   · Cuentas: toda fila que referencia una cuenta (fijo, transacción, envío, ingreso, parte del presupuesto) debe
//     nombrar una cuenta existente del usuario → si no, 400 validation. Si al crear un fijo, una transacción o un
//     ingreso falta `accountId`, se usa la cuenta por defecto (defaultAccount en shared/calc.ts). Un envío necesita
//     dos cuentas distintas; si falta `rate` se usa la tasa del mes para ese par (1 entre cuentas de igual moneda).
//   · Monedas: mainCurrency y secondCurrency deben ser distintas.
//   · Metas: con plan van juntos monthly > 0, start y end (start <= end); sin plan, los tres null. Mandar solo una
//     parte → 400 validation. El monto objetivo no viaja: es monthly × meses (shared/types.ts Goal).
//
// Excel (pendiente de rediseño): el libro sigue con el diseño original, que solo conoce USD y DOP y dos cuentas.
//   · Exportar (shared/excel/data.ts buildExportData) proyecta el estado a esa forma: presupuesto total en DOP,
//     ingreso del mes en USD, saldo de las cuentas en DOP por un lado y el resto en USD por otro, los importes en
//     TRY convertidos, y solo los envíos entre USD y DOP. Es un resumen fiel en totales, no una copia exacta.
//   · Importar lee ese mismo formato (ImportPayload) y lo vuelca al modelo de cuentas (las reglas, y lo que se pierde en cada
//     sentido, están en shared/excel/data.ts applyImportToState; server/db.ts applyImport lo guarda).

import type {
  Account,
  AppState,
  AppUser,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  Income,
  ISODate,
  Language,
  Month,
  MonthKey,
  ThemeColors,
  Transaction,
  Transfer,
} from './types';

export type ApiErrorCode =
  | 'validation'
  | 'not_found'
  | 'month_closed'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export interface OkResponse {
  ok: true;
}

export interface SessionResponse {
  /** Los usuarios configurados en USERS, en ese orden. El primero es el que se abre por defecto. */
  users: AppUser[];
  /** true si el servidor expone /api/dev/* (muestra "Start blank" y "Restore sample data"). */
  devTools: boolean;
}

export interface StateResponse {
  /** El usuario de la cabecera X-User, ya resuelto. */
  user: AppUser;
  state: AppState;
}

/** Solo cambia lo que venga. */
export interface SettingsUpdate {
  /** null = volver a la paleta original. */
  theme?: ThemeColors | null;
  language?: Language;
  /** Deben quedar distintas; para intercambiarlas se mandan las dos en la misma petición. */
  mainCurrency?: Currency;
  secondCurrency?: Currency;
  /** Una cuenta existente del usuario, o null para la automática. */
  defaultAccountId?: string | null;
}

export interface SettingsResponse {
  theme: ThemeColors | null;
  language: Language;
  mainCurrency: Currency;
  secondCurrency: Currency;
  defaultAccountId: string | null;
}

export interface AccountCreate {
  id?: string;
  name: string;
  currency: Currency;
  /** Saldo inicial en la moneda de la cuenta; por defecto 0. */
  opening?: number;
}
export type AccountPatch = Partial<Pick<Account, 'name' | 'currency' | 'opening' | 'hidden' | 'sort'>>;

export interface MonthSummary {
  key: MonthKey;
  closed: boolean;
  closedAt: string | null;
  /** Moneda principal del usuario: en ella van `budget` y `used`. */
  main: Currency;
  budget: number;
  used: number;
  txCount: number;
}

export interface MonthPatch {
  /**
   * Partes del presupuesto que cambian: accountId → monto en la moneda de esa cuenta. Las cuentas que no vengan
   * conservan su parte; 0 la quita.
   */
  budgets?: Record<string, number>;
}

export interface CloseResponse {
  closed: Month;
  /**
   * El mes siguiente (recién creado, o el existente si ya estaba). Al crearlo copia los gastos fijos sin marcar
   * como pagados (con su cuenta) y las partes del presupuesto; las tasas no se copian (las resuelve rateFor).
   */
  next: Month;
}

export interface FixedCreate {
  id?: string;
  monthKey: MonthKey;
  name: string;
  day?: string;
  amount: number;
  cur: Currency;
  paid?: boolean;
  accountId?: string;
}
export type FixedPatch = Partial<Pick<FixedExpense, 'name' | 'day' | 'amount' | 'cur' | 'paid' | 'accountId' | 'sort'>>;

export interface TxCreate {
  id?: string;
  monthKey: MonthKey;
  date: ISODate;
  desc: string;
  place?: string;
  cat: string;
  method: string;
  amount: number;
  cur: Currency;
  accountId?: string;
  notes?: string;
}
export type TxPatch = Partial<
  Pick<Transaction, 'date' | 'desc' | 'place' | 'cat' | 'method' | 'amount' | 'cur' | 'accountId' | 'notes'>
>;

export interface TransferCreate {
  id?: string;
  monthKey: MonthKey;
  date: ISODate;
  via: string;
  fromAccountId: string;
  toAccountId: string;
  /** Lo que sale, en la moneda de la cuenta de origen. */
  amount: number;
  /** 1 moneda de origen = rate moneda de destino. Si falta: la tasa del mes para ese par. */
  rate?: number;
}
export type TransferPatch = Partial<Pick<Transfer, 'date' | 'via' | 'fromAccountId' | 'toAccountId' | 'amount' | 'rate'>>;

export interface IncomeCreate {
  id?: string;
  date: ISODate;
  desc?: string;
  accountId?: string;
  amount: number;
  cur: Currency;
}
export type IncomePatch = Partial<Pick<Income, 'date' | 'desc' | 'accountId' | 'amount' | 'cur'>>;

export interface GoalCreate {
  id?: string;
  name: string;
  /** Por defecto, la moneda principal del usuario. */
  cur?: Currency;
  monthly?: number | null;
  start?: MonthKey | null;
  end?: MonthKey | null;
}
export type GoalPatch = Partial<Pick<Goal, 'name' | 'cur' | 'monthly' | 'start' | 'end' | 'sort'>>;

export interface ContributionCreate {
  id?: string;
  goalId: string;
  date: ISODate;
  amount: number;
  cur: Currency;
}
export type ContributionPatch = Partial<Pick<Contribution, 'goalId' | 'date' | 'amount' | 'cur'>>;

/**
 * Lo que Claude manda al registrar un gasto. Solo `description` y `amount` son obligatorios
 * (y `user` cuando hay más de un usuario configurado).
 */
export interface IngestTransaction {
  /** Id del usuario dueño del gasto. Obligatorio si USERS tiene más de uno; si solo hay uno, es ese. */
  user?: string;
  /** Por defecto, hoy en America/Santo_Domingo. */
  date?: ISODate;
  description: string;
  place?: string;
  /** Por defecto 'Food'. */
  category?: string;
  /** Por defecto 'Card'. */
  method?: string;
  amount: number;
  /** Por defecto, la moneda de la cuenta de la que sale. */
  currency?: Currency;
  /**
   * Cuenta de la que sale: su id o su nombre (sin distinguir mayúsculas ni acentos; vale un comienzo único).
   * Por defecto, la cuenta por defecto del usuario.
   */
  account?: string;
  notes?: string;
}

export interface IngestResponse {
  transaction: Transaction;
  /** true si hubo que crear el mes de la fecha. */
  monthCreated: boolean;
}

// ── Excel (formato del diseño original: dos monedas, dos cuentas) ─────────────────────────────────────────

/** Un mes tal como viene en el libro. `cur` solo trae 'DOP' o 'USD'. */
export interface ImportMonth {
  key: MonthKey;
  closed: boolean;
  /** Presupuesto planeado, en DOP. */
  budget: number;
  incomeUSD: number;
  /** Saldos de las dos cuentas del libro: USD y DOP. */
  accounts: { usd: number; dop: number };
  fixed: { name: string; day: string; amount: number; cur: Currency; paid: boolean }[];
  /** Envíos USD → DOP. */
  transfers: { date: ISODate; via: string; usd: number; rate: number }[];
  tx: {
    date: ISODate;
    desc: string;
    place: string;
    cat: string;
    method: string;
    amount: number;
    cur: Currency;
    notes: string;
  }[];
}

/** Resultado de leer un .xlsx con el formato de la app (shared/excel/import.ts). */
export interface ImportPayload {
  /** Ordenados por clave. Todos cerrados salvo el último. */
  months: ImportMonth[];
  /** null si el libro no trae hoja de ahorros (no se tocan los aportes existentes). */
  contribs: { date: ISODate; goalName: string; amount: number; cur: Currency }[] | null;
  /**
   * Las metas que aparecen en la hoja de ahorros, en su orden; null si el libro no trae esa hoja.
   * Al aplicar: se crean las que falten y se actualiza el plan de las que ya existan (por nombre exacto y,
   * si no, sin distinguir mayúsculas); las metas del usuario que no vengan en el archivo se conservan.
   * Un libro de la versión 1 (en español, con sus tres metas fijas) llega con ellas ya renombradas a las de
   * hoy: 'Fondo de emergencia' → 'Emergency fund', 'Ahorro personal' → 'Personal savings' y 'Viaje a Turquía'
   * → 'Trip to Turkey'; si el usuario conserva alguna con el nombre de entonces, se usa esa.
   */
  goals: ImportGoal[] | null;
}

/** Una meta tal como viene en el libro: siempre en USD. */
export interface ImportGoal {
  name: string;
  /** Plan de la meta (los tres juntos) o los tres null si es de aportes variables. */
  monthlyUSD: number | null;
  start: MonthKey | null;
  end: MonthKey | null;
}

export interface ImportResponse {
  months: MonthKey[];
  contributions: number;
}
