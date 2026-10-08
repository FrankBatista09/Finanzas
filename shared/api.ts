// Contrato HTTP entre el frontend (src/api) y la API (server/app.ts). Ambos lados importan estos tipos.
//
// Autenticación
//   · /api/*           → Cloudflare Access delante del sitio (opcionalmente se valida su JWT, ver server/auth.ts).
//   · /api/ingest/*    → Authorization: Bearer <API_TOKEN>  (lo usa Claude; debe quedar fuera de Access)
//   · /mcp             → Authorization: Bearer <API_TOKEN>
//
// Errores: cualquier respuesta no-2xx tiene cuerpo ApiErrorBody.
//
// Rutas (todas JSON salvo export.xlsx):
//   GET    /api/state                         → StateResponse     (crea el mes actual si la base está vacía)
//   GET    /api/months                        → MonthSummary[]
//   GET    /api/months/:key                   → Month
//   PATCH  /api/months/:key      MonthPatch   → Month
//   POST   /api/months/:key/close             → CloseResponse     (cierra y crea el siguiente, en un batch de D1)
//   POST   /api/months/:key/reopen            → Month
//   POST   /api/fixed            FixedCreate  → FixedExpense      (201)
//   PATCH  /api/fixed/:id        FixedPatch   → FixedExpense
//   DELETE /api/fixed/:id                     → OkResponse
//   POST   /api/transactions     TxCreate     → Transaction       (201)
//   PATCH  /api/transactions/:id TxPatch      → Transaction
//   DELETE /api/transactions/:id              → OkResponse
//   POST   /api/transfers        TransferCreate → Transfer        (201)
//   PATCH  /api/transfers/:id    TransferPatch  → Transfer
//   DELETE /api/transfers/:id                 → OkResponse
//   GET    /api/goals                         → Goal[]
//   POST   /api/goals            GoalCreate   → Goal              (201)
//   PATCH  /api/goals/:id        GoalPatch    → Goal
//   DELETE /api/goals/:id                     → OkResponse        (409 si tiene aportes)
//   GET    /api/contributions                 → Contribution[]
//   POST   /api/contributions    ContributionCreate → Contribution (201)
//   PATCH  /api/contributions/:id ContributionPatch → Contribution
//   DELETE /api/contributions/:id             → OkResponse
//   GET    /api/export.xlsx                   → binario .xlsx (Content-Disposition: attachment)
//   POST   /api/import           ImportPayload (JSON) o el .xlsx crudo → ImportResponse
//   POST   /api/ingest/transaction IngestTransaction → IngestResponse (201)   [Bearer]
//   POST   /api/dev/seed                      → OkResponse   (solo si ALLOW_DEV_RESET=1) carga los datos de ejemplo
//   POST   /api/dev/reset                     → OkResponse   (solo si ALLOW_DEV_RESET=1) deja la base en blanco
//
// Reglas de escritura
//   · Un mes cerrado es de solo lectura: crear/editar/borrar fijos, transacciones o envíos en él → 409 month_closed.
//     Excepciones: PATCH /api/months/:key con incomeUSD (la tabla "Ingresos por mes" lo edita en cualquier mes)
//     y POST /api/months/:key/reopen.
//   · El cliente puede mandar `id` al crear (actualizaciones optimistas sin reconciliar ids). Si falta, lo genera el servidor.
//   · Los montos son números finitos. amount > 0 al crear; usd > 0 y rate > 0 en envíos.

import type { AppState, Contribution, Currency, FixedExpense, Goal, ISODate, Month, MonthKey, Transaction, Transfer } from './types';

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

export interface StateResponse {
  state: AppState;
  /** true si el servidor expone /api/dev/* (muestra "Empezar en blanco" y "Restablecer datos de ejemplo"). */
  devTools: boolean;
}

export interface MonthSummary {
  key: MonthKey;
  closed: boolean;
  closedAt: string | null;
  budget: number;
  incomeUSD: number;
  /** Tasa del mes ya resuelta (con el respaldo del mes anterior / por defecto). */
  rate: number;
  /** DOP */
  used: number;
  txCount: number;
}

export interface MonthPatch {
  budget?: number;
  incomeUSD?: number;
  accUSD?: number;
  accDOP?: number;
}

export interface CloseResponse {
  closed: Month;
  /** El mes siguiente (recién creado, o el existente si ya estaba). */
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
}
export type FixedPatch = Partial<Pick<FixedExpense, 'name' | 'day' | 'amount' | 'cur' | 'paid' | 'sort'>>;

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
  notes?: string;
}
export type TxPatch = Partial<Pick<Transaction, 'date' | 'desc' | 'place' | 'cat' | 'method' | 'amount' | 'cur' | 'notes'>>;

export interface TransferCreate {
  id?: string;
  monthKey: MonthKey;
  date: ISODate;
  via: string;
  usd: number;
  rate: number;
}
export type TransferPatch = Partial<Pick<Transfer, 'date' | 'via' | 'usd' | 'rate'>>;

export interface GoalCreate {
  id?: string;
  name: string;
  monthlyUSD?: number | null;
  start?: MonthKey | null;
  end?: MonthKey | null;
}
export type GoalPatch = Partial<Pick<Goal, 'name' | 'monthlyUSD' | 'start' | 'end' | 'sort'>>;

export interface ContributionCreate {
  id?: string;
  goalId: string;
  date: ISODate;
  amount: number;
  cur: Currency;
}
export type ContributionPatch = Partial<Pick<Contribution, 'goalId' | 'date' | 'amount' | 'cur'>>;

/** Lo que Claude manda al registrar un gasto. Solo `description` y `amount` son obligatorios. */
export interface IngestTransaction {
  /** Por defecto, hoy en America/Santo_Domingo. */
  date?: ISODate;
  description: string;
  place?: string;
  /** Por defecto 'Comida'. */
  category?: string;
  /** Por defecto 'Tarjeta'. */
  method?: string;
  amount: number;
  /** Por defecto 'DOP'. */
  currency?: Currency;
  notes?: string;
}

export interface IngestResponse {
  transaction: Transaction;
  /** true si hubo que crear el mes de la fecha. */
  monthCreated: boolean;
}

// ── Excel ────────────────────────────────────────────────────────────────────

export interface ImportMonth {
  key: MonthKey;
  closed: boolean;
  budget: number;
  incomeUSD: number;
  accounts: { usd: number; dop: number };
  fixed: Pick<FixedExpense, 'name' | 'day' | 'amount' | 'cur' | 'paid'>[];
  transfers: Pick<Transfer, 'date' | 'via' | 'usd' | 'rate'>[];
  tx: Pick<Transaction, 'date' | 'desc' | 'place' | 'cat' | 'method' | 'amount' | 'cur' | 'notes'>[];
}

/** Resultado de leer un .xlsx con el formato de la app (shared/excel/import.ts). */
export interface ImportPayload {
  /** Ordenados por clave. Todos cerrados salvo el último. */
  months: ImportMonth[];
  /** null si el libro no trae hoja "Ahorros" (no se tocan los aportes existentes). */
  contribs: { date: ISODate; goalName: string; amount: number; cur: Currency }[] | null;
  /** Parámetros de la meta con aporte fijo leídos de la hoja Ahorros; null si no están. */
  turkey: { monthlyUSD: number | null; start: MonthKey | null; end: MonthKey | null } | null;
}

export interface ImportResponse {
  months: MonthKey[];
  contributions: number;
}
