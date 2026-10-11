// Pages Function that serves all of /api/*. The app lives in server/app.ts so it can be tested without wrangler.
import { handle } from 'hono/cloudflare-pages';
import { createApp } from '../../server/app';

export const onRequest = handle(createApp());
