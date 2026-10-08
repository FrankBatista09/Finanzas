// Autenticación de la API.
//   · /api/ingest/* y /mcp : Authorization: Bearer <API_TOKEN> (lo usa Claude; quedan fuera de Cloudflare Access).
//   · resto de /api/*      : Cloudflare Access delante del sitio. Si ACCESS_TEAM_DOMAIN y ACCESS_AUD están
//                            configurados se valida además su JWT aquí; si no, se deja pasar (desarrollo local).

import type { Context, MiddlewareHandler } from 'hono';
import type { ApiErrorCode } from '../shared/api';
import type { Env } from './env';
import { errorBody } from './errors';

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    /** true cuando la petición ya se autenticó con el Bearer (no pasa además por Access). */
    bearer?: boolean;
  };
};

const encoder = new TextEncoder();

function deny(
  c: Context<AuthEnv>,
  status: 401 | 403,
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return c.json(errorBody(code, message), status, { 'Cache-Control': 'no-store', ...headers });
}

// ── Bearer ───────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/**
 * Compara en tiempo constante: se comparan los SHA-256 (misma longitud siempre) byte a byte y sin salir
 * en la primera diferencia, para que el tiempo de respuesta no revele cuánto del token es correcto.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

/** true solo si la petición trae `Authorization: Bearer <API_TOKEN>`. Sin API_TOKEN configurado, siempre false. */
export async function checkBearer(request: Request, env: Pick<Env, 'API_TOKEN'>): Promise<boolean> {
  const expected = env.API_TOKEN;
  if (!expected) return false;
  const match = /^Bearer +(\S+) *$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) return false;
  return safeEqual(match[1]!, expected);
}

export const requireBearer: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!(await checkBearer(c.req.raw, c.env))) {
    return deny(c, 401, 'unauthorized', 'Invalid or missing token.', { 'WWW-Authenticate': 'Bearer' });
  }
  c.set('bearer', true);
  await next();
};

// ── Cloudflare Access ────────────────────────────────────────────────────────

/** Las claves de firma de Access rotan cada pocas semanas; una hora de caché es de sobra. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Un `kid` desconocido fuerza a volver a pedir las claves, pero no más de una vez por minuto (evita que tokens basura provoquen una petición cada uno). */
const JWKS_REFETCH_MIN_MS = 60 * 1000;
/** Margen para el desfase de relojes al comprobar exp y nbf. */
const LEEWAY_S = 60;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

interface Jwks {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const jwksCache = new Map<string, Jwks>();

/** Vacía la caché de claves (para las pruebas). */
export function clearAccessKeyCache(): void {
  jwksCache.clear();
}

async function fetchJwks(team: string, now: number): Promise<Jwks> {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access: no se pudieron obtener las claves (HTTP ${res.status})`);
  const body = (await res.json()) as { keys?: unknown };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(body.keys) ? (body.keys as Record<string, unknown>[]) : []) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      // Solo n y e: el uso y el algoritmo los fija este código, no lo que diga el documento.
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, RS256, false, ['verify']);
      keys.set(jwk.kid, key);
    } catch {
      // Una clave ilegible no invalida las demás.
    }
  }
  return { keys, fetchedAt: now };
}

async function signingKey(team: string, kid: string, now: number): Promise<CryptoKey | null> {
  let jwks = jwksCache.get(team);
  const stale = !jwks || now - jwks.fetchedAt > JWKS_TTL_MS;
  const unknownKid = !!jwks && !jwks.keys.has(kid) && now - jwks.fetchedAt > JWKS_REFETCH_MIN_MS;
  if (stale || unknownKid) {
    try {
      jwks = await fetchJwks(team, now);
      jwksCache.set(team, jwks);
    } catch (err) {
      // Si Access no responde y hay claves en caché, se sigue con ellas; sin caché no hay forma de validar.
      if (!jwks) throw err;
    }
  }
  return jwks?.keys.get(kid) ?? null;
}

function base64UrlBytes(part: string): Uint8Array {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 'https://Equipo.cloudflareaccess.com/' → 'equipo.cloudflareaccess.com'; null si no es un nombre de host. */
function teamHost(value: string): string | null {
  const host = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

export type AccessVerdict =
  | { ok: true; claims: Record<string, unknown> }
  /** 401: no hay identidad válida (token ilegible, firma mala, caducado). 403: la hay, pero no es para esta aplicación. */
  | { ok: false; status: 401 | 403; reason: string };

export interface AccessConfig {
  /** 'tu-equipo.cloudflareaccess.com' */
  teamDomain: string;
  /** Application Audience (AUD) Tag */
  aud: string;
}

/**
 * Valida un JWT de Cloudflare Access: firma RS256 con las claves públicas del equipo, exp y nbf (con margen),
 * iss = https://<equipo> y aud que contenga el AUD de la aplicación. Lanza si no se pueden obtener las claves.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig, now: number = Date.now()): Promise<AccessVerdict> {
  const fail = (status: 401 | 403, reason: string): AccessVerdict => ({ ok: false, status, reason });
  const team = teamHost(config.teamDomain);
  if (!team || !config.aud) throw new Error('Access: ACCESS_TEAM_DOMAIN o ACCESS_AUD no son válidos');

  const parts = token.split('.');
  if (parts.length !== 3) return fail(401, 'formato');
  const [h, p, s] = parts as [string, string, string];
  const header = base64UrlJson(h);
  // Solo RS256: nunca se acepta el algoritmo que proponga el token ("none", HS256…).
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return fail(401, 'cabecera');

  const key = await signingKey(team, header.kid, now);
  if (!key) return fail(401, 'clave desconocida');

  let signature: Uint8Array;
  try {
    signature = base64UrlBytes(s);
  } catch {
    return fail(401, 'firma ilegible');
  }
  const valid = await crypto.subtle.verify(RS256.name, key, signature, encoder.encode(`${h}.${p}`));
  if (!valid) return fail(401, 'firma');

  // A partir de aquí el contenido es de Access; antes no se confía en nada de lo que diga.
  const claims = base64UrlJson(p);
  if (!claims) return fail(401, 'contenido');
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || seconds > claims.exp + LEEWAY_S) return fail(401, 'caducado');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || seconds < claims.nbf - LEEWAY_S)) return fail(401, 'aún no válido');
  if (claims.iss !== `https://${team}`) return fail(403, 'emisor');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.aud)) return fail(403, 'audiencia');
  return { ok: true, claims };
}

/**
 * Exige el JWT de Access (cabecera Cf-Access-Jwt-Assertion) cuando la validación está configurada.
 * Con una sola de las dos variables puesta se considera un error de configuración y se rechaza todo (500),
 * en vez de dejar la API abierta sin que nadie lo note.
 */
export const accessAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = c.env.ACCESS_AUD?.trim();
  if (!teamDomain && !aud) return next();
  if (!teamDomain || !aud) throw new Error('Access: hay que definir ACCESS_TEAM_DOMAIN y ACCESS_AUD juntas');

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return deny(c, 401, 'unauthorized', 'The Cloudflare Access session is missing.');
  const verdict = await verifyAccessJwt(token, { teamDomain, aud });
  if (!verdict.ok) {
    return verdict.status === 401
      ? deny(c, 401, 'unauthorized', 'The Cloudflare Access session is invalid or has expired.')
      : deny(c, 403, 'forbidden', 'The Cloudflare Access session is not for this application.');
  }
  await next();
};
