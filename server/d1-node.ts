// SOLO PARA PRUEBAS. Expone la superficie de D1Database que usa server/ sobre el SQLite que trae Node
// (node:sqlite), para probar el repositorio y las rutas sin levantar wrangler. No se importa desde functions/.
//
// Imita a D1 en lo que afecta a las pruebas:
//   · claves foráneas activas;
//   · batch() es una transacción: si una sentencia falla, no queda nada escrito;
//   · como mucho 100 parámetros por sentencia, `undefined` no se puede enlazar y los booleanos pasan a 0/1;
//   · first() da null si no hay fila; all()/run() dan { results, success, meta } con meta.changes;
//   · no admite BEGIN/COMMIT/SAVEPOINT escritos a mano;
//   · los errores de SQLite salen como "D1_ERROR: <mensaje>: SQLITE_…".
// Diferencia conocida: en sentencias con RETURNING, meta.changes cuenta también las filas tocadas por
// acciones de clave foránea (ON DELETE CASCADE).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** Límite de D1 (el de SQLite es mucho mayor): hay que respetarlo al armar INSERT multi-fila. */
export const D1_MAX_BOUND_PARAMS = 100;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TX_CONTROL_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

type Row = Record<string, unknown>;

function d1Error(err: unknown): Error {
  if (err instanceof Error && err.message.startsWith('D1_')) return err;
  const message = err instanceof Error ? err.message : String(err);
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  // El código primario de SQLite va en el byte bajo del código extendido; 19 = SQLITE_CONSTRAINT.
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
  /** La base de node:sqlite, por si una prueba necesita mirar o preparar algo sin pasar por la API de D1. */
  readonly sqlite: DatabaseSync;

  constructor(sqlite: DatabaseSync = new DatabaseSync(':memory:')) {
    this.sqlite = sqlite;
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(query: string): NodeD1Statement {
    // Como en D1, la sentencia no se compila hasta ejecutarla: un SQL inválido falla en run()/all()/first().
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

  /** Como en D1: una sentencia por línea, sin parámetros. */
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
        // SELECT o escritura con RETURNING: node:sqlite no da `changes` junto con las filas.
        const before = this.counters();
        // Copia a objetos normales (node:sqlite los crea sin prototipo; D1 los entrega como JSON).
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

/** Para pasar el adaptador donde se espera el binding (env.DB). */
export function asD1(db: NodeD1Database): D1Database {
  return db as unknown as D1Database;
}

/** Los archivos de migrations/*.sql, en el orden en que se aplican. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Aplica esos archivos de migración, en orden. Como en D1, cada uno va en su propia transacción y con las
 * claves foráneas activas: `PRAGMA defer_foreign_keys = true` las difiere hasta el final del archivo.
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
 * Base en memoria recién creada con las migraciones de migrations/*.sql aplicadas, en orden: todas, o solo las
 * que se indiquen (para probar una migración sobre una base que se quedó en una anterior).
 */
export function createTestDb(files: readonly string[] = migrationFiles()): NodeD1Database {
  const db = new NodeD1Database();
  applyMigrations(db, files);
  return db;
}
