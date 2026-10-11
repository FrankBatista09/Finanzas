// API authentication.
//   · /api/ingest/* and /mcp : Authorization: Bearer <API_TOKEN> (used by Claude; they stay outside Cloudflare Access).
//   · rest of /api/*         : Cloudflare Access in front of the site. If ACCESS_TEAM_DOMAIN and ACCESS_AUD are
//                              configured, its JWT is also validated here; if not, requests are let through (local development).

import type { Context, MiddlewareHandler } from 'hono';
import type { ApiErrorCode } from '../shared/api';
import type { Env } from './env';
import { errorBody } from './errors';

export type AuthEnv = {
  Bindings: Env;
  Variables: {
    /** true when the request was already authenticated with the Bearer (it does not go through Access as well). */
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
 * Compares in constant time: the SHA-256 digests (always the same length) are compared byte by byte, without exiting
 * at the first difference, so the response time does not reveal how much of the token is correct.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

/** true only if the request carries `Authorization: Bearer <API_TOKEN>`. With no API_TOKEN configured, always false. */
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

/** Access signing keys rotate every few weeks; a one-hour cache is plenty. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` forces the keys to be fetched again, but no more than once a minute (keeps junk tokens from causing one request each). */
const JWKS_REFETCH_MIN_MS = 60 * 1000;
/** Leeway for clock skew when checking exp and nbf. */
const LEEWAY_S = 60;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

interface Jwks {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const jwksCache = new Map<string, Jwks>();

/** Empties the key cache (for the tests). */
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
      // Only n and e: the use and the algorithm are set by this code, not by whatever the document says.
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, RS256, false, ['verify']);
      keys.set(jwk.kid, key);
    } catch {
      // One unreadable key does not invalidate the others.
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
      // If Access does not respond and keys are cached, they keep being used; without a cache there is no way to validate.
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

/** 'https://Team.cloudflareaccess.com/' → 'team.cloudflareaccess.com'; null if it is not a host name. */
function teamHost(value: string): string | null {
  const host = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

export type AccessVerdict =
  | { ok: true; claims: Record<string, unknown> }
  /** 401: no valid identity (unreadable token, bad signature, expired). 403: there is one, but not for this application. */
  | { ok: false; status: 401 | 403; reason: string };

export interface AccessConfig {
  /** 'your-team.cloudflareaccess.com' */
  teamDomain: string;
  /** Application Audience (AUD) Tag */
  aud: string;
}

/**
 * Validates a Cloudflare Access JWT: RS256 signature with the team's public keys, exp and nbf (with leeway),
 * iss = https://<team> and an aud that contains the application's AUD. Throws if the keys cannot be fetched.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig, now: number = Date.now()): Promise<AccessVerdict> {
  const fail = (status: 401 | 403, reason: string): AccessVerdict => ({ ok: false, status, reason });
  const team = teamHost(config.teamDomain);
  if (!team || !config.aud) throw new Error('Access: ACCESS_TEAM_DOMAIN o ACCESS_AUD no son válidos');

  const parts = token.split('.');
  if (parts.length !== 3) return fail(401, 'formato');
  const [h, p, s] = parts as [string, string, string];
  const header = base64UrlJson(h);
  // RS256 only: the algorithm the token proposes ("none", HS256…) is never accepted.
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

  // From here on the payload comes from Access; before this point nothing it says is trusted.
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
 * Requires the Access JWT (Cf-Access-Jwt-Assertion header) when validation is configured.
 * With only one of the two variables set, it is treated as a configuration error and everything is rejected (500),
 * instead of leaving the API open without anyone noticing.
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
