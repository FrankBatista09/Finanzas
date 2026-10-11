// The test adapter has to behave like D1 in what the rest of the tests take for granted.

import { describe, expect, it } from 'vitest';
import { asD1, createTestDb, D1_MAX_BOUND_PARAMS } from './d1-node';

function setup() {
  const sqlite = createTestDb();
  return { sqlite, db: asD1(sqlite) };
}

/** Two goals of one user, for the tests that need rows. */
async function withGoals() {
  const t = setup();
  await t.db
    .prepare("INSERT INTO goals (user_id, id, name, sort) VALUES ('frank', 'emergency', 'Emergency fund', 0), ('frank', 'personal', 'Personal savings', 1)")
    .run();
  return t;
}

describe('D1 adapter over node:sqlite', () => {
  it('applies the migrations: all tables created, with user_id and empty (the server puts in the initial data)', async () => {
    const { db } = setup();
    // Table → how many columns its primary key has (the user plus what identifies it within that user).
    const tables: Record<string, number> = {
      months: 2,
      accounts: 2,
      month_budget_log: 2,
      month_rates: 5,
      fixed_expenses: 2,
      transactions: 2,
      outside_expenses: 2,
      card_payments: 2,
      credit_cards: 2,
      month_cards: 3,
      transfers: 2,
      incomes: 2,
      goals: 2,
      contributions: 2,
      settings: 2,
    };
    for (const [table, keyColumns] of Object.entries(tables)) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>(), table).toEqual({ n: 0 });
      const columns = await db.prepare(`SELECT name, pk FROM pragma_table_info('${table}') ORDER BY cid`).all<{ name: string; pk: number }>();
      // user_id is the first column and the first part of the primary key.
      expect(columns.results[0], table).toEqual({ name: 'user_id', pk: 1 });
      expect(columns.results.filter((c) => c.pk > 0), table).toHaveLength(keyColumns);
    }
    // There are no tables other than those: if the migration gains one, this test and the repository have to find out.
    const all = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
    expect(all.results.map((r) => r.name)).toEqual(Object.keys(tables).sort());
  });

  it('first() gives null with no rows; with a column name it gives only that value', async () => {
    const { db } = await withGoals();
    expect(await db.prepare('SELECT * FROM months WHERE key = ?').bind('2026-10').first()).toBeNull();
    expect(await db.prepare('SELECT * FROM months WHERE key = ?').bind('2026-10').first('key')).toBeNull();
    expect(await db.prepare('SELECT name FROM goals WHERE id = ?').bind('emergency').first('name')).toBe('Emergency fund');
    await expect(db.prepare('SELECT name FROM goals').first('nope')).rejects.toThrow(/D1_ERROR/);
  });

  it('all() and run() give { results, success, meta } with meta.changes', async () => {
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

  it('raw() gives arrays, with the column names if requested', async () => {
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

  it('?NNN reuses the same value and booleans are stored as 0/1', async () => {
    const { db } = setup();
    expect(await db.prepare('SELECT ?1 AS a, ?1 AS b, ?2 AS c').bind('x', true).first()).toEqual({ a: 'x', b: 'x', c: 1 });
  });

  it('rejects undefined and more than 100 parameters, like D1', async () => {
    const { db } = setup();
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    const many = Array.from({ length: D1_MAX_BOUND_PARAMS + 1 }, (_, i) => i);
    await expect(db.prepare(`SELECT ${many.map(() => '?').join(' + ')}`).bind(...many).first()).rejects.toThrow(/too many SQL variables/);
    const ok = many.slice(1);
    await expect(db.prepare(`SELECT ${ok.map(() => '?').join(' + ')} AS n`).bind(...ok).first('n')).resolves.toBe(5050);
  });

  it('SQLite errors come out in the D1 format and only on execution', async () => {
    const { db } = setup();
    const bad = db.prepare('SELEC 1');
    await expect(bad.run()).rejects.toThrow(/^D1_ERROR: .*SQLITE_ERROR$/);
    const insert = (user: string) => db.prepare('INSERT INTO months (user_id, key) VALUES (?, ?)').bind(user, '2026-10').run();
    await insert('frank');
    await expect(insert('frank')).rejects.toThrow('D1_ERROR: UNIQUE constraint failed: months.user_id, months.key: SQLITE_CONSTRAINT');
    // The key is (user_id, key): the same month of another user does not collide.
    await expect(insert('eda')).resolves.toMatchObject({ success: true });
  });

  it('foreign keys are on and include the user', async () => {
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
    // The month existing for another user is not enough: a row cannot hang off someone else's month.
    await db.prepare("INSERT INTO months (user_id, key) VALUES ('eda', '2026-10'), ('frank', '2026-10')").run();
    // Nor off someone else's account: Frank lacks account 'b', which Eda does have.
    await expect(transfer('frank')).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(transfer('eda')).resolves.toMatchObject({ success: true });
    // An account with rows that name it cannot be deleted…
    await expect(db.prepare("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'a'").run()).rejects.toThrow(/FOREIGN KEY constraint failed/);
    // …and deleting the month takes its rows with it (ON DELETE CASCADE), only those of that user.
    await db.prepare("DELETE FROM months WHERE user_id = 'eda' AND key = '2026-10'").run();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM transfers').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM months').first('n')).toBe(1);
    await expect(db.prepare("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'a'").run()).resolves.toMatchObject({ success: true });
  });

  it('the database rejects what the model does not allow: another currency, a rate that is not greater than 0 or a transfer to the same account', async () => {
    const { db } = setup();
    await db.prepare("INSERT INTO months (user_id, key) VALUES ('frank', '2026-10')").run();
    await db.prepare("INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'a', 'x', 'TRY')").run();
    const failing = [
      "INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'b', 'x', 'EUR')",
      "INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, date, rate) VALUES ('frank', '2026-10', 'USD', 'DOP', '2026-10-01', 0)",
      "INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, date, rate) VALUES ('frank', '2026-10', 'USD', 'USD', '2026-10-01', 1)",
      // The date of a rate and that of a budget movement fall within their month.
      "INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, date, rate) VALUES ('frank', '2026-10', 'USD', 'DOP', '2026-11-01', 58)",
      "INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount) VALUES ('frank', 'b1', '2026-10', '2026-09-30', 'a', 1)",
      "INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind) VALUES ('frank', 'b2', '2026-10', '2026-10-01', 'a', 1, 'bonus')",
      "INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate) VALUES ('frank', 't', '2026-10', '2026-10-01', 'x', 'a', 'a', 1, 1)",
    ];
    for (const sql of failing) await expect(db.prepare(sql).run(), sql).rejects.toThrow(/CHECK constraint failed.*SQLITE_CONSTRAINT/);
  });

  it('batch() is a transaction: if one statement fails nothing remains', async () => {
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

  it('does not allow hand-written BEGIN/COMMIT', async () => {
    const { db } = setup();
    await expect(db.prepare('BEGIN').run()).rejects.toThrow(/D1_ERROR/);
    await expect(db.prepare('  savepoint x').run()).rejects.toThrow(/D1_ERROR/);
  });

  it('exec() runs one statement per line', async () => {
    const { db } = setup();
    const res = await db.exec("INSERT INTO months (user_id, key) VALUES ('frank', '2026-09')\nINSERT INTO months (user_id, key) VALUES ('frank', '2026-10')\n");
    expect(res.count).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM months').first('n')).toBe(2);
  });
});
