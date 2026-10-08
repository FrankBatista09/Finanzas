import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import type { Env } from '../../server/env';

const app = new Hono<{ Bindings: Env }>().basePath('/api');

app.get('/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM goals').first<{ n: number }>();
  return c.json({ ok: true, goals: row?.n ?? 0 });
});

export const onRequest = handle(app);
