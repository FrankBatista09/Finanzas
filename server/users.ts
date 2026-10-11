// Whose data a request is about. The users come from the USERS variable (shared/users.ts) and this file resolves
// which of them is asking for something: the API receives it in the X-User header; /api/ingest/* and /mcp, in the body.
// It is not access control (that is Cloudflare Access or the Bearer token): it only picks whose finances are touched.
// It knows nothing about HTTP: it throws ApiError and each server (server/app.ts, server/mcp.ts) maps it to its response.

import type { AppUser } from '../shared/types';
import { parseUsers, USER_HEADER } from '../shared/users';
import type { Env } from './env';
import { invalidData, validationError } from './errors';

/**
 * The configured users, in the order of USERS. A malformed value is a configuration error: it throws the
 * Error from parseUsers (not an ApiError), which ends up as a 500 `internal` with the reason in the log. Starting
 * with a list different from the one that was meant to be configured would be worse.
 */
export function configuredUsers(env: Pick<Env, 'USERS'>): AppUser[] {
  return parseUsers(env.USERS);
}

function validIds(users: readonly AppUser[]): string {
  return `valid ids: ${users.map((u) => u.id).join(', ')}`;
}

function find(users: readonly AppUser[], id: string): AppUser | undefined {
  // Ids are always lowercase (shared/users.ts): "Frank" or " frank " can only mean "frank".
  const wanted = id.trim().toLowerCase();
  return users.find((u) => u.id === wanted);
}

/** The id comes from outside: it is cut short so the message does not grow with whatever the client sends. */
function shown(id: string): string {
  return id.trim().slice(0, 40);
}

/**
 * The user in the X-User header. The header is required even when only one user is configured.
 * Throws ApiError 400 `validation` if it is missing or is not one of the configured users.
 */
export function userFromHeader(users: readonly AppUser[], value: string | null | undefined): AppUser {
  if (!value?.trim()) throw validationError(`The ${USER_HEADER} header is required (${validIds(users)}).`);
  const user = find(users, value);
  if (!user) throw validationError(`Unknown user "${shown(value)}" in the ${USER_HEADER} header (${validIds(users)}).`);
  return user;
}

/**
 * The user of a record dictated by Claude (the `user` field of /api/ingest/* and of the MCP tools).
 * If only one user is configured, it is that one and the field can be omitted; with several it is required.
 * Throws ApiError 400 `validation`, with the valid ids in the message so Claude can correct itself.
 */
export function userFromBody(users: readonly AppUser[], value: string | null | undefined): AppUser {
  if (!value?.trim()) {
    if (users.length === 1) return users[0]!;
    throw validationError(invalidData(`user: is required when there are several users (${validIds(users)})`));
  }
  const user = find(users, value);
  if (!user) throw validationError(invalidData(`user: unknown user "${shown(value)}" (${validIds(users)})`));
  return user;
}
