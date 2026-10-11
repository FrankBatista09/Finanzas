// Bounded read of a request body. Shared by the API (server/app.ts) and the MCP server
// (server/mcp.ts); each one decides how to respond when the body goes over the limit.

/**
 * Reads the body without going past `maxBytes`: stops as soon as it is exceeded, without relying on Content-Length alone.
 * Returns null if it is too large.
 */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
