// Usuarios de la app. No hay registro ni tabla: la lista sale de la variable de entorno USERS, para poder
// agregar o renombrar a alguien sin tocar el código. Quién puede ENTRAR lo decide Cloudflare Access (por correo);
// esto solo define de quién son las finanzas que se están viendo.

import type { AppUser } from './types';

/** Cabecera con la que cada petición a /api/* dice de qué usuario son los datos. */
export const USER_HEADER = 'X-User';

/** Si USERS no está definida, la app funciona con un solo usuario. */
export const DEFAULT_USERS: readonly AppUser[] = [{ id: 'me', name: 'Me' }];

export const MAX_USERS = 12;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_NAME = 40;

export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/**
 * Lee USERS: pares `id:Nombre` separados por comas, p. ej. "frank:Frank,eda:Eda".
 *  · id: minúsculas, dígitos, guion y guion bajo (máx. 32). No cambiarlo después: es la clave de los datos.
 *  · Nombre: lo que se ve en el selector; si falta, el id con la inicial en mayúscula.
 * Vacío o sin definir → DEFAULT_USERS. Un valor mal escrito lanza un error con el motivo (mejor que arrancar
 * con una lista distinta de la que se quiso configurar).
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
