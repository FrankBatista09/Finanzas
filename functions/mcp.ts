// Pages Function que atiende /mcp (el servidor MCP remoto que usa Claude). Vive en server/mcp.ts para poder probarlo sin wrangler.
import type { Env } from '../server/env';
import { handleMcp } from '../server/mcp';

export const onRequest: PagesFunction<Env> = (context) => handleMcp(context.request, context.env);
