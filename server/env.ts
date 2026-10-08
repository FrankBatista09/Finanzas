/** Bindings y variables del proyecto de Pages (wrangler.toml, .dev.vars y secrets). */
export interface Env {
  DB: D1Database;
  /**
   * Usuarios de la app: pares `id:Nombre` separados por comas, p. ej. "frank:Frank,eda:Eda" (shared/users.ts).
   * Cada uno tiene sus finanzas aparte. Sin definir, hay un solo usuario.
   */
  USERS?: string;
  /** Secret. Bearer que autoriza /api/ingest/* y /mcp. Sin él, esas rutas responden 401 siempre. */
  API_TOKEN?: string;
  /** Opcional: 'tu-equipo.cloudflareaccess.com'. Junto con ACCESS_AUD activa la validación del JWT de Access en /api/*. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Opcional: Application Audience (AUD) Tag de la aplicación de Access. */
  ACCESS_AUD?: string;
  /** '1' habilita /api/dev/* (solo desarrollo local). */
  ALLOW_DEV_RESET?: string;
}
