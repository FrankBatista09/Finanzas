/** Bindings and variables of the Pages project (wrangler.toml, .dev.vars and secrets). */
export interface Env {
  DB: D1Database;
  /**
   * Users of the app: comma-separated `id:Name` pairs, e.g. "frank:Frank,eda:Eda" (shared/users.ts).
   * Each one has their own separate finances. When undefined, there is a single user.
   */
  USERS?: string;
  /** Secret. Bearer token that authorizes /api/ingest/* and /mcp. Without it, those routes always respond 401. */
  API_TOKEN?: string;
  /** Optional: 'your-team.cloudflareaccess.com'. Together with ACCESS_AUD it turns on Access JWT validation on /api/*. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Optional: Application Audience (AUD) Tag of the Access application. */
  ACCESS_AUD?: string;
  /** '1' enables /api/dev/* (local development only). */
  ALLOW_DEV_RESET?: string;
}
