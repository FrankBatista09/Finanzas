// The HTTP API (Hono on Cloudflare Pages Functions). The contract is in shared/api.ts:
// routes, bodies, status codes and write rules come from there.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type {
  CloseResponse,
  ImportResponse,
  IngestResponse,
  IngestTransaction,
  MonthSummary,
  OkResponse,
  SessionResponse,
  SettingsResponse,
  StateResponse,
} from '../shared/api';
import { buildExportData } from '../shared/excel/data';
import { buildFinanzasXlsx, excelLocale, xlsxFilename, XLSX_MIME } from '../shared/excel/export';
import { ImportError, parseFinanzasXlsx } from '../shared/excel/import';
import { currentMonthKey, isMonthKey } from '../shared/month';
import { seedState } from '../shared/seed';
import type {
  Account,
  AppUser,
  Contribution,
  CreditCard,
  FixedExpense,
  Goal,
  Income,
  Month,
  MonthKey,
  OutsideExpense,
  Transaction,
  Transfer,
} from '../shared/types';
import { USER_HEADER } from '../shared/users';
import { accessAuth, requireBearer } from './auth';
import type { AuthEnv } from './auth';
import { readLimitedBody } from './body';
import * as db from './db';
import type { Env } from './env';
import {
  ApiError,
  errorBody,
  forbiddenError,
  monthNotFoundError,
  notFoundError,
  toApiError,
  tooLargeError,
  validationError,
} from './errors';
import { ingestTransaction } from './ingest';
import { configuredUsers, userFromHeader } from './users';
import * as v from './validate';

export type AppEnv = {
  Bindings: Env;
  Variables: AuthEnv['Variables'] & {
    /** The user from the X-User header, already resolved (requireUser). Not set on /api/session or /api/ingest/*. */
    user?: AppUser;
  };
};
type Ctx = Context<AppEnv>;

/** The app's JSON bodies are a few hundred bytes; the limit only stops abuse. */
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const OK: OkResponse = { ok: true };
const ROUTE_NOT_FOUND = 'Route not found.';
const BODY_TOO_LARGE = 'The request body is too large.';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The only routes without an X-User header: the user list for the select and what Claude records (the user goes in the body). */
const NO_USER_HEADER = /^\/api\/(?:session$|ingest(?:\/|$))/;

function devEnabled(env: Env): boolean {
  return env.ALLOW_DEV_RESET === '1';
}

// ── Request body ─────────────────────────────────────────────────────────────

/** Reads the body without going past `maxBytes`; if it is exceeded, 413 with the `tooLarge` message. */
async function readBody(req: Request, maxBytes: number, tooLarge: string): Promise<Uint8Array> {
  const bytes = await readLimitedBody(req, maxBytes);
  if (!bytes) throw tooLargeError(tooLarge);
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw validationError('The request body is not valid JSON.');
  }
}

async function jsonBody<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readBody(c.req.raw, MAX_JSON_BYTES, BODY_TOO_LARGE);
  return v.parse(schema, parseJson(bytes));
}

/** Like jsonBody, but an empty body counts as {}. */
async function optionalBody<T extends object>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readBody(c.req.raw, MAX_JSON_BYTES, BODY_TOO_LARGE);
  return v.parse(schema, bytes.byteLength === 0 ? {} : parseJson(bytes));
}

/** A key that is not shaped like a month cannot exist: 404, same as a missing month. */
function monthParam(c: Ctx): MonthKey {
  const key = c.req.param('key') ?? '';
  const shown = key.slice(0, 20);
  if (!isMonthKey(key)) throw monthNotFoundError(shown);
  return key;
}

function idParam(c: Ctx): string {
  return c.req.param('id') ?? '';
}

/** The request's user (whose data it is). Only missing on the NO_USER_HEADER routes, which do not ask for it. */
function userOf(c: Ctx): AppUser {
  const user = c.get('user');
  if (!user) throw new Error(`${c.req.path}: route without a resolved user`);
  return user;
}

const uid = (c: Ctx): string => userOf(c).id;

// ── Middleware ───────────────────────────────────────────────────────────────

/** Nothing from the API is stored in caches: it is personal data and it changes with every write. */
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/** All of /api/* sits behind Access except what was already authenticated with the Bearer (/api/ingest/*). */
const accessUnlessBearer: MiddlewareHandler<AppEnv> = (c, next) => (c.get('bearer') ? next() : accessAuth(c, next));

/**
 * The Access session travels in a cookie: a page on another site could fire writes with it (CSRF).
 * Browsers mark those requests with Sec-Fetch-Site: cross-site and they are rejected here.
 * Requests with the Bearer (Claude) and those that do not come from a browser do not carry that header.
 */
const sameSiteWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !c.get('bearer') && c.req.header('Sec-Fetch-Site') === 'cross-site') {
    throw forbiddenError('Request rejected: it comes from another site.');
  }
  await next();
};

/** /api/dev/* only exists with ALLOW_DEV_RESET=1; without it, it responds like any unknown route. */
const devOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!devEnabled(c.env)) throw notFoundError(ROUTE_NOT_FOUND);
  await next();
};

/**
 * Whose data it is: the X-User header has to name one of the configured users (USERS).
 * It does not decide who can get in (authentication, which runs earlier, already did that); it only picks whose finances.
 */
const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!NO_USER_HEADER.test(c.req.path)) c.set('user', userFromHeader(configuredUsers(c.env), c.req.header(USER_HEADER)));
  await next();
};

// ── Errors ───────────────────────────────────────────────────────────────────

function fromHttpException(err: HTTPException): ApiError {
  switch (err.status) {
    case 401:
      return new ApiError(401, 'unauthorized', 'Unauthorized.');
    case 403:
      return new ApiError(403, 'forbidden', 'Access denied.');
    case 404:
      return new ApiError(404, 'not_found', ROUTE_NOT_FOUND);
    case 413:
      return tooLargeError(BODY_TOO_LARGE);
    default:
      return err.status >= 400 && err.status < 500 ? validationError('Invalid request.') : toApiError(err);
  }
}

function onError(err: Error, c: Ctx): Response {
  const api = err instanceof HTTPException ? fromHttpException(err) : toApiError(err);
  // Only the unexpected goes to the log (a misconfigured USERS too, with its reason), and never to the response.
  if (api.status === 500) console.error(`[api] ${c.req.method} ${c.req.path}`, err);
  return c.json(errorBody(api.code, api.message), api.status, NO_STORE);
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Content-Disposition with an ASCII fallback name and filename* (RFC 5987) for the real name. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── App ──────────────────────────────────────────────────────────────────────

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', noStore);
  // Order matters: requireBearer marks the request and accessUnlessBearer only skips Access if it is marked.
  app.use('/ingest/*', requireBearer);
  app.use('*', accessUnlessBearer);
  app.use('*', sameSiteWrites);
  app.use('/dev/*', devOnly);
  // After authentication: whoever cannot get in is not told which users exist.
  app.use('*', requireUser);

  app.onError(onError);
  app.notFound((c) => c.json(errorBody('not_found', ROUTE_NOT_FOUND), 404, NO_STORE));

  // Configured users (for the select). The web app's only route without X-User.
  app.get('/session', (c) => c.json({ users: configuredUsers(c.env), devTools: devEnabled(c.env) } satisfies SessionResponse));

  // The user's full state; on their first visit, their initial accounts and goals and the current month are created.
  app.get('/state', async (c) => {
    const user = userOf(c);
    return c.json({ user, state: await db.openState(c.env.DB, user.id) } satisfies StateResponse);
  });

  // Language, colors, currencies and default account
  app.patch('/settings', async (c) => {
    const update = await jsonBody(c, v.settingsUpdateSchema);
    return c.json((await db.updateSettings(c.env.DB, uid(c), update)) satisfies SettingsResponse);
  });

  // Accounts
  app.get('/accounts', async (c) => c.json((await db.listAccounts(c.env.DB, uid(c))) satisfies Account[]));

  app.post('/accounts', async (c) => {
    const input = await jsonBody(c, v.accountCreateSchema);
    return c.json((await db.createAccount(c.env.DB, uid(c), input)) satisfies Account, 201);
  });

  app.patch('/accounts/:id', async (c) => {
    const patch = await jsonBody(c, v.accountPatchSchema);
    return c.json((await db.patchAccount(c.env.DB, uid(c), idParam(c), patch)) satisfies Account);
  });

  app.delete('/accounts/:id', async (c) => {
    await db.deleteAccount(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Credit cards
  app.get('/credit-cards', async (c) => c.json((await db.listCards(c.env.DB, uid(c))) satisfies CreditCard[]));

  app.post('/credit-cards', async (c) => {
    const input = await jsonBody(c, v.creditCardCreateSchema);
    return c.json((await db.createCard(c.env.DB, uid(c), input)) satisfies CreditCard, 201);
  });

  app.patch('/credit-cards/:id', async (c) => {
    const patch = await jsonBody(c, v.creditCardPatchSchema);
    return c.json((await db.patchCard(c.env.DB, uid(c), idParam(c), patch)) satisfies CreditCard);
  });

  app.delete('/credit-cards/:id', async (c) => {
    await db.deleteCard(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Months
  app.get('/months', async (c) => c.json((await db.listMonths(c.env.DB, uid(c))) satisfies MonthSummary[]));

  app.get('/months/:key', async (c) => {
    const key = monthParam(c);
    const month = await db.getMonth(c.env.DB, uid(c), key);
    if (!month) throw monthNotFoundError(key);
    return c.json(month satisfies Month);
  });

  app.patch('/months/:key', async (c) => {
    const key = monthParam(c);
    const patch = await jsonBody(c, v.monthPatchSchema);
    return c.json((await db.patchMonth(c.env.DB, uid(c), key, patch)) satisfies Month);
  });

  // The body is optional: without it, the next month starts with the budget parts of the one being closed.
  app.post('/months/:key/close', async (c) => {
    const key = monthParam(c);
    const bytes = await readBody(c.req.raw, MAX_JSON_BYTES, BODY_TOO_LARGE);
    const request = bytes.byteLength === 0 ? {} : v.parse(v.closeRequestSchema, parseJson(bytes));
    return c.json((await db.closeMonth(c.env.DB, uid(c), key, request)) satisfies CloseResponse);
  });

  app.post('/months/:key/reopen', async (c) => c.json((await db.reopenMonth(c.env.DB, uid(c), monthParam(c))) satisfies Month));

  app.delete('/months/:key', async (c) => {
    await db.deleteMonth(c.env.DB, uid(c), monthParam(c));
    return c.json(OK);
  });

  // The month's budget log
  app.post('/months/:key/budget-log', async (c) => {
    const key = monthParam(c);
    const input = await jsonBody(c, v.budgetEntryCreateSchema);
    return c.json((await db.addBudgetEntry(c.env.DB, uid(c), key, input)) satisfies Month, 201);
  });

  app.delete('/months/:key/budget-log/:id', async (c) =>
    c.json((await db.deleteBudgetEntry(c.env.DB, uid(c), monthParam(c), idParam(c))) satisfies Month),
  );

  // Adds to the month what was left over from the previous one
  app.post('/months/:key/leftover', async (c) => c.json((await db.addLeftover(c.env.DB, uid(c), monthParam(c))) satisfies Month, 201));

  // The month's credit cards: other charges, add payments (full or partial) and remove them (all or one), per credit card
  const cardParam = (c: Ctx) => c.req.param('cardId') ?? '';

  app.patch('/months/:key/cards/:cardId/other', async (c) => {
    const key = monthParam(c);
    const input = await jsonBody(c, v.cardOtherSchema);
    return c.json((await db.setCardOther(c.env.DB, uid(c), key, cardParam(c), input.other)) satisfies Month);
  });

  app.patch('/months/:key/cards/:cardId/cashback', async (c) => {
    const key = monthParam(c);
    const input = await jsonBody(c, v.cardCashbackSchema);
    return c.json((await db.setCardCashback(c.env.DB, uid(c), key, cardParam(c), input.cashback)) satisfies Month);
  });

  app.post('/months/:key/cards/:cardId/pay', async (c) => {
    const key = monthParam(c);
    const input = await jsonBody(c, v.cardPaySchema);
    return c.json((await db.payCard(c.env.DB, uid(c), key, cardParam(c), input)) satisfies Month);
  });

  app.delete('/months/:key/cards/:cardId/pay', async (c) =>
    c.json((await db.unpayCard(c.env.DB, uid(c), monthParam(c), cardParam(c))) satisfies Month),
  );

  app.delete('/months/:key/cards/:cardId/pay/:paymentId', async (c) =>
    c.json((await db.removeCardPayment(c.env.DB, uid(c), monthParam(c), cardParam(c), c.req.param('paymentId') ?? '')) satisfies Month),
  );

  // Rates typed by hand: one per currency pair and date
  app.put('/months/:key/rates', async (c) => {
    const key = monthParam(c);
    const rate = await jsonBody(c, v.monthRateSchema);
    return c.json((await db.setMonthRate(c.env.DB, uid(c), key, rate)) satisfies Month);
  });

  app.delete('/months/:key/rates/:from/:to', async (c) => {
    const key = monthParam(c);
    const pair = v.parse(v.ratePairSchema, { from: c.req.param('from'), to: c.req.param('to'), date: c.req.query('date') });
    return c.json((await db.deleteMonthRate(c.env.DB, uid(c), key, pair.from, pair.to, pair.date)) satisfies Month);
  });

  // Fixed expenses
  app.post('/fixed', async (c) => {
    const input = await jsonBody(c, v.fixedCreateSchema);
    return c.json((await db.createFixed(c.env.DB, uid(c), input)) satisfies FixedExpense, 201);
  });

  app.patch('/fixed/:id', async (c) => {
    const patch = await jsonBody(c, v.fixedPatchSchema);
    return c.json((await db.patchFixed(c.env.DB, uid(c), idParam(c), patch)) satisfies FixedExpense);
  });

  app.delete('/fixed/:id', async (c) => {
    await db.deleteFixed(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Transactions
  app.post('/transactions', async (c) => {
    const input = await jsonBody(c, v.txCreateSchema);
    return c.json((await db.createTransaction(c.env.DB, uid(c), input)) satisfies Transaction, 201);
  });

  app.patch('/transactions/:id', async (c) => {
    const patch = await jsonBody(c, v.txPatchSchema);
    return c.json((await db.patchTransaction(c.env.DB, uid(c), idParam(c), patch)) satisfies Transaction);
  });

  app.delete('/transactions/:id', async (c) => {
    await db.deleteTransaction(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Outside budget. Both "move" routes accept an empty body.
  app.post('/transactions/:id/move-outside', async (c) => {
    const request = await optionalBody(c, v.moveOutsideSchema);
    return c.json((await db.moveTransactionOutside(c.env.DB, uid(c), idParam(c), request.id)) satisfies OutsideExpense, 201);
  });

  app.post('/outside-expenses', async (c) => {
    const input = await jsonBody(c, v.outsideCreateSchema);
    return c.json((await db.createOutside(c.env.DB, uid(c), input)) satisfies OutsideExpense, 201);
  });

  app.patch('/outside-expenses/:id', async (c) => {
    const patch = await jsonBody(c, v.outsidePatchSchema);
    return c.json((await db.patchOutside(c.env.DB, uid(c), idParam(c), patch)) satisfies OutsideExpense);
  });

  app.delete('/outside-expenses/:id', async (c) => {
    await db.deleteOutside(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  app.post('/outside-expenses/:id/move-to-budget', async (c) => {
    const request = await optionalBody(c, v.moveToBudgetSchema);
    return c.json((await db.moveOutsideToBudget(c.env.DB, uid(c), idParam(c), request)) satisfies Transaction, 201);
  });

  // Transfers
  app.post('/transfers', async (c) => {
    const input = await jsonBody(c, v.transferCreateSchema);
    return c.json((await db.createTransfer(c.env.DB, uid(c), input)) satisfies Transfer, 201);
  });

  app.patch('/transfers/:id', async (c) => {
    const patch = await jsonBody(c, v.transferPatchSchema);
    return c.json((await db.patchTransfer(c.env.DB, uid(c), idParam(c), patch)) satisfies Transfer);
  });

  app.delete('/transfers/:id', async (c) => {
    await db.deleteTransfer(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Incomes
  app.get('/incomes', async (c) => c.json((await db.listIncomes(c.env.DB, uid(c))) satisfies Income[]));

  app.post('/incomes', async (c) => {
    const input = await jsonBody(c, v.incomeCreateSchema);
    return c.json((await db.createIncome(c.env.DB, uid(c), input)) satisfies Income, 201);
  });

  app.patch('/incomes/:id', async (c) => {
    const patch = await jsonBody(c, v.incomePatchSchema);
    return c.json((await db.patchIncome(c.env.DB, uid(c), idParam(c), patch)) satisfies Income);
  });

  app.delete('/incomes/:id', async (c) => {
    await db.deleteIncome(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Goals
  app.get('/goals', async (c) => c.json((await db.listGoals(c.env.DB, uid(c))) satisfies Goal[]));

  app.post('/goals', async (c) => {
    const input = await jsonBody(c, v.goalCreateSchema);
    return c.json((await db.createGoal(c.env.DB, uid(c), input)) satisfies Goal, 201);
  });

  app.patch('/goals/:id', async (c) => {
    const patch = await jsonBody(c, v.goalPatchSchema);
    return c.json((await db.patchGoal(c.env.DB, uid(c), idParam(c), patch)) satisfies Goal);
  });

  app.delete('/goals/:id', async (c) => {
    await db.deleteGoal(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Contributions
  app.get('/contributions', async (c) => c.json((await db.listContributions(c.env.DB, uid(c))) satisfies Contribution[]));

  app.post('/contributions', async (c) => {
    const input = await jsonBody(c, v.contributionCreateSchema);
    return c.json((await db.createContribution(c.env.DB, uid(c), input)) satisfies Contribution, 201);
  });

  app.patch('/contributions/:id', async (c) => {
    const patch = await jsonBody(c, v.contributionPatchSchema);
    return c.json((await db.patchContribution(c.env.DB, uid(c), idParam(c), patch)) satisfies Contribution);
  });

  app.delete('/contributions/:id', async (c) => {
    await db.deleteContribution(c.env.DB, uid(c), idParam(c));
    return c.json(OK);
  });

  // Excel: the user's workbook, in their language. The workbook keeps the original layout (two currencies, two accounts):
  // buildExportData projects the state into that shape and applyImport loads it back (shared/excel/data.ts).
  app.get('/export.xlsx', async (c) => {
    const user = userOf(c);
    const state = await db.loadState(c.env.DB, user.id);
    const bytes = buildFinanzasXlsx(buildExportData(state), { currentKey: currentMonthKey(), locale: excelLocale(state.language) });
    return new Response(bytes, {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': attachment(xlsxFilename(user.name)),
        'Content-Length': String(bytes.byteLength),
        ...NO_STORE,
      },
    });
  });

  app.post('/import', async (c) => {
    const bytes = await readBody(c.req.raw, MAX_IMPORT_BYTES, 'The file is too large (maximum 10 MB).');
    const type = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    let raw: unknown;
    if (type === 'application/json') {
      raw = parseJson(bytes);
    } else {
      try {
        raw = parseFinanzasXlsx(bytes);
      } catch (err) {
        if (err instanceof ImportError) throw validationError(err.message);
        // A file that makes the reader fail is a bad file, not a server failure.
        console.error('[api] import: could not read the .xlsx', err);
        throw validationError('Could not read the file.');
      }
    }
    // What comes out of the Excel reader is validated the same as JSON: it comes from a file we do not control.
    const payload = v.parse(v.importSchema, raw);
    return c.json((await db.applyImport(c.env.DB, uid(c), payload)) satisfies ImportResponse);
  });

  // Recording from Claude (Bearer). The user goes in the body: ingestTransaction resolves it.
  app.post('/ingest/transaction', async (c) => {
    // ingestTransaction validates the input; the only check here is that it is JSON.
    const bytes = await readBody(c.req.raw, MAX_JSON_BYTES, BODY_TOO_LARGE);
    const input = parseJson(bytes) as IngestTransaction;
    return c.json((await ingestTransaction(c.env.DB, configuredUsers(c.env), input)) satisfies IngestResponse, 201);
  });

  // Local development (devOnly). These routes act only on the X-User user.
  app.post('/dev/seed', async (c) => {
    const id = uid(c);
    // The user's language and colors stay as they were; the currencies and the default account are those
    // of the sample data, which go with its accounts.
    const { theme, language } = await db.getSettings(c.env.DB, id);
    await db.replaceAll(c.env.DB, id, { ...seedState(), theme, language });
    return c.json(OK);
  });

  app.post('/dev/reset', async (c) => {
    await db.resetAll(c.env.DB, uid(c));
    return c.json(OK);
  });

  return app;
}
