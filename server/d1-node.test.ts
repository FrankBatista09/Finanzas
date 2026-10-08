// El adaptador de pruebas tiene que comportarse como D1 en lo que el resto de las pruebas da por hecho.

import { describe, expect, it } from 'vitest';
import { asD1, createTestDb, D1_MAX_BOUND_PARAMS } from './d1-node';

function setup() {
  const sqlite = createTestDb();
  return { sqlite, db: asD1(sqlite) };
}

/** Dos metas de un usuario, para las pruebas que necesitan filas. */
async function withGoals() {
  const t = setup();
  await t.db
    .prepare("INSERT INTO goals (user_id, id, name, sort) VALUES ('frank', 'emergency', 'Emergency fund', 0), ('frank', 'personal', 'Personal savings', 1)")
    .run();
  return t;
}

describe('adaptador D1 sobre node:sqlite', () => {
  it('aplica las migraciones: todas las tablas creadas, con user_id y vacías (los datos iniciales los pone el servidor)', async () => {
    const { db } = setup();
    // Tabla → cuántas columnas tiene su clave primaria (el usuario más lo que la identifica dentro de él).
    const tables: Record<string, number> = {
      months: 2,
      accounts: 2,
      month_budgets: 3,
      month_rates: 4,
      fixed_expenses: 2,
      transactions: 2,
      transfers: 2,
      incomes: 2,
      goals: 2,
      contributions: 2,
      settings: 2,
    };
    for (const [table, keyColumns] of Object.entries(tables)) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>(), table).toEqual({ n: 0 });
      const columns = await db.prepare(`SELECT name, pk FROM pragma_table_info('${table}') ORDER BY cid`).all<{ name: string; pk: number }>();
      // user_id es la primera columna y la primera parte de la clave primaria.
      expect(columns.results[0], table).toEqual({ name: 'user_id', pk: 1 });
      expect(columns.results.filter((c) => c.pk > 0), table).toHaveLength(keyColumns);
    }
    // No hay más tablas que esas: si la migración gana una, esta prueba y el repositorio tienen que enterarse.
    const all = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
    expect(all.results.map((r) => r.name)).toEqual(Object.keys(tables).sort());
  });

  it('first() da null sin filas; con nombre de columna da solo ese valor', async () => {
    const { db } = await withGoals();
    expect(await db.prepare('SELECT * FROM months WHERE key = ?').bind('2026-10').first()).toBeNull();
    expect(await db.prepare('SELECT * FROM months WHERE key = ?').bind('2026-10').first('key')).toBeNull();
    expect(await db.prepare('SELECT name FROM goals WHERE id = ?').bind('emergency').first('name')).toBe('Emergency fund');
    await expect(db.prepare('SELECT name FROM goals').first('nope')).rejects.toThrow(/D1_ERROR/);
  });

  it('all() y run() dan { results, success, meta } con meta.changes', async () => {
    const { db } = setup();
    const insert = await db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', ?), ('frank', ?)").bind('2026-09', '2026-10').run();
    expect(insert.success).toBe(true);
    expect(insert.results).toEqual([]);
    expect(insert.meta.changes).toBe(2);
    expect(insert.meta.changed_db).toBe(true);

    const select = await db.prepare('SELECT key, closed FROM months ORDER BY key').all();
    expect(select.results).toEqual([
      { key: '2026-09', closed: 0 },
      { key: '2026-10', closed: 0 },
    ]);
    expect(select.meta.changes).toBe(0);

    const returning = await db.prepare('UPDATE months SET closed = 1 WHERE key = ? RETURNING key, closed').bind('2026-09').all();
    expect(returning.results).toEqual([{ key: '2026-09', closed: 1 }]);
    expect(returning.meta.changes).toBe(1);
  });

  it('raw() da arreglos, con los nombres de columna si se piden', async () => {
    const { db } = await withGoals();
    expect(await db.prepare('SELECT id, sort FROM goals ORDER BY sort LIMIT 2').raw()).toEqual([
      ['emergency', 0],
      ['personal', 1],
    ]);
    expect(await db.prepare('SELECT id, sort FROM goals ORDER BY sort LIMIT 1').raw({ columnNames: true })).toEqual([
      ['id', 'sort'],
      ['emergency', 0],
    ]);
  });

  it('?NNN reutiliza el mismo valor y los booleanos se guardan como 0/1', async () => {
    const { db } = setup();
    expect(await db.prepare('SELECT ?1 AS a, ?1 AS b, ?2 AS c').bind('x', true).first()).toEqual({ a: 'x', b: 'x', c: 1 });
  });

  it('rechaza undefined y más de 100 parámetros, como D1', async () => {
    const { db } = setup();
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    const many = Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => i);
    await expect(db.prepare(`SELECT ${many.map(() => '?').join(' + ')}`).bind(...many).first()).rejects.toThrow(/too many SQL variables/);
    const ok = many.slice(1);
    await expect(db.prepare(`SELECT ${ok.map(() => '?').join(' + ')} AS n`).bind(...ok).first('n')).resolves.toBe(5050);
  });

  it('los errores de SQLite salen con el formato de D1 y solo al ejecutar', async () => {
    const { db } = setup();
    const bad = db.prepare('SELEC 1');
    await expect(bad.run()).rejects.toThrow(/^D1_ERROR: .*SQLITE_ERROR$/);
    const insert = (user: string) => db.prepare('INSERT INTO months (user_id, key) VALUES (?, ?)').bind(user, '2026-10').run();
    await insert('frank');
    await expect(insert('frank')).rejects.toThrow('D1_ERROR: UNIQUE constraint failed: months.user_id, months.key: SQLITE_CONSTRAINT');
    // La clave es (user_id, key): el mismo mes de otro usuario no choca.
    await expect(insert('eda')).resolves.toMatchObject({ success: true });
  });

  it('las claves foráneas están activas e incluyen al usuario', async () => {
    const { db } = setup();
    const account = (user: string, id: string) =>
      db.prepare("INSERT INTO accounts (user_id, id, name, currency) VALUES (?, ?, 'x', 'USD')").bind(user, id).run();
    const transfer = (user: string) =>
      db
        .prepare(
          "INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate) VALUES (?, 't', '2026-10', '2026-10-01', 'Remitly', 'a', 'b', 1, 1)",
        )
        .bind(user)
        .run();
    await account('eda', 'a');
    await account('eda', 'b');
    await account('frank', 'a');
    await expect(transfer('frank')).rejects.toThrow(/FOREIGN KEY constraint failed/);
    // Que el mes exista para otro usuario no basta: una fila no puede colgar del mes de otro.
    await db.prepare("INSERT INTO months (user_id, key) VALUES ('eda', '2026-10'), ('frank', '2026-10')").run();
    // Ni de la cuenta de otro: a Frank le falta la cuenta 'b', que Eda sí tiene.
    await expect(transfer('frank')).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(transfer('eda')).resolves.toMatchObject({ success: true });
    // Una cuenta con filas que la nombran no se puede borrar…
    await expect(db.prepare("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'a'").run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
    // …y borrar el mes se lleva sus filas (ON DELETE CASCADE), solo las de ese usuario.
    await db.prepare("DELETE FROM months WHERE user_id = 'eda' AND key = '2026-10'").run();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM transfers').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM months').first('n')).toBe(1);
    await expect(db.prepare("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'a'").run()).resolves.toMatchObject({ success: true });
  });

  it('la base rechaza lo que el modelo no admite: otra moneda, una tasa que no sea mayor que 0 o un envío a la misma cuenta', async () => {
    const { db } = setup();
    await db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', '2026-10')").run();
    await db.prepare("INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'a', 'x', 'TRY')").run();
    const failing = [
      "INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'b', 'x', 'EUR')",
      "INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, rate) VALUES ('frank', '2026-10', 'USD', 'DOP', 0)",
      "INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, rate) VALUES ('frank', '2026-10', 'USD', 'USD', 1)",
      "INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate) VALUES ('frank', 't', '2026-10', '2026-10-01', 'x', 'a', 'a', 1, 1)",
    ];
    for (const sql of failing) await expect(db.prepare(sql).run(), sql).rejects.toThrow(/CHECK constraint failed.*SQLITE_CONSTRAINT/);
  });

  it('batch() es una transacción: si una sentencia falla no queda nada', async () => {
    const { db } = setup();
    await expect(
      db.batch([
        db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', ?)").bind('2026-10'),
        db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', ?)").bind('2026-10'),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM months').first('n')).toBe(0);

    const out = await db.batch([
      db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', ?)").bind('2026-10'),
      db.prepare('SELECT key FROM months'),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]!.results).toEqual([{ key: '2026-10' }]);
  });

  it('no admite BEGIN/COMMIT escritos a mano', async () => {
    const { db } = setup();
    await expect(db.prepare('BEGIN').run()).rejects.toThrow(/D1_ERROR/);
    await expect(db.prepare('  savepoint x').run()).rejects.toThrow(/D1_ERROR/);
  });

  it('exec() ejecuta una sentencia por línea', async () => {
    const { db } = setup();
    const res = await db.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-09')\nINSERT INTO months (user_id, key) VALUES ('frank', '2026-10')\n");
    expect(res.count).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM months').first('n')).toBe(2);
  });
});
