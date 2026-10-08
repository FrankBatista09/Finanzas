// Utilidades de las pruebas de server/: una base en memoria con las migraciones y un cliente de la app.

import type { ApiErrorBody } from '../shared/api';
import type { AppState, AppUser } from '../shared/types';
import { USER_HEADER } from '../shared/users';
import { createApp } from './app';
import { asD1, createTestDb } from './d1-node';
import type { NodeD1Database } from './d1-node';
import type { Env } from './env';

export const TOKEN = 'token-de-prueba';

/** Los usuarios de las pruebas, los mismos de wrangler.toml: dos personas con sus finanzas aparte. */
export const FRANK: AppUser = { id: 'frank', name: 'Frank' };
export const EDA: AppUser = { id: 'eda', name: 'Eda' };
export const USERS = 'frank:Frank,eda:Eda';

export interface TestEnv {
  /** El adaptador, para mirar la base por debajo de la API. */
  sqlite: NodeD1Database;
  db: D1Database;
  env: Env;
}

/** Una base recién migrada y su entorno, con los dos usuarios configurados salvo que `extra` diga otra cosa. */
export function makeEnv(extra: Partial<Env> = {}): TestEnv {
  const sqlite = createTestDb();
  const db = asD1(sqlite);
  return { sqlite, db, env: { DB: db, API_TOKEN: TOKEN, USERS, ...extra } };
}

export interface Reply<T> {
  status: number;
  /** El cuerpo JSON (o null si la respuesta no es JSON). */
  body: T;
  /** `body.error` cuando la respuesta es un ApiErrorBody. */
  error: ApiErrorBody['error'] | undefined;
  headers: Headers;
}

export interface Client {
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  put<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  patch<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  del<T = unknown>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  /** Petición sin adornos: el cuerpo se manda tal cual (pero con la cabecera del usuario, si el cliente tiene uno). */
  raw(path: string, init: RequestInit): Promise<Response>;
}

/**
 * Cliente de la app que habla como `user` (cabecera X-User), por defecto Frank. Con `null` no manda la cabecera.
 * Las cabeceras de cada petición ganan a la del cliente.
 */
export function client(env: Env, user: string | null = FRANK.id): Client {
  const app = createApp();
  const who: Record<string, string> = user === null ? {} : { [USER_HEADER]: user };

  const raw = async (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(who);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return app.request(path, { ...init, headers }, env);
  };

  const send = async <T>(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json', ...headers };
    }
    const res = await raw(path, init);
    const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
    const parsed: unknown = isJson ? await res.json() : null;
    const error = (parsed as Partial<ApiErrorBody> | null)?.error;
    return { status: res.status, body: parsed as T, error, headers: res.headers };
  };

  return {
    get: (path, headers) => send('GET', path, undefined, headers),
    post: (path, body, headers) => send('POST', path, body, headers),
    put: (path, body, headers) => send('PUT', path, body, headers),
    patch: (path, body, headers) => send('PATCH', path, body, headers),
    del: (path, headers) => send('DELETE', path, undefined, headers),
    raw,
  };
}

/** Quita lo que la base asigna por su cuenta (createdAt) para comparar estados. */
export function withoutTimestamps(state: AppState): AppState {
  return {
    ...state,
    months: Object.fromEntries(
      Object.entries(state.months).map(([key, m]) => [key, { ...m, tx: m.tx.map((t) => ({ ...t, createdAt: null })) }]),
    ),
  };
}

/** Filas de una tabla: las de un usuario, o las de todos si no se indica. */
export function count(sqlite: NodeD1Database, table: string, userId?: string): number {
  const row =
    userId === undefined
      ? sqlite.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
      : sqlite.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId);
  return Number(row?.n);
}
