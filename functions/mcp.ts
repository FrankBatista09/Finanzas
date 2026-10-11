// Pages Function that serves /mcp (the remote MCP server Claude uses). It lives in server/mcp.ts so it can be tested without wrangler.
import type { Env } from '../server/env';
import { handleMcp } from '../server/mcp';

export const onRequest: PagesFunction<Env> = (context) => handleMcp(context.request, context.env);
