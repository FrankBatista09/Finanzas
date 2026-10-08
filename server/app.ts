// La API HTTP (Hono sobre Cloudflare Pages Functions). El contrato está en shared/api.ts:
// rutas, cuerpos, códigos de estado y reglas de escritura salen de ahí.

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
  FixedExpense,
  Goal,
  Income,
  Month,
  MonthKey,
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
    /** El usuario de la cabecera X-User, ya resuelto (requireUser). No existe en /api/session ni en /api/ingest/*. */
    user?: AppUser;
  };
};
type Ctx = Context<AppEnv>;

/** Los cuerpos JSON de la app son de unos cientos de bytes; el tope solo frena abusos. */
export const MAX_JSON_BYTES = 1024 * 1024;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const OK: OkResponse = { ok: true };
const ROUTE_NOT_FOUND = 'Route not found.';
const BODY_TOO_LARGE = 'The request body is too large.';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Las únicas rutas sin cabecera X-User: la lista de usuarios para el selector y lo que registra Claude (el usuario va en el cuerpo). */
const NO_USER_HEADER = /^\/api\/(?:session$|ingest(?:\/|$))/;

function devEnabled(env: Env): boolean {
  return env.ALLOW_DEV_RESET === '1';
}

// ── Cuerpo de la petición ────────────────────────────────────────────────────

/** Lee el cuerpo sin pasar de `maxBytes`; si se excede, 413 con el mensaje `tooLarge`. */
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

/** Una clave que no tiene forma de mes no puede existir: 404, igual que un mes que falta. */
function monthParam(c: Ctx): MonthKey {
  const key = c.req.param('key') ?? '';
  const shown = key.slice(0, 20);
  if (!isMonthKey(key)) throw monthNotFoundError(shown);
  return key;
}

function idParam(c: Ctx): string {
  return c.req.param('id') ?? '';
}

/** El usuario de la petición (de quién son los datos). Solo falta en las rutas de NO_USER_HEADER, que no lo piden. */
function userOf(c: Ctx): AppUser {
  const user = c.get('user');
  if (!user) throw new Error(`${c.req.path}: route without a resolved user`);
  return user;
}

const uid = (c: Ctx): string => userOf(c).id;

// ── Middleware ───────────────────────────────────────────────────────────────

/** Nada de la API se guarda en cachés: son datos personales y cambian con cada escritura. */
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/** Todo /api/* va detrás de Access salvo lo que ya se autenticó con el Bearer (/api/ingest/*). */
const accessUnlessBearer: MiddlewareHandler<AppEnv> = (c, next) => (c.get('bearer') ? next() : accessAuth(c, next));

/**
 * La sesión de Access viaja en una cookie: una página de otro sitio podría lanzar escrituras con ella (CSRF).
 * Los navegadores marcan esas peticiones con Sec-Fetch-Site: cross-site y aquí se rechazan.
 * Las peticiones con Bearer (Claude) y las que no vienen de un navegador no llevan esa cabecera.
 */
const sameSiteWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !c.get('bearer') && c.req.header('Sec-Fetch-Site') === 'cross-site') {
    throw forbiddenError('Request rejected: it comes from another site.');
  }
  await next();
};

/** /api/dev/* solo existe con ALLOW_DEV_RESET=1; sin ella responde como cualquier ruta desconocida. */
const devOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!devEnabled(c.env)) throw notFoundError(ROUTE_NOT_FOUND);
  await next();
};

/**
 * De quién son los datos: la cabecera X-User tiene que nombrar a uno de los usuarios configurados (USERS).
 * No decide quién puede entrar (eso ya lo hizo la autenticación, que va antes); solo elige las finanzas de quién.
 */
const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!NO_USER_HEADER.test(c.req.path)) c.set('user', userFromHeader(configuredUsers(c.env), c.req.header(USER_HEADER)));
  await next();
};

// ── Errores ──────────────────────────────────────────────────────────────────

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
  // Solo lo inesperado va al log (también un USERS mal configurado, con su motivo), y nunca a la respuesta.
  if (api.status === 500) console.error(`[api] ${c.req.method} ${c.req.path}`, err);
  return c.json(errorBody(api.code, api.message), api.status, NO_STORE);
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Content-Disposition con nombre ASCII de respaldo y filename* (RFC 5987) para el nombre real. */
function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ── App ──────────────────────────────────────────────────────────────────────

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', noStore);
  // El orden importa: requireBearer marca la petición y accessUnlessBearer solo se salta Access si está marcada.
  app.use('/ingest/*', requireBearer);
  app.use('*', accessUnlessBearer);
  app.use('*', sameSiteWrites);
  app.use('/dev/*', devOnly);
  // Después de la autenticación: a quien no puede entrar no se le dice qué usuarios hay.
  app.use('*', requireUser);

  app.onError(onError);
  app.notFound((c) => c.json(errorBody('not_found', ROUTE_NOT_FOUND), 404, NO_STORE));

  // Usuarios configurados (para el selector). La única ruta de la web sin X-User.
  app.get('/session', (c) => c.json({ users: configuredUsers(c.env), devTools: devEnabled(c.env) } satisfies SessionResponse));

  // Estado completo del usuario; la primera vez que entra se le crean sus cuentas y metas iniciales y el mes en curso.
  app.get('/state', async (c) => {
    const user = userOf(c);
    return c.json({ user, state: await db.openState(c.env.DB, user.id) } satisfies StateResponse);
  });

  // Idioma, colores, monedas y cuenta por defecto
  app.patch('/settings', async (c) => {
    const update = await jsonBody(c, v.settingsUpdateSchema);
    return c.json((await db.updateSettings(c.env.DB, uid(c), update)) satisfies SettingsResponse);
  });

  // Cuentas
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

  // Meses
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

  app.post('/months/:key/close', async (c) =>
    c.json((await db.closeMonth(c.env.DB, uid(c), monthParam(c))) satisfies CloseResponse),
  );

  app.post('/months/:key/reopen', async (c) => c.json((await db.reopenMonth(c.env.DB, uid(c), monthParam(c))) satisfies Month));

  app.delete('/months/:key', async (c) => {
    await db.deleteMonth(c.env.DB, uid(c), monthParam(c));
    return c.json(OK);
  });

  // Tasas del mes escritas a mano: una por par de monedas
  app.put('/months/:key/rates', async (c) => {
    const key = monthParam(c);
    const rate = await jsonBody(c, v.monthRateSchema);
    return c.json((await db.setMonthRate(c.env.DB, uid(c), key, rate)) satisfies Month);
  });

  app.delete('/months/:key/rates/:from/:to', async (c) => {
    const key = monthParam(c);
    const pair = v.parse(v.ratePairSchema, { from: c.req.param('from'), to: c.req.param('to') });
    return c.json((await db.deleteMonthRate(c.env.DB, uid(c), key, pair.from, pair.to)) satisfies Month);
  });

  // Gastos fijos
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

  // Transacciones
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

  // Envíos
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

  // Ingresos
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

  // Metas
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

  // Aportes
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

  // Excel: el libro del usuario, en su idioma. El libro conserva el diseño original (dos monedas, dos cuentas):
  // buildExportData proyecta el estado a esa forma y applyImport lo vuelca de vuelta (shared/excel/data.ts).
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
        // Un archivo que hace fallar al lector es un archivo malo, no un fallo del servidor.
        console.error('[api] import: could not read the .xlsx', err);
        throw validationError('Could not read the file.');
      }
    }
    // Lo que sale del lector de Excel se valida igual que un JSON: viene de un archivo que no controlamos.
    const payload = v.parse(v.importSchema, raw);
    return c.json((await db.applyImport(c.env.DB, uid(c), payload)) satisfies ImportResponse);
  });

  // Registro desde Claude (Bearer). El usuario va en el cuerpo: lo resuelve ingestTransaction.
  app.post('/ingest/transaction', async (c) => {
    // ingestTransaction valida la entrada; aquí solo se comprueba que sea JSON.
    const bytes = await readBody(c.req.raw, MAX_JSON_BYTES, BODY_TOO_LARGE);
    const input = parseJson(bytes) as IngestTransaction;
    return c.json((await ingestTransaction(c.env.DB, configuredUsers(c.env), input)) satisfies IngestResponse, 201);
  });

  // Desarrollo local (devOnly). Actúan solo sobre el usuario de X-User.
  app.post('/dev/seed', async (c) => {
    const id = uid(c);
    // El idioma y los colores del usuario se quedan como estaban; las monedas y la cuenta por defecto son las
    // de los datos de ejemplo, que van con sus cuentas.
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
