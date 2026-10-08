// Pages Function que atiende todo /api/*. La app vive en server/app.ts para poder probarla sin wrangler.
import { handle } from 'hono/cloudflare-pages';
import { createApp } from '../../server/app';

export const onRequest = handle(createApp());
