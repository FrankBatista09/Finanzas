// Utilities for the server/ tests: an in-memory database with the migrations and a client of the app.

import type { ApiErrorBody } from '../shared/api';
import type { AppState, AppUser } from '../shared/types';
import { USER_HEADER } from '../shared/users';
import { createApp } from './app';
import { asD1, createTestDb } from './d1-node';
import type { NodeD1Database } from './d1-node';
import type { Env } from './env';

export const TOKEN = 'token-de-prueba';

/** The test users, the same as in wrangler.toml: two people with separate finances. */
export const FRANK: AppUser = { id: 'frank', name: 'Frank' };
export const EDA: AppUser = { id: 'eda', name: 'Eda' };
export const USERS = 'frank:Frank,eda:Eda';

export interface TestEnv {
  /** The adapter, to look at the database underneath the API. */
  sqlite: NodeD1Database;
  db: D1Database;
  env: Env;
}

/** A freshly migrated database and its environment, with the two users configured unless `extra` says otherwise. */
export function makeEnv(extra: Partial<Env> = {}): TestEnv {
  const sqlite = createTestDb();
  const db = asD1(sqlite);
  return { sqlite, db, env: { DB: db, API_TOKEN: TOKEN, USERS, ...extra } };
}

export interface Reply<T> {
  status: number;
  /** The JSON body (or null if the response is not JSON). */
  body: T;
  /** `body.error` when the response is an ApiErrorBody. */
  error: ApiErrorBody['error'] | undefined;
  headers: Headers;
}

export interface Client {
  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  put<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  patch<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  del<T = unknown>(path: string, headers?: Record<string, string>): Promise<Reply<T>>;
  /** Bare request: the body is sent as is (but with the user header, if the client has a user). */
  raw(path: string, init: RequestInit): Promise<Response>;
}

/**
 * Client of the app that speaks as `user` (X-User header), Frank by default. With `null` it does not send the header.
 * The headers of each request win over the client's.
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

/** Removes what the database assigns on its own (createdAt) so states can be compared. */
export function withoutTimestamps(state: AppState): AppState {
  return {
    ...state,
    months: Object.fromEntries(
      Object.entries(state.months).map(([key, m]) => [key, { ...m, tx: m.tx.map((t) => ({ ...t, createdAt: null })) }]),
    ),
  };
}

/** Rows of a table: those of one user, or everyone's if none is given. */
export function count(sqlite: NodeD1Database, table: string, userId?: string): number {
  const row =
    userId === undefined
      ? sqlite.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
      : sqlite.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId);
  return Number(row?.n);
}
