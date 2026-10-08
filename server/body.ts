// Lectura acotada del cuerpo de una petición. La comparten la API (server/app.ts) y el servidor MCP
// (server/mcp.ts); cada uno decide cómo responde cuando el cuerpo se pasa del tope.

/**
 * Lee el cuerpo sin pasar de `maxBytes`: corta en cuanto se excede, sin fiarse solo de Content-Length.
 * Devuelve null si es demasiado grande.
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
