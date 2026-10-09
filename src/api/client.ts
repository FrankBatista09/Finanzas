// Cliente HTTP tipado: una función por ruta de shared/api.ts. No guarda estado ni reintenta;
// de eso se ocupa la capa de datos (src/store).
//
// Los datos son de un usuario, así que casi todas las rutas se piden a través de `api.forUser(id)`: lo que devuelve
// manda la cabecera X-User con ese id en cada llamada, sin excepción. Quien guarda una referencia a ese objeto
// (la capa de datos de cada usuario) no puede acabar escribiendo en los datos de otro.

import type {
  AccountCreate,
  AccountPatch,
  ApiErrorBody,
  ApiErrorCode,
  BudgetEntryCreate,
  CloseRequest,
  CloseResponse,
  ContributionCreate,
  ContributionPatch,
  CardOtherUpdate,
  CardPayRequest,
  FixedCreate,
  FixedPatch,
  GoalCreate,
  GoalPatch,
  ImportPayload,
  ImportResponse,
  IncomeCreate,
  IncomePatch,
  IngestResponse,
  IngestTransaction,
  MonthPatch,
  MonthSummary,
  MoveOutsideRequest,
  MoveToBudgetRequest,
  OkResponse,
  OutsideCreate,
  OutsidePatch,
  SessionResponse,
  SettingsResponse,
  SettingsUpdate,
  StateResponse,
  TransferCreate,
  TransferPatch,
  TxCreate,
  TxPatch,
} from '../../shared/api';
import type {
  Account,
  Contribution,
  Currency,
  FixedExpense,
  Goal,
  Income,
  ISODate,
  Month,
  MonthKey,
  MonthRate,
  OutsideExpense,
  Transaction,
  Transfer,
} from '../../shared/types';
import { USER_HEADER } from '../../shared/users';

/**
 * La API respondió con un estado no-2xx (o con un cuerpo que no se pudo leer). `message` es el texto del servidor,
 * siempre en inglés: al usuario se le enseña la frase de su idioma para `code` (src/store/util.ts describeError).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** No hubo respuesta HTTP: sin red, servidor caído, o la sesión de Access expiró y el navegador bloqueó la redirección. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server.', { cause });
    this.name = 'NetworkError';
  }
}

/** true si la petición se canceló con un AbortSignal (no es un fallo: nadie espera ya la respuesta). */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Deja que la petición termine aunque la página se esté cerrando (guardado en pagehide). */
  keepalive?: boolean;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const ERROR_CODES: readonly ApiErrorCode[] = ['validation', 'not_found', 'month_closed', 'conflict', 'unauthorized', 'forbidden', 'internal'];

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const err = (v as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return typeof message === 'string' && (ERROR_CODES as readonly unknown[]).includes(code);
}

/** Código de respaldo cuando el cuerpo del error no es el de la API (p. ej. una página de error del proxy). */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 400 && status < 500) return 'validation';
  return 'internal';
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (isErrorBody(body)) return new ApiError(res.status, body.error.code, body.error.message);
  return new ApiError(res.status, codeForStatus(res.status), `The server answered with an error (HTTP ${res.status}).`);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Call {
  /** Se serializa como JSON. */
  json?: unknown;
  /** Cuerpo crudo (el .xlsx de la importación). */
  body?: Blob;
  headers?: Record<string, string>;
  opts?: RequestOptions;
}

const seg = (v: string) => encodeURIComponent(v);

export function createApiClient(fetchImpl: FetchLike = (input, init) => fetch(input, init), base = '') {
  async function send(method: string, path: string, call: Call = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...call.headers };
    const init: RequestInit = { method, headers };
    if (call.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(call.json);
    } else if (call.body !== undefined) {
      init.body = call.body;
    }
    if (call.opts?.signal) init.signal = call.opts.signal;
    if (call.opts?.keepalive) init.keepalive = true;

    let res: Response;
    try {
      res = await fetchImpl(base + path, init);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new NetworkError(e);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async function request<T>(method: string, path: string, call?: Call): Promise<T> {
    const res = await send(method, path, call);
    try {
      return (await res.json()) as T;
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new ApiError(res.status, 'internal', 'The server sent a response that could not be read.');
    }
  }

  /** Las rutas de datos, todas con la cabecera X-User de ese usuario. */
  function forUser(userId: string) {
    const asUser = (call: Call = {}): Call => ({ ...call, headers: { ...call.headers, [USER_HEADER]: userId } });
    const json = <T>(method: string, path: string, call?: Call) => request<T>(method, path, asUser(call));

    return {
      /** El usuario al que pertenece todo lo que pide este objeto. */
      userId,

      // ── Estado y ajustes ──────────────────────────────────────────────────
      getState: (opts?: RequestOptions) => json<StateResponse>('GET', '/api/state', { opts }),
      patchSettings: (update: SettingsUpdate, opts?: RequestOptions) =>
        json<SettingsResponse>('PATCH', '/api/settings', { json: update, opts }),

      // ── Cuentas ───────────────────────────────────────────────────────────
      listAccounts: (opts?: RequestOptions) => json<Account[]>('GET', '/api/accounts', { opts }),
      createAccount: (body: AccountCreate, opts?: RequestOptions) => json<Account>('POST', '/api/accounts', { json: body, opts }),
      patchAccount: (id: string, patch: AccountPatch, opts?: RequestOptions) =>
        json<Account>('PATCH', `/api/accounts/${seg(id)}`, { json: patch, opts }),
      deleteAccount: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/accounts/${seg(id)}`, { opts }),

      // ── Meses ─────────────────────────────────────────────────────────────
      listMonths: (opts?: RequestOptions) => json<MonthSummary[]>('GET', '/api/months', { opts }),
      getMonth: (key: MonthKey, opts?: RequestOptions) => json<Month>('GET', `/api/months/${seg(key)}`, { opts }),
      /** Fija la parte del presupuesto de cada cuenta que venga: el servidor añade al registro la diferencia. */
      patchMonth: (key: MonthKey, patch: MonthPatch, opts?: RequestOptions) =>
        json<Month>('PATCH', `/api/months/${seg(key)}`, { json: patch, opts }),
      /** Añade un movimiento al registro del presupuesto del mes. */
      addBudgetEntry: (key: MonthKey, body: BudgetEntryCreate, opts?: RequestOptions) =>
        json<Month>('POST', `/api/months/${seg(key)}/budget-log`, { json: body, opts }),
      deleteBudgetEntry: (key: MonthKey, id: string, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/budget-log/${seg(id)}`, { opts }),
      /** Suma a ese mes lo que sobró del anterior (409 si ya lo tiene). */
      addLeftover: (key: MonthKey, opts?: RequestOptions) => json<Month>('POST', `/api/months/${seg(key)}/leftover`, { opts }),
      /** Los «otros cargos» de la tarjeta de crédito del mes. */
      setCardOther: (key: MonthKey, body: CardOtherUpdate, opts?: RequestOptions) =>
        json<Month>('PATCH', `/api/months/${seg(key)}/card`, { json: body, opts }),
      /** Paga la tarjeta del mes (el importe no puede pasar de su total; 400 si pasa). */
      payCard: (key: MonthKey, body: CardPayRequest, opts?: RequestOptions) =>
        json<Month>('POST', `/api/months/${seg(key)}/card/pay`, { json: body, opts }),
      unpayCard: (key: MonthKey, opts?: RequestOptions) => json<Month>('DELETE', `/api/months/${seg(key)}/card/pay`, { opts }),
      /** Escribe la tasa de un par desde una fecha del mes (una por par y fecha: sustituye a la de esa fecha, en el sentido que fuera). */
      putMonthRate: (key: MonthKey, rate: MonthRate, opts?: RequestOptions) =>
        json<Month>('PUT', `/api/months/${seg(key)}/rates`, { json: rate, opts }),
      /** Quita la tasa de ese par y esa fecha. La fecha no es un dato personal: va en la consulta porque así la pide la ruta. */
      deleteMonthRate: (key: MonthKey, from: Currency, to: Currency, date: ISODate, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/rates/${seg(from)}/${seg(to)}?date=${seg(date)}`, { opts }),
      /** Sin `request` no se manda cuerpo: el mes siguiente arranca con las partes del que se cierra. */
      closeMonth: (key: MonthKey, request?: CloseRequest, opts?: RequestOptions) =>
        json<CloseResponse>('POST', `/api/months/${seg(key)}/close`, { json: request, opts }),
      reopenMonth: (key: MonthKey, opts?: RequestOptions) => json<Month>('POST', `/api/months/${seg(key)}/reopen`, { opts }),
      /** Borra el mes con todo lo suyo (gastos, transacciones, envíos, presupuesto y tasas), esté abierto o cerrado. */
      deleteMonth: (key: MonthKey, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/months/${seg(key)}`, { opts }),

      // ── Gastos fijos ──────────────────────────────────────────────────────
      createFixed: (body: FixedCreate, opts?: RequestOptions) => json<FixedExpense>('POST', '/api/fixed', { json: body, opts }),
      patchFixed: (id: string, patch: FixedPatch, opts?: RequestOptions) =>
        json<FixedExpense>('PATCH', `/api/fixed/${seg(id)}`, { json: patch, opts }),
      deleteFixed: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/fixed/${seg(id)}`, { opts }),

      // ── Transacciones ─────────────────────────────────────────────────────
      createTransaction: (body: TxCreate, opts?: RequestOptions) => json<Transaction>('POST', '/api/transactions', { json: body, opts }),
      patchTransaction: (id: string, patch: TxPatch, opts?: RequestOptions) =>
        json<Transaction>('PATCH', `/api/transactions/${seg(id)}`, { json: patch, opts }),
      deleteTransaction: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/transactions/${seg(id)}`, { opts }),
      moveTransactionOutside: (id: string, body: MoveOutsideRequest, opts?: RequestOptions) =>
        json<OutsideExpense>('POST', `/api/transactions/${seg(id)}/move-outside`, { json: body, opts }),

      // ── Fuera de presupuesto ──────────────────────────────────────────────
      createOutside: (body: OutsideCreate, opts?: RequestOptions) => json<OutsideExpense>('POST', '/api/outside-expenses', { json: body, opts }),
      patchOutside: (id: string, patch: OutsidePatch, opts?: RequestOptions) =>
        json<OutsideExpense>('PATCH', `/api/outside-expenses/${seg(id)}`, { json: patch, opts }),
      deleteOutside: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/outside-expenses/${seg(id)}`, { opts }),
      moveOutsideToBudget: (id: string, body: MoveToBudgetRequest, opts?: RequestOptions) =>
        json<Transaction>('POST', `/api/outside-expenses/${seg(id)}/move-to-budget`, { json: body, opts }),

      // ── Envíos ────────────────────────────────────────────────────────────
      createTransfer: (body: TransferCreate, opts?: RequestOptions) => json<Transfer>('POST', '/api/transfers', { json: body, opts }),
      patchTransfer: (id: string, patch: TransferPatch, opts?: RequestOptions) =>
        json<Transfer>('PATCH', `/api/transfers/${seg(id)}`, { json: patch, opts }),
      deleteTransfer: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/transfers/${seg(id)}`, { opts }),

      // ── Ingresos ──────────────────────────────────────────────────────────
      listIncomes: (opts?: RequestOptions) => json<Income[]>('GET', '/api/incomes', { opts }),
      createIncome: (body: IncomeCreate, opts?: RequestOptions) => json<Income>('POST', '/api/incomes', { json: body, opts }),
      patchIncome: (id: string, patch: IncomePatch, opts?: RequestOptions) =>
        json<Income>('PATCH', `/api/incomes/${seg(id)}`, { json: patch, opts }),
      deleteIncome: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/incomes/${seg(id)}`, { opts }),

      // ── Metas ─────────────────────────────────────────────────────────────
      listGoals: (opts?: RequestOptions) => json<Goal[]>('GET', '/api/goals', { opts }),
      createGoal: (body: GoalCreate, opts?: RequestOptions) => json<Goal>('POST', '/api/goals', { json: body, opts }),
      patchGoal: (id: string, patch: GoalPatch, opts?: RequestOptions) => json<Goal>('PATCH', `/api/goals/${seg(id)}`, { json: patch, opts }),
      deleteGoal: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/goals/${seg(id)}`, { opts }),

      // ── Aportes ───────────────────────────────────────────────────────────
      listContributions: (opts?: RequestOptions) => json<Contribution[]>('GET', '/api/contributions', { opts }),
      createContribution: (body: ContributionCreate, opts?: RequestOptions) =>
        json<Contribution>('POST', '/api/contributions', { json: body, opts }),
      patchContribution: (id: string, patch: ContributionPatch, opts?: RequestOptions) =>
        json<Contribution>('PATCH', `/api/contributions/${seg(id)}`, { json: patch, opts }),
      deleteContribution: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/contributions/${seg(id)}`, { opts }),

      // ── Excel ─────────────────────────────────────────────────────────────
      /** Devuelve el libro como Blob; el nombre de archivo lo pone quien lo descarga. */
      exportExcel: async (opts?: RequestOptions): Promise<Blob> => {
        const res = await send('GET', '/api/export.xlsx', asUser({ headers: { Accept: XLSX_MIME }, opts }));
        return res.blob();
      },
      /** Manda el .xlsx tal cual, con su tipo de contenido; el servidor lo lee y hace upsert. */
      importExcel: (file: Blob, opts?: RequestOptions) =>
        json<ImportResponse>('POST', '/api/import', { body: file, headers: { 'Content-Type': file.type || XLSX_MIME }, opts }),
      /** Variante JSON de la importación (un libro ya leído con shared/excel/import.ts). */
      importPayload: (payload: ImportPayload, opts?: RequestOptions) => json<ImportResponse>('POST', '/api/import', { json: payload, opts }),

      // ── Desarrollo (solo si SessionResponse.devTools) ─────────────────────
      devSeed: (opts?: RequestOptions) => json<OkResponse>('POST', '/api/dev/seed', { opts }),
      devReset: (opts?: RequestOptions) => json<OkResponse>('POST', '/api/dev/reset', { opts }),
    };
  }

  return {
    /** Usuarios configurados y si hay utilidades de desarrollo. La única ruta de la web que no lleva X-User. */
    getSession: (opts?: RequestOptions) => request<SessionResponse>('GET', '/api/session', { opts }),

    forUser,

    // ── Ingesta (la usa Claude; requiere el Bearer, que la web no tiene, y el usuario va en el cuerpo) ─────
    ingestTransaction: (body: IngestTransaction, token: string, opts?: RequestOptions) =>
      request<IngestResponse>('POST', '/api/ingest/transaction', { json: body, headers: { Authorization: `Bearer ${token}` }, opts }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Las rutas de datos de un usuario (api.forUser(id)). */
export type UserApi = ReturnType<ApiClient['forUser']>;

/** Cliente de la app: mismas rutas relativas en desarrollo (proxy de Vite) y en producción (Pages Functions). */
export const api: ApiClient = createApiClient();
