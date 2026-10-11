// FOR TESTS ONLY. Exposes the D1Database surface that server/ uses, on top of the SQLite that ships with Node
// (node:sqlite), to test the repository and the routes without starting wrangler. It is not imported from functions/.
//
// It mimics D1 in the ways that affect the tests:
//   · foreign keys enabled;
//   · batch() is a transaction: if one statement fails, nothing stays written;
//   · at most 100 parameters per statement, `undefined` cannot be bound and booleans become 0/1;
//   · first() returns null when there is no row; all()/run() return { results, success, meta } with meta.changes;
//   · it does not accept hand-written BEGIN/COMMIT/SAVEPOINT;
//   · SQLite errors come out as "D1_ERROR: <message>: SQLITE_…".
// Known difference: in statements with RETURNING, meta.changes also counts the rows touched by
// foreign key actions (ON DELETE CASCADE).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** D1's limit (SQLite's is much higher): it must be respected when building multi-row INSERTs. */
export const D1_MAX_BOUND_PARAMS = 100;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TX_CONTROL_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

type Row = Record<string, unknown>;

function d1Error(err: unknown): Error {
  if (err instanceof Error && err.message.startsWith('D1_')) return err;
  const message = err instanceof Error ? err.message : String(err);
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  // SQLite's primary code is in the low byte of the extended code; 19 = SQLITE_CONSTRAINT.
  const kind = typeof errcode === 'number' && (errcode & 0xff) === 19 ? 'SQLITE_CONSTRAINT' : 'SQLITE_ERROR';
  return new Error(`D1_ERROR: ${message}: ${kind}`, { cause: err });
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
  throw new Error(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

class NodeD1Statement {
  constructor(
    private readonly db: NodeD1Database,
    readonly sql: string,
    readonly params: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): NodeD1Statement {
    return new NodeD1Statement(this.db, this.sql, values.map(toSqlValue));
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Row>(): Promise<T | null>;
  async first<T>(colName?: string): Promise<T | null> {
    const row = this.db.execute<Row>(this).results[0];
    if (row === undefined) return null;
    if (colName === undefined) return row as T;
    if (!(colName in row)) throw new Error(`D1_ERROR: Column not found: ${colName}`);
    return row[colName] as T;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this);
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this);
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const { columns, rows } = this.db.executeRaw(this);
    return options?.columnNames ? [columns, ...(rows as T[])] : (rows as T[]);
  }
}

export class NodeD1Database {
  /** The node:sqlite database, in case a test needs to inspect or set up something without going through the D1 API. */
  readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync = new DatabaseSync(':memory:')) {
    this.sqlite = sqlite;
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(query: string): NodeD1Statement {
    // As in D1, the statement is not compiled until it runs: invalid SQL fails in run()/all()/first().
    return new NodeD1Statement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => this.execute<T>(s as unknown as NodeD1Statement));
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  /** As in D1: one statement per line, without parameters. */
  async exec(query: string): Promise<D1ExecResult> {
    const started = performance.now();
    let count = 0;
    for (const line of query.split('\n')) {
      if (!line.trim()) continue;
      this.execute(new NodeD1Statement(this, line));
      count++;
    }
    return { count, duration: performance.now() - started };
  }

  withSession(): D1DatabaseSession {
    throw new Error('NodeD1Database: withSession() no está soportado');
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('NodeD1Database: dump() no está soportado');
  }

  close(): void {
    this.sqlite.close();
  }

  /** @internal */
  execute<T>(stmt: NodeD1Statement): D1Result<T> {
    const started = performance.now();
    try {
      const st = this.compile(stmt);
      let results: T[] = [];
      let changes: number;
      let lastRowId: number;
      if (st.columns().length > 0) {
        // SELECT or a write with RETURNING: node:sqlite does not give `changes` along with the rows.
        const before = this.counters();
        // Copy to plain objects (node:sqlite creates them without a prototype; D1 delivers them as JSON).
        results = st.all(...stmt.params).map((row) => ({ ...row })) as T[];
        const after = this.counters();
        changes = after.total - before.total;
        lastRowId = after.rowid;
      } else {
        const info = st.run(...stmt.params);
        changes = Number(info.changes);
        lastRowId = Number(info.lastInsertRowid);
      }
      return {
        results,
        success: true,
        meta: {
          duration: performance.now() - started,
          size_after: 0,
          rows_read: 0,
          rows_written: changes,
          last_row_id: lastRowId,
          changed_db: changes > 0,
          changes,
        },
      };
    } catch (err) {
      throw d1Error(err);
    }
  }

  /** @internal */
  executeRaw(stmt: NodeD1Statement): { columns: string[]; rows: unknown[][] } {
    try {
      const st = this.compile(stmt);
      const columns = st.columns().map((c) => c.name);
      st.setReturnArrays(true);
      const rows = st.all(...stmt.params) as unknown as unknown[][];
      return { columns, rows };
    } catch (err) {
      throw d1Error(err);
    }
  }

  private compile(stmt: NodeD1Statement) {
    if (TX_CONTROL_RE.test(stmt.sql)) {
      throw new Error('D1_ERROR: BEGIN/COMMIT/SAVEPOINT no están permitidos; usa db.batch(): SQLITE_ERROR');
    }
    if (stmt.params.length > D1_MAX_BOUND_PARAMS) {
      throw new Error('D1_ERROR: too many SQL variables: SQLITE_ERROR');
    }
    return this.sqlite.prepare(stmt.sql);
  }

  private counters(): { total: number; rowid: number } {
    const row = this.sqlite.prepare('SELECT total_changes() AS total, last_insert_rowid() AS rowid').get();
    return { total: Number(row?.total), rowid: Number(row?.rowid) };
  }
}

/** To pass the adapter where the binding (env.DB) is expected. */
export function asD1(db: NodeD1Database): D1Database {
  return db as unknown as D1Database;
}

/** The migrations/*.sql files, in the order they are applied. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Applies those migration files, in order. As in D1, each one runs in its own transaction and with
 * foreign keys enabled: `PRAGMA defer_foreign_keys = true` defers them until the end of the file.
 */
export function applyMigrations(db: NodeD1Database, files: readonly string[] = migrationFiles()): void {
  for (const file of files) {
    db.sqlite.exec('BEGIN');
    try {
      db.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.sqlite.exec('COMMIT');
    } catch (err) {
      db.sqlite.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Freshly created in-memory database with the migrations from migrations/*.sql applied, in order: all of them, or
 * only the given ones (to test a migration on a database that stopped at an earlier one).
 */
export function createTestDb(files: readonly string[] = migrationFiles()): NodeD1Database {
  const db = new NodeD1Database();
  applyMigrations(db, files);
  return db;
}
