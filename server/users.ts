// De quién son los datos de una petición. Los usuarios salen de la variable USERS (shared/users.ts) y aquí se
// resuelve cuál de ellos pide algo: la API lo recibe en la cabecera X-User; /api/ingest/* y /mcp, en el cuerpo.
// No es un control de acceso (eso es Cloudflare Access o el Bearer): solo elige las finanzas de quién se tocan.
// No sabe nada de HTTP: lanza ApiError y cada servidor (server/app.ts, server/mcp.ts) lo traduce a su respuesta.

import type { AppUser } from '../shared/types';
import { parseUsers, USER_HEADER } from '../shared/users';
import type { Env } from './env';
import { invalidData, validationError } from './errors';

/**
 * Los usuarios configurados, en el orden de USERS. Un valor mal escrito es un error de configuración: lanza el
 * Error de parseUsers (no un ApiError), que acaba en un 500 `internal` con el motivo en el log. Arrancar con
 * una lista distinta de la que se quiso configurar sería peor.
 */
export function configuredUsers(env: Pick<Env, 'USERS'>): AppUser[] {
  return parseUsers(env.USERS);
}

function validIds(users: readonly AppUser[]): string {
  return `valid ids: ${users.map((u) => u.id).join(', ')}`;
}

function find(users: readonly AppUser[], id: string): AppUser | undefined {
  // Los ids son siempre minúsculas (shared/users.ts): "Frank" o " frank " solo pueden querer decir "frank".
  const wanted = id.trim().toLowerCase();
  return users.find((u) => u.id === wanted);
}

/** El id viene de fuera: se recorta para que el mensaje no crezca con lo que mande el cliente. */
function shown(id: string): string {
  return id.trim().slice(0, 40);
}

/**
 * El usuario de la cabecera X-User. Es obligatoria aunque solo haya un usuario configurado.
 * Lanza ApiError 400 `validation` si falta o no es uno de los configurados.
 */
export function userFromHeader(users: readonly AppUser[], value: string | null | undefined): AppUser {
  if (!value?.trim()) throw validationError(`The ${USER_HEADER} header is required (${validIds(users)}).`);
  const user = find(users, value);
  if (!user) throw validationError(`Unknown user "${shown(value)}" in the ${USER_HEADER} header (${validIds(users)}).`);
  return user;
}

/**
 * El usuario de un registro que dicta Claude (campo `user` de /api/ingest/* y de las herramientas del MCP).
 * Si solo hay un usuario configurado, es ese y el campo se puede omitir; con varios es obligatorio.
 * Lanza ApiError 400 `validation`, con los ids válidos en el mensaje para que Claude pueda corregirse.
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
