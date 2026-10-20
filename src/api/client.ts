// Typed HTTP client: one function per route in shared/api.ts. It keeps no state and does not retry;
// the data layer (src/store) takes care of that.
//
// The data belongs to a user, so almost every route is requested through `api.forUser(id)`: what it returns
// sends the X-User header with that id on every call, without exception. Whoever keeps a reference to that object
// (each user's data layer) cannot end up writing to another user's data.

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
  CardCashbackUpdate,
  CardOtherUpdate,
  CardPayRequest,
  CardIncludeRequest,
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
  CreditCard,
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
 * The API answered with a non-2xx status (or with a body that could not be read). `message` is the server's text,
 * always in English: the user is shown the phrase for `code` in their language (src/store/util.ts describeError).
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

/** There was no HTTP response: no network, server down, or the Access session expired and the browser blocked the redirect. */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server.', { cause });
    this.name = 'NetworkError';
  }
}

/** true if the request was canceled with an AbortSignal (not a failure: nobody is waiting for the response anymore). */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Lets the request finish even if the page is closing (save on pagehide). */
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

/** Fallback code when the error body is not the API's (e.g. a proxy error page). */
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
  /** Serialized as JSON. */
  json?: unknown;
  /** Raw body (the .xlsx of the import). */
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

  /** The data routes, all with that user's X-User header. */
  function forUser(userId: string) {
    const asUser = (call: Call = {}): Call => ({ ...call, headers: { ...call.headers, [USER_HEADER]: userId } });
    const json = <T>(method: string, path: string, call?: Call) => request<T>(method, path, asUser(call));

    return {
      /** The user who owns everything this object requests. */
      userId,

      // ── State and settings ────────────────────────────────────────────────
      getState: (opts?: RequestOptions) => json<StateResponse>('GET', '/api/state', { opts }),
      patchSettings: (update: SettingsUpdate, opts?: RequestOptions) =>
        json<SettingsResponse>('PATCH', '/api/settings', { json: update, opts }),

      // ── Accounts ──────────────────────────────────────────────────────────
      listAccounts: (opts?: RequestOptions) => json<Account[]>('GET', '/api/accounts', { opts }),
      createAccount: (body: AccountCreate, opts?: RequestOptions) => json<Account>('POST', '/api/accounts', { json: body, opts }),
      patchAccount: (id: string, patch: AccountPatch, opts?: RequestOptions) =>
        json<Account>('PATCH', `/api/accounts/${seg(id)}`, { json: patch, opts }),
      deleteAccount: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/accounts/${seg(id)}`, { opts }),

      // ── Credit cards ──────────────────────────────────────────────────────
      listCreditCards: (opts?: RequestOptions) => json<CreditCard[]>('GET', '/api/credit-cards', { opts }),
      createCreditCard: (body: CreditCardCreate, opts?: RequestOptions) => json<CreditCard>('POST', '/api/credit-cards', { json: body, opts }),
      patchCreditCard: (id: string, patch: CreditCardPatch, opts?: RequestOptions) =>
        json<CreditCard>('PATCH', `/api/credit-cards/${seg(id)}`, { json: patch, opts }),
      deleteCreditCard: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/credit-cards/${seg(id)}`, { opts }),

      // ── Months ────────────────────────────────────────────────────────────
      listMonths: (opts?: RequestOptions) => json<MonthSummary[]>('GET', '/api/months', { opts }),
      getMonth: (key: MonthKey, opts?: RequestOptions) => json<Month>('GET', `/api/months/${seg(key)}`, { opts }),
      /** Sets the budget part of each account that comes in: the server adds the difference to the log. */
      patchMonth: (key: MonthKey, patch: MonthPatch, opts?: RequestOptions) =>
        json<Month>('PATCH', `/api/months/${seg(key)}`, { json: patch, opts }),
      /** Adds a movement to the month's budget log. */
      addBudgetEntry: (key: MonthKey, body: BudgetEntryCreate, opts?: RequestOptions) =>
        json<Month>('POST', `/api/months/${seg(key)}/budget-log`, { json: body, opts }),
      deleteBudgetEntry: (key: MonthKey, id: string, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/budget-log/${seg(id)}`, { opts }),
      /** Adds to that month what was left over from the previous one (409 if it already has it). */
      addLeftover: (key: MonthKey, opts?: RequestOptions) => json<Month>('POST', `/api/months/${seg(key)}/leftover`, { opts }),
      /** A credit card's "Other charges" in the month. */
      setCardOther: (key: MonthKey, cardId: string, body: CardOtherUpdate, opts?: RequestOptions) =>
        json<Month>('PATCH', `/api/months/${seg(key)}/cards/${seg(cardId)}/other`, { json: body, opts }),
      /** The cashback a credit card generated in the month (400 if the card has no cashback). */
      setCardCashback: (key: MonthKey, cardId: string, body: CardCashbackUpdate, opts?: RequestOptions) =>
        json<Month>('PATCH', `/api/months/${seg(key)}/cards/${seg(cardId)}/cashback`, { json: body, opts }),
      /** Adds a credit card payment in the month (the amount cannot exceed what is left; 400 if it does). */
      payCard: (key: MonthKey, cardId: string, body: CardPayRequest, opts?: RequestOptions) =>
        json<Month>('POST', `/api/months/${seg(key)}/cards/${seg(cardId)}/pay`, { json: body, opts }),
      /** Adds the listed unpaid Credit-card purchases of a card to the month's card total, as fixed expenses or just marked. */
      includeCardPurchases: (key: MonthKey, cardId: string, body: CardIncludeRequest, opts?: RequestOptions) =>
        json<Month>('POST', `/api/months/${seg(key)}/cards/${seg(cardId)}/include-purchases`, { json: body, opts }),
      unpayCard: (key: MonthKey, cardId: string, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/cards/${seg(cardId)}/pay`, { opts }),
      removeCardPayment: (key: MonthKey, cardId: string, paymentId: string, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/cards/${seg(cardId)}/pay/${seg(paymentId)}`, { opts }),
      /** Writes a pair's rate from a date in the month (one per pair and date: it replaces that date's rate, whichever direction it was in). */
      putMonthRate: (key: MonthKey, rate: MonthRate, opts?: RequestOptions) =>
        json<Month>('PUT', `/api/months/${seg(key)}/rates`, { json: rate, opts }),
      /** Removes the rate for that pair and date. The date is not personal data: it goes in the query because the route asks for it that way. */
      deleteMonthRate: (key: MonthKey, from: Currency, to: Currency, date: ISODate, opts?: RequestOptions) =>
        json<Month>('DELETE', `/api/months/${seg(key)}/rates/${seg(from)}/${seg(to)}?date=${seg(date)}`, { opts }),
      /** Without `request` no body is sent: the next month starts with the parts of the one being closed. */
      closeMonth: (key: MonthKey, request?: CloseRequest, opts?: RequestOptions) =>
        json<CloseResponse>('POST', `/api/months/${seg(key)}/close`, { json: request, opts }),
      reopenMonth: (key: MonthKey, opts?: RequestOptions) => json<Month>('POST', `/api/months/${seg(key)}/reopen`, { opts }),
      /** Deletes the month with everything in it (expenses, transactions, transfers, budget and rates), open or closed. */
      deleteMonth: (key: MonthKey, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/months/${seg(key)}`, { opts }),

      // ── Fixed expenses ────────────────────────────────────────────────────
      createFixed: (body: FixedCreate, opts?: RequestOptions) => json<FixedExpense>('POST', '/api/fixed', { json: body, opts }),
      patchFixed: (id: string, patch: FixedPatch, opts?: RequestOptions) =>
        json<FixedExpense>('PATCH', `/api/fixed/${seg(id)}`, { json: patch, opts }),
      deleteFixed: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/fixed/${seg(id)}`, { opts }),

      // ── Transactions ──────────────────────────────────────────────────────
      createTransaction: (body: TxCreate, opts?: RequestOptions) => json<Transaction>('POST', '/api/transactions', { json: body, opts }),
      patchTransaction: (id: string, patch: TxPatch, opts?: RequestOptions) =>
        json<Transaction>('PATCH', `/api/transactions/${seg(id)}`, { json: patch, opts }),
      deleteTransaction: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/transactions/${seg(id)}`, { opts }),
      moveTransactionOutside: (id: string, body: MoveOutsideRequest, opts?: RequestOptions) =>
        json<OutsideExpense>('POST', `/api/transactions/${seg(id)}/move-outside`, { json: body, opts }),

      // ── Outside budget ────────────────────────────────────────────────────
      createOutside: (body: OutsideCreate, opts?: RequestOptions) => json<OutsideExpense>('POST', '/api/outside-expenses', { json: body, opts }),
      patchOutside: (id: string, patch: OutsidePatch, opts?: RequestOptions) =>
        json<OutsideExpense>('PATCH', `/api/outside-expenses/${seg(id)}`, { json: patch, opts }),
      deleteOutside: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/outside-expenses/${seg(id)}`, { opts }),
      moveOutsideToBudget: (id: string, body: MoveToBudgetRequest, opts?: RequestOptions) =>
        json<Transaction>('POST', `/api/outside-expenses/${seg(id)}/move-to-budget`, { json: body, opts }),

      // ── Transfers ─────────────────────────────────────────────────────────
      createTransfer: (body: TransferCreate, opts?: RequestOptions) => json<Transfer>('POST', '/api/transfers', { json: body, opts }),
      patchTransfer: (id: string, patch: TransferPatch, opts?: RequestOptions) =>
        json<Transfer>('PATCH', `/api/transfers/${seg(id)}`, { json: patch, opts }),
      deleteTransfer: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/transfers/${seg(id)}`, { opts }),

      // ── Income ────────────────────────────────────────────────────────────
      listIncomes: (opts?: RequestOptions) => json<Income[]>('GET', '/api/incomes', { opts }),
      createIncome: (body: IncomeCreate, opts?: RequestOptions) => json<Income>('POST', '/api/incomes', { json: body, opts }),
      patchIncome: (id: string, patch: IncomePatch, opts?: RequestOptions) =>
        json<Income>('PATCH', `/api/incomes/${seg(id)}`, { json: patch, opts }),
      deleteIncome: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/incomes/${seg(id)}`, { opts }),

      // ── Goals ─────────────────────────────────────────────────────────────
      listGoals: (opts?: RequestOptions) => json<Goal[]>('GET', '/api/goals', { opts }),
      createGoal: (body: GoalCreate, opts?: RequestOptions) => json<Goal>('POST', '/api/goals', { json: body, opts }),
      patchGoal: (id: string, patch: GoalPatch, opts?: RequestOptions) => json<Goal>('PATCH', `/api/goals/${seg(id)}`, { json: patch, opts }),
      deleteGoal: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/goals/${seg(id)}`, { opts }),

      // ── Contributions ─────────────────────────────────────────────────────
      listContributions: (opts?: RequestOptions) => json<Contribution[]>('GET', '/api/contributions', { opts }),
      createContribution: (body: ContributionCreate, opts?: RequestOptions) =>
        json<Contribution>('POST', '/api/contributions', { json: body, opts }),
      patchContribution: (id: string, patch: ContributionPatch, opts?: RequestOptions) =>
        json<Contribution>('PATCH', `/api/contributions/${seg(id)}`, { json: patch, opts }),
      deleteContribution: (id: string, opts?: RequestOptions) => json<OkResponse>('DELETE', `/api/contributions/${seg(id)}`, { opts }),

      // ── Excel ─────────────────────────────────────────────────────────────
      /** Returns the workbook as a Blob; the file name is set by whoever downloads it. */
      exportExcel: async (opts?: RequestOptions): Promise<Blob> => {
        const res = await send('GET', '/api/export.xlsx', asUser({ headers: { Accept: XLSX_MIME }, opts }));
        return res.blob();
      },
      /** Sends the .xlsx as is, with its content type; the server reads it and upserts. */
      importExcel: (file: Blob, opts?: RequestOptions) =>
        json<ImportResponse>('POST', '/api/import', { body: file, headers: { 'Content-Type': file.type || XLSX_MIME }, opts }),
      /** JSON variant of the import (a workbook already read with shared/excel/import.ts). */
      importPayload: (payload: ImportPayload, opts?: RequestOptions) => json<ImportResponse>('POST', '/api/import', { json: payload, opts }),

      // ── Development (only if SessionResponse.devTools) ────────────────────
      devSeed: (opts?: RequestOptions) => json<OkResponse>('POST', '/api/dev/seed', { opts }),
      devReset: (opts?: RequestOptions) => json<OkResponse>('POST', '/api/dev/reset', { opts }),
    };
  }

  return {
    /** Configured users and whether there are development tools. The only route of the web app that carries no X-User. */
    getSession: (opts?: RequestOptions) => request<SessionResponse>('GET', '/api/session', { opts }),

    forUser,

    // ── Ingest (used by Claude; requires the Bearer, which the web app does not have, and the user goes in the body) ─────
    ingestTransaction: (body: IngestTransaction, token: string, opts?: RequestOptions) =>
      request<IngestResponse>('POST', '/api/ingest/transaction', { json: body, headers: { Authorization: `Bearer ${token}` }, opts }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** A user's data routes (api.forUser(id)). */
export type UserApi = ReturnType<ApiClient['forUser']>;

/** The app's client: same relative routes in development (Vite proxy) and in production (Pages Functions). */
export const api: ApiClient = createApiClient();
