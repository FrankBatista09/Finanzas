import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBearer, clearAccessKeyCache, verifyAccessJwt } from './auth';
import type { Env } from './env';
import { client, makeEnv, TOKEN } from './test-util';

const TEAM = 'equipo.cloudflareaccess.com';
const AUD = 'aud-de-la-aplicacion-1234567890abcdef';
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: Record<string, unknown>;
}

async function newKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  // Como el documento real de Access: kid, kty, alg, use, e, n.
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

const b64url = (data: string | ArrayBuffer): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const nowS = () => Math.floor(Date.now() / 1000);

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: `https://${TEAM}`, aud: [AUD], email: 'yo@example.com', iat: nowS(), nbf: nowS(), exp: nowS() + 3600, ...over };
}

async function sign(key: SigningKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header }));
  const body = b64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(RS256.name, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(signature)}`;
}

let key: SigningKey;
let other: SigningKey;
let published: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;

beforeAll(async () => {
  key = await newKey('kid-1');
  // Mismo kid, otra clave: para probar una firma que no corresponde.
  other = await newKey('kid-1');
});

beforeEach(() => {
  clearAccessKeyCache();
  published = [key.jwk];
  fetchMock = vi.fn(async (url: string) => {
    if (String(url) !== CERTS_URL) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ keys: published, public_cert: { kid: 'x', cert: '...' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const accessEnv: Partial<Env> = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const jwt = (token: string) => ({ 'Cf-Access-Jwt-Assertion': token });

describe('checkBearer', () => {
  const request = (authorization?: string) =>
    new Request('https://app.example/mcp', authorization === undefined ? {} : { headers: { Authorization: authorization } });

  it('true solo con el token exacto', async () => {
    const env = { API_TOKEN: TOKEN };
    expect(await checkBearer(request(`Bearer ${TOKEN}`), env)).toBe(true);
    expect(await checkBearer(request(`bearer   ${TOKEN}`), env)).toBe(true);
    expect(await checkBearer(request(), env)).toBe(false);
    expect(await checkBearer(request(TOKEN), env)).toBe(false);
    expect(await checkBearer(request(`Bearer ${TOKEN}0`), env)).toBe(false);
    expect(await checkBearer(request(`Bearer ${TOKEN.toUpperCase()}`), env)).toBe(false);
    expect(await checkBearer(request('Bearer'), env)).toBe(false);
  });

  it('sin API_TOKEN nunca autoriza', async () => {
    expect(await checkBearer(request('Bearer '), {})).toBe(false);
    expect(await checkBearer(request('Bearer undefined'), {})).toBe(false);
    expect(await checkBearer(request(`Bearer ${TOKEN}`), { API_TOKEN: '' })).toBe(false);
  });
});

describe('accessAuth', () => {
  it('sin configurar deja pasar (desarrollo local) y no pide claves', async () => {
    const { env } = makeEnv();
    expect((await client(env).get('/api/state')).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un JWT válido pasa; las claves se piden una sola vez', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const token = await sign(key, claims());
    expect((await api.get('/api/state', jwt(token))).status).toBe(200);
    expect((await api.get('/api/goals', jwt(token))).status).toBe(200);
    expect((await api.post('/api/goals', { name: 'Carro' }, jwt(token))).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(CERTS_URL);
  });

  it('la sesión de Access no dice de quién son los datos: eso lo elige X-User, y se mira después de autenticar', async () => {
    const { env } = makeEnv(accessEnv);
    const anonymous = client(env, null);
    const token = await sign(key, claims());
    // Sin sesión, ni la lista de usuarios ni el aviso de que falta la cabecera: 401 a secas.
    for (const r of [await anonymous.get('/api/session'), await anonymous.get('/api/state'), await client(env, 'pedro').get('/api/state')]) {
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.body)).not.toContain('frank');
    }
    // Con sesión: /api/session no pide X-User, el resto sí, y la misma sesión vale para cualquiera de los usuarios.
    expect((await anonymous.get<{ users: unknown[] }>('/api/session', jwt(token))).body.users).toHaveLength(2);
    const missing = await anonymous.get('/api/state', jwt(token));
    expect(missing.status).toBe(400);
    expect(missing.error?.code).toBe('validation');
    expect((await client(env, 'eda').get<{ user: { id: string } }>('/api/state', jwt(token))).body.user.id).toBe('eda');
    expect((await client(env, 'frank').get<{ user: { id: string } }>('/api/state', jwt(token))).body.user.id).toBe('frank');
  });

  it('acepta el dominio escrito con https:// y aud como texto', async () => {
    const { env } = makeEnv({ ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: AUD });
    const token = await sign(key, claims({ aud: AUD }));
    expect((await client(env).get('/api/state', jwt(token))).status).toBe(200);
  });

  it('sin cabecera: 401', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    for (const r of [await api.get('/api/state'), await api.post('/api/goals', { name: 'x' }), await api.get('/api/nada')]) {
      expect(r.status).toBe(401);
      expect(r.error).toEqual({ code: 'unauthorized', message: 'The Cloudflare Access session is missing.' });
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caducado: 401 (con un minuto de margen)', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const expired = await api.get('/api/state', jwt(await sign(key, claims({ exp: nowS() - 120 }))));
    expect(expired.status).toBe(401);
    expect(expired.error).toEqual({ code: 'unauthorized', message: 'The Cloudflare Access session is invalid or has expired.' });
    expect((await api.get('/api/state', jwt(await sign(key, claims({ exp: nowS() - 20 }))))).status).toBe(200);
    expect((await api.get('/api/state', jwt(await sign(key, claims({ exp: undefined }))))).status).toBe(401);
    expect((await api.get('/api/state', jwt(await sign(key, claims({ exp: '9999999999' }))))).status).toBe(401);
  });

  it('todavía no válido (nbf): 401', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    expect((await api.get('/api/state', jwt(await sign(key, claims({ nbf: nowS() + 600 }))))).status).toBe(401);
    expect((await api.get('/api/state', jwt(await sign(key, claims({ nbf: nowS() + 20 }))))).status).toBe(200);
  });

  it('aud de otra aplicación: 403', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    for (const aud of [['otra-app'], 'otra-app', [], undefined, [`${AUD}x`]]) {
      const r = await api.get('/api/state', jwt(await sign(key, claims({ aud }))));
      expect(r.status, JSON.stringify(aud)).toBe(403);
      expect(r.error).toEqual({ code: 'forbidden', message: 'The Cloudflare Access session is not for this application.' });
    }
    expect((await api.get('/api/state', jwt(await sign(key, claims({ aud: ['otra-app', AUD] }))))).status).toBe(200);
  });

  it('emisor distinto: 403', async () => {
    const { env } = makeEnv(accessEnv);
    const r = await client(env).get('/api/state', jwt(await sign(key, claims({ iss: 'https://otro.cloudflareaccess.com' }))));
    expect(r.status).toBe(403);
  });

  it('firma que no corresponde o contenido manipulado: 401', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const forged = await api.get('/api/state', jwt(await sign(other, claims())));
    expect(forged.status).toBe(401);
    expect(forged.error?.code).toBe('unauthorized');

    const good = await sign(key, claims({ aud: ['otra-app'] }));
    const [head, , signature] = good.split('.');
    const tampered = `${head}.${b64url(JSON.stringify(claims()))}.${signature}`;
    expect((await api.get('/api/state', jwt(tampered))).status).toBe(401);
    expect((await api.get('/api/state', jwt(`${good.slice(0, -4)}AAAA`))).status).toBe(401);
  });

  it('tokens ilegibles o con otro algoritmo: 401', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const good = await sign(key, claims());
    const [, body, signature] = good.split('.');
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: key.kid }))}.${body}.`;
    const hs256 = `${b64url(JSON.stringify({ alg: 'HS256', kid: key.kid }))}.${body}.${signature}`;
    const noKid = `${b64url(JSON.stringify({ alg: 'RS256' }))}.${body}.${signature}`;
    for (const token of ['x', 'a.b', 'a.b.c', 'a.b.c.d', `${good}.x`, none, hs256, noKid, `!!.${body}.${signature}`]) {
      const r = await api.get('/api/state', jwt(token));
      expect(r.status, token.slice(0, 30)).toBe(401);
    }
  });

  it('kid desconocido: 401, sin pedir las claves en cada intento', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const stranger = await newKey('kid-desconocido');
    const token = await sign(stranger, claims());
    expect((await api.get('/api/state', jwt(token))).status).toBe(401);
    expect((await api.get('/api/state', jwt(token))).status).toBe(401);
    expect((await api.get('/api/state', jwt(token))).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rotación de claves: un kid nuevo hace que se vuelvan a pedir (una vez)', async () => {
    const config = { teamDomain: TEAM, aud: AUD };
    const t0 = Date.now();
    expect((await verifyAccessJwt(await sign(key, claims()), config, t0)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Access publica una clave nueva y empieza a firmar con ella.
    const rotated = await newKey('kid-2');
    published = [key.jwk, rotated.jwk];
    const token = await sign(rotated, claims());
    // Dentro del minuto de espera todavía no se vuelve a pedir.
    expect(await verifyAccessJwt(token, config, t0 + 10_000)).toMatchObject({ ok: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const later = await verifyAccessJwt(token, config, t0 + 120_000);
    expect(later.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Ya en caché: ni la nueva ni la anterior provocan más peticiones.
    expect((await verifyAccessJwt(token, config, t0 + 130_000)).ok).toBe(true);
    expect((await verifyAccessJwt(await sign(key, claims()), config, t0 + 130_000)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('la caché de claves caduca', async () => {
    const config = { teamDomain: TEAM, aud: AUD };
    const t0 = Date.now();
    const token = await sign(key, claims({ exp: nowS() + 3 * 3600 }));
    await verifyAccessJwt(token, config, t0);
    await verifyAccessJwt(token, config, t0 + 59 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await verifyAccessJwt(token, config, t0 + 61 * 60 * 1000)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('devuelve los datos de la sesión cuando es válida', async () => {
    const verdict = await verifyAccessJwt(await sign(key, claims()), { teamDomain: TEAM, aud: AUD });
    expect(verdict).toMatchObject({ ok: true, claims: { email: 'yo@example.com' } });
  });

  it('si no se pueden obtener las claves no se deja pasar (500) y no se filtra el motivo', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response('caído', { status: 503 }));
    const { env } = makeEnv(accessEnv);
    const r = await client(env).get('/api/state', jwt(await sign(key, claims())));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'internal', message: 'Internal server error.' } });
    expect(log).toHaveBeenCalled();
  });

  it('si Access deja de responder se sigue con las claves que ya había', async () => {
    const config = { teamDomain: TEAM, aud: AUD };
    const t0 = Date.now();
    const token = await sign(key, claims({ exp: nowS() + 3 * 3600 }));
    await verifyAccessJwt(token, config, t0);
    fetchMock.mockImplementation(async () => {
      throw new Error('sin red');
    });
    expect((await verifyAccessJwt(token, config, t0 + 2 * 3600 * 1000)).ok).toBe(true);
  });

  it('con una sola de las dos variables no se abre la API: 500', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const extra of [{ ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }, { ACCESS_TEAM_DOMAIN: 'no es un host', ACCESS_AUD: AUD }]) {
      const { env } = makeEnv(extra);
      const r = await client(env).get('/api/state', jwt(await sign(key, claims())));
      expect(r.status, JSON.stringify(extra)).toBe(500);
      expect(r.error?.code).toBe('internal');
    }
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('/api/ingest/* no pasa por Access: usa el Bearer', async () => {
    const { env } = makeEnv(accessEnv);
    const api = client(env);
    const body = { user: 'frank', description: 'Uber', amount: 850 };
    expect((await api.post('/api/ingest/transaction', body, { Authorization: `Bearer ${TOKEN}` })).status).toBe(201);
    // Y al revés: ni la sesión de Access sirve para ingest, ni el Bearer para el resto de la API.
    expect((await api.post('/api/ingest/transaction', body, jwt(await sign(key, claims())))).status).toBe(401);
    expect((await api.get('/api/state', { Authorization: `Bearer ${TOKEN}` })).status).toBe(401);
    expect((await api.post('/api/dev/reset', undefined, { Authorization: `Bearer ${TOKEN}` })).status).toBe(401);
  });
});
