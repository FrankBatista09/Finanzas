// Users of the app. There is no sign-up and no table: the list comes from the USERS environment variable, so
// someone can be added or renamed without touching the code. Who can GET IN is decided by Cloudflare Access (by email);
// this only defines whose finances are being viewed.

import type { AppUser } from './types';

/** Header with which each request to /api/* says which user the data belongs to. */
export const USER_HEADER = 'X-User';

/** If USERS is not defined, the app runs with a single user. */
export const DEFAULT_USERS: readonly AppUser[] = [{ id: 'me', name: 'Me' }];

export const MAX_USERS = 12;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_NAME = 40;

export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/**
 * Reads USERS: comma-separated `id:Name` pairs, e.g. "frank:Frank,eda:Eda".
 *  · id: lowercase letters, digits, hyphen and underscore (max. 32). Do not change it later: it is the key of the data.
 *  · Name: what shows in the select; if missing, the id with its first letter capitalized.
 * Empty or undefined → DEFAULT_USERS. A malformed value throws an error with the reason (better than starting
 * with a list different from the one that was meant to be configured).
 */
export function parseUsers(raw: string | null | undefined): AppUser[] {
  const text = (raw ?? '').trim();
  if (!text) return DEFAULT_USERS.map((u) => ({ ...u }));

  const users: AppUser[] = [];
  const seen = new Set<string>();
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf(':');
    const id = (sep < 0 ? entry : entry.slice(0, sep)).trim();
    const name = (sep < 0 ? '' : entry.slice(sep + 1)).trim() || id.charAt(0).toUpperCase() + id.slice(1);
    if (!isUserId(id)) throw new Error(`USERS: invalid user id "${id}" (use lowercase letters, digits, - or _)`);
    if (name.length > MAX_NAME) throw new Error(`USERS: the name of "${id}" is longer than ${MAX_NAME} characters`);
    if (seen.has(id)) throw new Error(`USERS: duplicate user id "${id}"`);
    seen.add(id);
    users.push({ id, name });
  }
  if (!users.length) return DEFAULT_USERS.map((u) => ({ ...u }));
  if (users.length > MAX_USERS) throw new Error(`USERS: at most ${MAX_USERS} users`);
  return users;
}
