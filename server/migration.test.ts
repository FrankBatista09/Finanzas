// La migración 0002 sobre una base que se quedó en 0001 y ya tiene datos, como la de producción: nada se pierde
// y lo que cambia de forma (tasas, presupuesto) dice lo mismo que antes.
// La 0003 solo renombra un valor: el método 'Card' de las transacciones pasa a ser 'Debit card'.
// La 0004 añade transfers.budget en 0: los envíos que ya había no suben el presupuesto de ningún mes.
// La 0005 rehace accounts e incomes para admitir el oro ('XAU'): ni una fila cambia y ninguna clave foránea se pierde.

import { describe, expect, it } from 'vitest';
import { balances, monthCalc, rateFor } from '../shared/calc';
import { METHODS } from '../shared/constants';
import { applyMigrations, asD1, createTestDb, migrationFiles } from './d1-node';
import type { NodeD1Database } from './d1-node';
import { addLeftover, createAccount, createIncome, loadState, patchMonth, setMonthRate } from './db';

const [INIT, ...LATER] = migrationFiles();

/** Filas de una tabla tal cual, en un orden estable. */
function dump(db: NodeD1Database, table: string, order = 'rowid'): Record<string, unknown>[] {
  return db.sqlite
    .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
    .all()
    .map((row) => ({ ...row }));
}

/** Una base con 0001 y datos de dos usuarios que comparten ids, cuentas y meses. */
function legacyDb(): NodeD1Database {
  const db = createTestDb([INIT!]);
  const sql = (text: string) => db.sqlite.exec(text);
  for (const user of ['frank', 'eda']) {
    sql(`
      INSERT INTO months (user_id, key, closed, closed_at) VALUES
        ('${user}', '2026-09', 1, '2026-10-01T04:00:00.000Z'), ('${user}', '2026-10', 0, NULL);
      INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES
        ('${user}', 'us', 'US account', 'USD', 2000, 0, 0), ('${user}', 'dr', 'DR account', 'DOP', 60000, 0, 1),
        ('${user}', 'tr', 'TR account', 'TRY', 0, 1, 2);
      INSERT INTO fixed_expenses (user_id, id, month_key, name, day, amount, currency, paid, account_id, sort) VALUES
        ('${user}', 'f1', '2026-10', 'Claude', '5', 106, 'USD', 1, 'us', 0);
      INSERT INTO transactions (user_id, id, month_key, date, description, place, category, method, amount, currency, account_id, notes, source, created_at) VALUES
        ('${user}', 't1', '2026-10', '2026-10-03', 'Lunch', '', 'Food', 'Card', 1150, 'DOP', 'dr', '', 'web', '2026-10-03T12:00:00.000Z'),
        ('${user}', 't2', '2026-10', '2026-10-06', 'Domain', '', 'Subscriptions', 'Card', 10, 'USD', 'dr', 'x', 'claude', '2026-10-06T12:00:00.000Z');
      INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate) VALUES
        ('${user}', 'x1', '2026-09', '2026-09-02', 'Remitly', 'us', 'dr', 1500, 58.55);
      INSERT INTO incomes (user_id, id, date, description, account_id, amount, currency) VALUES
        ('${user}', 'i1', '2026-10-01', 'Salary', 'us', 5800, 'USD');
      INSERT INTO goals (user_id, id, name, currency, monthly, start_month, end_month, sort) VALUES
        ('${user}', 'g1', 'Trip', 'USD', 3000, '2026-08', '2027-10', 0), ('${user}', 'g2', 'Emergency', 'DOP', NULL, NULL, NULL, 1);
      INSERT INTO contributions (user_id, id, goal_id, date, amount, currency) VALUES ('${user}', 'c1', 'g1', '2026-10-03', 3000, 'USD');
      INSERT INTO settings (user_id, key, value) VALUES
        ('${user}', 'initialized', '1'), ('${user}', 'default_rate', '58.76'), ('${user}', 'default_account', 'dr');
    `);
  }
  // Presupuesto y tasas distintos por usuario, para ver que no se mezclan.
  sql(`
    INSERT INTO month_budgets (user_id, month_key, account_id, amount) VALUES
      ('frank', '2026-09', 'dr', 65000), ('frank', '2026-10', 'dr', 70000), ('frank', '2026-10', 'us', 150.5),
      ('eda', '2026-10', 'tr', 9000);
    INSERT INTO month_rates (user_id, month_key, from_currency, to_currency, rate) VALUES
      ('frank', '2026-09', 'USD', 'DOP', 58.4), ('frank', '2026-10', 'USD', 'DOP', 58.76), ('frank', '2026-10', 'TRY', 'USD', 0.025),
      ('eda', '2026-10', 'DOP', 'USD', 0.0165);
  `);
  return db;
}

const UNTOUCHED = ['months', 'accounts', 'fixed_expenses', 'transactions', 'transfers', 'contributions', 'settings'];

describe('migración 0002 sobre una base con datos de 0001', () => {
  it('hay una migración inicial y al menos una más', () => {
    expect(INIT).toBe('0001_init.sql');
    expect(LATER.length).toBeGreaterThan(0);
  });

  it('no toca las tablas que no cambian', () => {
    const db = legacyDb();
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, dump(db, t)]));
    applyMigrations(db, LATER);
    // De las transacciones solo cambia el nombre del método con tarjeta (0003).
    before.transactions = before.transactions!.map((row) => (row.method === 'Card' ? { ...row, method: 'Debit card' } : row));
    // Y a los envíos solo se les añaden las columnas `budget` (0004) y `fee` (0006), en 0.
    before.transfers = before.transfers!.map((row) => ({ ...row, budget: 0, fee: 0 }));
    for (const table of UNTOUCHED) expect(dump(db, table), table).toEqual(before[table]);
    // Y la base queda coherente: ninguna clave foránea rota.
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('cada tasa escrita se conserva y pasa a valer desde el primer día de su mes', () => {
    const db = legacyDb();
    applyMigrations(db, LATER);
    expect(dump(db, 'month_rates', 'user_id, month_key, from_currency')).toEqual([
      { user_id: 'eda', month_key: '2026-10', from_currency: 'DOP', to_currency: 'USD', date: '2026-10-01', rate: 0.0165 },
      { user_id: 'frank', month_key: '2026-09', from_currency: 'USD', to_currency: 'DOP', date: '2026-09-01', rate: 58.4 },
      { user_id: 'frank', month_key: '2026-10', from_currency: 'TRY', to_currency: 'USD', date: '2026-10-01', rate: 0.025 },
      { user_id: 'frank', month_key: '2026-10', from_currency: 'USD', to_currency: 'DOP', date: '2026-10-01', rate: 58.76 },
    ]);
  });

  it('cada parte del presupuesto pasa a ser un movimiento inicial del primer día del mes, y month_budgets desaparece', () => {
    const db = legacyDb();
    applyMigrations(db, LATER);
    const log = dump(db, 'month_budget_log', 'user_id, month_key, account_id');
    expect(log.map(({ id: _id, ...row }) => row)).toEqual([
      { user_id: 'eda', month_key: '2026-10', date: '2026-10-01', account_id: 'tr', amount: 9000, kind: 'initial', note: '' },
      { user_id: 'frank', month_key: '2026-09', date: '2026-09-01', account_id: 'dr', amount: 65000, kind: 'initial', note: '' },
      { user_id: 'frank', month_key: '2026-10', date: '2026-10-01', account_id: 'dr', amount: 70000, kind: 'initial', note: '' },
      { user_id: 'frank', month_key: '2026-10', date: '2026-10-01', account_id: 'us', amount: 150.5, kind: 'initial', note: '' },
    ]);
    // Ids válidos para la API y distintos entre sí.
    const ids = log.map((row) => String(row.id));
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('month_budgets', 'month_rates_new')").all()).toEqual([]);
  });

  it('los ingresos no suben el presupuesto y las metas no tienen moneda "≈" propia; lo demás, igual', () => {
    const db = legacyDb();
    const incomes = dump(db, 'incomes');
    const goals = dump(db, 'goals');
    applyMigrations(db, LATER);
    expect(dump(db, 'incomes')).toEqual(incomes.map((row) => ({ ...row, budget: 0 })));
    expect(dump(db, 'goals')).toEqual(goals.map((row) => ({ ...row, approx_currency: null })));
  });

  it('el estado que lee el servidor dice lo mismo que antes: mismas partes, mismas tasas, mismas cifras', async () => {
    const sqlite = legacyDb();
    applyMigrations(sqlite, LATER);
    const db = asD1(sqlite);

    const frank = await loadState(db, 'frank');
    expect(frank.months['2026-09']!.budgets).toEqual({ dr: 65000 });
    expect(frank.months['2026-10']!.budgets).toEqual({ dr: 70000, us: 150.5 });
    expect(frank.months['2026-10']!.budgetLog.map((e) => [e.date, e.accountId, e.amount, e.kind])).toEqual([
      ['2026-10-01', 'dr', 70000, 'initial'],
      ['2026-10-01', 'us', 150.5, 'initial'],
    ]);
    expect(frank.months['2026-10']!.rates).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'TRY', to: 'USD', rate: 0.025, date: '2026-10-01' },
    ]);
    expect(frank.incomes).toEqual([{ id: 'i1', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD', budget: false }]);
    expect(frank.goals.map((g) => [g.id, g.approxCur])).toEqual([
      ['g1', null],
      ['g2', null],
    ]);
    // La tasa del día 1 cubre todo el mes: cada fila de octubre se convierte como antes, con 58.76.
    expect(rateFor(frank, '2026-10', 'USD', 'DOP', '2026-10-01')).toEqual({ rate: 58.76, source: 'month', monthKey: '2026-10', date: '2026-10-01' });
    const c = monthCalc(frank, '2026-10');
    // 70,000 DOP + 150.5 USD × 58.76; usado: Claude 106 USD × 58.76 + 1,150 + 10 USD × 58.76.
    expect(c.budget).toBeCloseTo(70000 + 150.5 * 58.76, 8);
    expect(c.used).toBeCloseTo(106 * 58.76 + 1150 + 587.6, 8);
    expect(c.income).toBeCloseTo(5800 * 58.76, 8);
    expect(monthCalc(frank, '2026-09').budget).toBe(65000);

    // Eda: lo suyo, sin nada de Frank.
    const eda = await loadState(db, 'eda');
    expect(eda.months['2026-09']!.budgets).toEqual({});
    expect(eda.months['2026-10']!.budgets).toEqual({ tr: 9000 });
    expect(eda.months['2026-10']!.rates).toEqual([{ from: 'DOP', to: 'USD', rate: 0.0165, date: '2026-10-01' }]);
  });

  it('después de migrar se puede seguir escribiendo: presupuesto, tasas con fecha y sobrante', async () => {
    const sqlite = legacyDb();
    applyMigrations(sqlite, LATER);
    const db = asD1(sqlite);
    const now = new Date('2026-10-08T15:00:00.000Z');

    const patched = await patchMonth(db, 'frank', '2026-10', { budgets: { dr: 72000 } }, now);
    expect(patched.budgets).toEqual({ dr: 72000, us: 150.5 });
    expect(patched.budgetLog.map((e) => [e.date, e.accountId, e.amount, e.kind])).toEqual([
      ['2026-10-01', 'dr', 70000, 'initial'],
      ['2026-10-01', 'us', 150.5, 'initial'],
      ['2026-10-08', 'dr', 2000, 'adjust'],
    ]);
    const rated = await setMonthRate(db, 'frank', '2026-10', { from: 'USD', to: 'DOP', rate: 59.2, date: '2026-10-08' });
    expect(rated.rates.filter((r) => r.from === 'USD' && r.to === 'DOP')).toEqual([
      { from: 'USD', to: 'DOP', rate: 58.76, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 59.2, date: '2026-10-08' },
    ]);
    // Septiembre de Frank: 65,000 sin nada usado.
    const withLeftover = await addLeftover(db, 'frank', '2026-10', now);
    expect(withLeftover.budgetLog.at(-1)).toMatchObject({ kind: 'leftover', accountId: 'dr', amount: 65000, date: '2026-10-08' });
  });

  it('las claves foráneas de las tablas rehechas siguen vivas: borrar el mes se lleva sus tasas y su registro', () => {
    const db = legacyDb();
    applyMigrations(db, LATER);
    // Una cuenta con movimientos de presupuesto no se puede borrar por debajo.
    expect(() => db.sqlite.exec("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'tr'")).toThrow(/FOREIGN KEY constraint failed/);
    db.sqlite.exec("DELETE FROM months WHERE user_id = 'frank' AND key = '2026-10'");
    expect(dump(db, 'month_rates').map((r) => [r.user_id, r.month_key])).toEqual([
      ['frank', '2026-09'],
      ['eda', '2026-10'],
    ]);
    expect(dump(db, 'month_budget_log', 'user_id, month_key').map((r) => [r.user_id, r.month_key])).toEqual([
      ['eda', '2026-10'],
      ['frank', '2026-09'],
    ]);
  });

  it('una base vacía migra igual, y aplicar todo de una vez da el mismo esquema', () => {
    const stepwise = createTestDb([INIT!]);
    applyMigrations(stepwise, LATER);
    const schema = (db: NodeD1Database) => db.sqlite.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(schema(stepwise)).toEqual(schema(createTestDb()));
  });
});

describe('migración 0004: transfers.budget', () => {
  const FILE = '0004_transfer_budget.sql';
  const BEFORE = LATER.slice(0, LATER.indexOf(FILE));

  /** La base de producción antes de 0004. */
  function db0003(): NodeD1Database {
    const db = legacyDb();
    applyMigrations(db, BEFORE);
    return db;
  }

  it('es la migración que sigue a la 0003', () => {
    expect(BEFORE).toEqual(['0002_dated_rates_budget_log.sql', '0003_debit_card_method.sql']);
  });

  it('los envíos que ya había quedan sin marcar y el resto de cada fila, y de la base, igual', () => {
    const db = db0003();
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const before = Object.fromEntries(tables.map((t) => [t, dump(db, t)]));
    expect(before.transfers).toHaveLength(2);
    applyMigrations(db, [FILE]);
    before.transfers = before.transfers!.map((row) => ({ ...row, budget: 0 }));
    for (const table of tables) expect(dump(db, table), table).toEqual(before[table]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('el presupuesto de los meses pasados no cambia, y un envío nuevo sin `budget` nace en 0', async () => {
    const sqlite = db0003();
    applyMigrations(sqlite, [FILE]);
    const state = await loadState(asD1(sqlite), 'frank');
    expect(state.months['2026-09']!.transfers.map((t) => [t.id, t.budget])).toEqual([['x1', false]]);
    // Los mismos presupuestos que dejó la 0002: 65,000 en septiembre y 70,000 + 150.5 USD en octubre.
    expect(monthCalc(state, '2026-09').budget).toBe(65000);
    expect(monthCalc(state, '2026-10').budget).toBeCloseTo(70000 + 150.5 * 58.76, 8);
    for (const key of ['2026-09', '2026-10']) expect(monthCalc(state, key).budgetParts.every((p) => p.fromTransfers === 0)).toBe(true);

    // El DEFAULT de la columna cubre un INSERT que no la nombra (el de una versión anterior del servidor).
    sqlite.sqlite.exec(`
      INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate)
      VALUES ('frank', 'x2', '2026-10', '2026-10-04', 'Remitly', 'us', 'dr', 100, 58.76)
    `);
    expect(sqlite.sqlite.prepare("SELECT budget FROM transfers WHERE id = 'x2'").get()).toEqual({ budget: 0 });
    expect(() => sqlite.sqlite.exec("UPDATE transfers SET budget = NULL WHERE id = 'x2'")).toThrow();
  });
});

describe('migración 0006: transfers.fee', () => {
  const FILE = '0006_transfer_fee.sql';
  const BEFORE = LATER.slice(0, LATER.indexOf(FILE));

  /** La base de producción antes de 0006, con un envío que ya mueve presupuesto. */
  function db0005(): NodeD1Database {
    const db = legacyDb();
    applyMigrations(db, BEFORE);
    db.sqlite.exec("UPDATE transfers SET budget = 1 WHERE user_id = 'frank'");
    return db;
  }

  it('es la migración que sigue a la 0005', () => {
    expect(BEFORE.at(-1)).toBe('0005_gold_accounts.sql');
    expect(LATER.at(-1)).toBe(FILE);
  });

  it('los envíos que ya había quedan sin comisión; el resto de cada fila, y de la base, igual', () => {
    const db = db0005();
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const before = Object.fromEntries(tables.map((t) => [t, dump(db, t)]));
    applyMigrations(db, [FILE]);
    before.transfers = before.transfers!.map((row) => ({ ...row, fee: 0 }));
    for (const table of tables) expect(dump(db, table), table).toEqual(before[table]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('los saldos no cambian; la marca `budget` que ya había pasa a mover presupuesto; y un INSERT sin `fee` nace en 0', async () => {
    const sqlite = db0005();
    const before = await loadState(asD1(sqlite), 'frank');
    applyMigrations(sqlite, [FILE]);
    const state = await loadState(asD1(sqlite), 'frank');
    expect(state.months['2026-09']!.transfers.map((t) => [t.id, t.budget, t.fee])).toEqual([['x1', true, 0]]);
    expect(balances(state, '2026-10').accounts.map((a) => a.balance)).toEqual(balances(before, '2026-10').accounts.map((a) => a.balance));
    // El envío de septiembre (1,500 USD a 58.55) ahora resta de la US account lo que suma a la DR account.
    const parts = monthCalc(state, '2026-09').budgetParts.map((p) => [p.account.id, p.fromTransfers]);
    expect(parts).toEqual(expect.arrayContaining([['us', -1500], ['dr', 1500 * 58.55]]));

    sqlite.sqlite.exec(`
      INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate, budget)
      VALUES ('frank', 'x2', '2026-10', '2026-10-04', 'Remitly', 'us', 'dr', 100, 58.76, 0)
    `);
    expect(sqlite.sqlite.prepare("SELECT fee FROM transfers WHERE id = 'x2'").get()).toEqual({ fee: 0 });
    expect(() => sqlite.sqlite.exec("UPDATE transfers SET fee = NULL WHERE id = 'x2'")).toThrow();
  });
});

describe("migración 0005: cuentas e ingresos admiten el oro ('XAU')", () => {
  const FILE = '0005_gold_accounts.sql';
  const BEFORE = LATER.slice(0, LATER.indexOf(FILE));

  const tablesOf = (db: NodeD1Database) =>
    db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  const foreignKeys = (db: NodeD1Database, table: string) =>
    db.sqlite
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map((row) => ({ ...row }));
  const indexes = (db: NodeD1Database) =>
    db.sqlite.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map((row) => ({ ...row }));

  /**
   * La base de producción antes de 0005, con filas en todas las tablas que referencian a `accounts` (fijos,
   * transacciones, envíos por los dos lados, ingresos y registro del presupuesto) y con lo que una copia
   * descuidada perdería: cuentas ocultas, saldos con decimales y negativos, un orden que no es el de alta y un
   * ingreso que sube el presupuesto.
   */
  function db0004(): NodeD1Database {
    const db = legacyDb();
    applyMigrations(db, BEFORE);
    for (const user of ['frank', 'eda']) {
      db.sqlite.exec(`
        INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort) VALUES
          ('${user}', 'pp', 'PayPal', 'USD', -12.345678, 0, 0), ('${user}', 'old', 'Old ''bank''', 'DOP', 0.1, 1, 7);
        INSERT INTO incomes (user_id, id, date, description, account_id, amount, currency, budget) VALUES
          ('${user}', 'i2', '2026-09-15', '', 'tr', 1250.75, 'TRY', 1), ('${user}', 'i3', '2025-01-01', 'Old', 'old', 10, 'USD', 0);
        INSERT INTO transfers (user_id, id, month_key, date, via, from_account_id, to_account_id, amount, rate, budget) VALUES
          ('${user}', 'x9', '2026-10', '2026-10-02', 'PayPal', 'pp', 'us', 300, 1, 1);
        INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note) VALUES
          ('${user}', 'b-${user}', '2026-10', '2026-10-05', 'pp', -20.5, 'adjust', 'note');
      `);
    }
    return db;
  }

  it('es la migración que sigue a la 0004', () => {
    expect(BEFORE).toEqual(['0002_dated_rates_budget_log.sql', '0003_debit_card_method.sql', '0004_transfer_budget.sql']);
  });

  it('todas las filas de todas las tablas siguen igual, en su orden, y ninguna referencia queda rota', () => {
    const db = db0004();
    const tables = tablesOf(db);
    const before = Object.fromEntries(tables.map((t) => [t, dump(db, t)]));
    // Hay algo que perder en cada tabla que cuelga de las cuentas.
    for (const t of ['accounts', 'incomes', 'fixed_expenses', 'transactions', 'transfers', 'month_budget_log']) expect(before[t]!.length, t).toBeGreaterThan(1);
    expect(before.accounts).toHaveLength(10);
    expect(before.incomes).toHaveLength(6);

    applyMigrations(db, [FILE]);

    expect(tablesOf(db)).toEqual(tables);
    for (const t of tables) expect(dump(db, t), t).toEqual(before[t]);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    // Las tablas de paso no quedan.
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'accounts_%' OR name LIKE 'incomes_new%'").all()).toEqual([]);
  });

  it('las claves foráneas y los índices son los mismos que antes', () => {
    const db = db0004();
    const tables = tablesOf(db);
    const fks = Object.fromEntries(tables.map((t) => [t, foreignKeys(db, t)]));
    const idx = indexes(db);
    // La de ingresos a su cuenta: una fila por columna de la clave (user_id, account_id).
    expect(fks.incomes!.map((fk) => [fk.table, fk.from, fk.to, fk.on_delete])).toEqual([
      ['accounts', 'user_id', 'user_id', 'NO ACTION'],
      ['accounts', 'account_id', 'id', 'NO ACTION'],
    ]);
    expect(idx.map((i) => i.name)).toContain('incomes_date');
    applyMigrations(db, [FILE]);
    for (const t of tables) expect(foreignKeys(db, t), t).toEqual(fks[t]);
    expect(indexes(db)).toEqual(idx);
  });

  it('las claves foráneas siguen vivas: una cuenta en uso no se borra y nada puede nombrar una que no existe', () => {
    const db = db0004();
    applyMigrations(db, [FILE]);
    const run = (sql: string) => () => db.sqlite.exec(sql);
    // Cada tabla hija sigue sujetando a su cuenta: fijo (us), transacción (dr), envío (pp), ingreso (old), registro (tr de Eda).
    for (const id of ['us', 'dr', 'pp', 'old']) expect(run(`DELETE FROM accounts WHERE user_id = 'frank' AND id = '${id}'`), id).toThrow(/FOREIGN KEY constraint failed/);
    expect(run("DELETE FROM accounts WHERE user_id = 'eda' AND id = 'tr'")).toThrow(/FOREIGN KEY constraint failed/);
    expect(run("INSERT INTO incomes (user_id, id, date, account_id, amount, currency) VALUES ('frank', 'i9', '2026-10-01', 'nope', 1, 'USD')")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(run("UPDATE transactions SET account_id = 'nope' WHERE user_id = 'frank' AND id = 't1'")).toThrow(/FOREIGN KEY constraint failed/);
    // La cuenta de otro usuario tampoco vale: las claves incluyen user_id.
    db.sqlite.exec("INSERT INTO accounts (user_id, id, name, currency) VALUES ('eda', 'solo-eda', 'Solo', 'USD')");
    expect(run("UPDATE fixed_expenses SET account_id = 'solo-eda' WHERE user_id = 'frank' AND id = 'f1'")).toThrow(/FOREIGN KEY constraint failed/);
    // Y borrar un mes sigue llevándose lo suyo sin tocar las cuentas ni los ingresos.
    db.sqlite.exec("DELETE FROM months WHERE user_id = 'frank' AND key = '2026-10'");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = 'frank'").get()).toEqual({ n: 5 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM incomes WHERE user_id = 'frank'").get()).toEqual({ n: 3 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM transfers WHERE user_id = 'frank' AND month_key = '2026-10'").get()).toEqual({ n: 0 });
  });

  it("'XAU' vale en cuentas e ingresos, y solo ahí; lo demás que no es una moneda sigue sin valer", () => {
    const db = db0004();
    const run = (sql: string) => () => db.sqlite.exec(sql);
    const goldAccount = "INSERT INTO accounts (user_id, id, name, currency, opening) VALUES ('frank', 'gold', 'Gold', 'XAU', 125.5)";
    expect(run(goldAccount)).toThrow(/CHECK constraint failed/);
    applyMigrations(db, [FILE]);
    db.sqlite.exec(goldAccount);
    db.sqlite.exec("INSERT INTO incomes (user_id, id, date, account_id, amount, currency) VALUES ('frank', 'ig', '2026-10-01', 'gold', 2.125, 'XAU')");
    expect(db.sqlite.prepare("SELECT description, budget FROM incomes WHERE id = 'ig'").get()).toEqual({ description: '', budget: 0 });
    expect(db.sqlite.prepare("SELECT hidden, sort FROM accounts WHERE id = 'gold'").get()).toEqual({ hidden: 0, sort: 0 });
    expect(run("INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'eur', 'Euro', 'EUR')")).toThrow(/CHECK constraint failed/);
    expect(run("UPDATE incomes SET currency = 'EUR' WHERE user_id = 'frank' AND id = 'i1'")).toThrow(/CHECK constraint failed/);
    expect(run("UPDATE accounts SET name = NULL WHERE user_id = 'frank' AND id = 'us'")).toThrow(/NOT NULL constraint failed/);
    expect(run("INSERT INTO accounts (user_id, id, name, currency) VALUES ('frank', 'us', 'Again', 'USD')")).toThrow(/UNIQUE constraint failed/);
    // En ninguna otra tabla: ni gastos, ni transacciones, ni tasas, ni metas, ni aportes.
    for (const sql of [
      "UPDATE fixed_expenses SET currency = 'XAU' WHERE id = 'f1'",
      "UPDATE transactions SET currency = 'XAU' WHERE id = 't1'",
      "UPDATE goals SET currency = 'XAU' WHERE id = 'g1'",
      "UPDATE goals SET approx_currency = 'XAU' WHERE id = 'g1'",
      "UPDATE contributions SET currency = 'XAU' WHERE id = 'c1'",
      "UPDATE month_rates SET to_currency = 'XAU' WHERE user_id = 'eda'",
    ]) {
      expect(run(sql), sql).toThrow(/CHECK constraint failed/);
    }
  });

  it('el servidor lee el mismo estado que antes, sin precio del oro, y ya puede guardar una cuenta de oro', async () => {
    const sqlite = db0004();
    const db = asD1(sqlite);
    // El servidor de hoy sobre la base de antes de migrar: lo único que no sabría leer es lo que aún no existe.
    const before = { frank: await loadState(db, 'frank'), eda: await loadState(db, 'eda') };
    applyMigrations(sqlite, [FILE]);
    expect(await loadState(db, 'frank')).toEqual(before.frank);
    expect(await loadState(db, 'eda')).toEqual(before.eda);
    expect(before.frank.goldPrice).toBeNull();
    expect(before.frank.accounts.map((a) => a.id)).toEqual(['us', 'pp', 'dr', 'tr', 'old']);

    const gold = await createAccount(db, 'frank', { name: 'Gold', currency: 'XAU', opening: 10 });
    await createIncome(db, 'frank', { date: '2026-10-08', accountId: gold.id, amount: 2.5, cur: 'XAU' });
    const after = await loadState(db, 'frank');
    expect(after.accounts.at(-1)).toMatchObject({ name: 'Gold', currency: 'XAU', opening: 10, sort: 8 });
    expect(after.incomes.at(-1)).toMatchObject({ accountId: gold.id, amount: 2.5, cur: 'XAU', budget: false });
    expect(await loadState(db, 'eda')).toEqual(before.eda);
  });

  it('una base vacía migra igual', () => {
    const empty = createTestDb(['0001_init.sql', ...BEFORE]);
    applyMigrations(empty, [FILE]);
    expect(dump(empty, 'accounts')).toEqual([]);
    expect(dump(empty, 'incomes')).toEqual([]);
  });
});

describe("migración 0003: el método 'Card' pasa a ser 'Debit card'", () => {
  const FILE = '0003_debit_card_method.sql';
  const BEFORE = LATER.slice(0, LATER.indexOf(FILE));

  /** La base de producción antes de 0003, con más métodos: de la lista, de texto libre y parecidos a 'Card'. */
  function db0002(): NodeD1Database {
    const db = legacyDb();
    applyMigrations(db, BEFORE);
    for (const user of ['frank', 'eda']) {
      db.sqlite.exec(`
        INSERT INTO transactions (user_id, id, month_key, date, description, place, category, method, amount, currency, account_id, notes, source, created_at) VALUES
          ('${user}', 't3', '2026-10', '2026-10-07', 'Rent', '', 'Home', 'Transfer', 500, 'USD', 'us', '', 'web', '2026-10-07T12:00:00.000Z'),
          ('${user}', 't4', '2026-10', '2026-10-07', 'Gas', '', 'Transport', 'Bank app', 2000, 'DOP', 'dr', '', 'web', '2026-10-07T12:00:00.000Z'),
          ('${user}', 't5', '2026-10', '2026-10-07', 'Colmado', '', 'Food', 'Efectivo', 90, 'DOP', 'dr', 'Card', 'import', '2026-10-07T12:00:00.000Z'),
          ('${user}', 't6', '2026-10', '2026-10-07', 'Card', 'Card', 'Card', 'card', 1, 'DOP', 'dr', '', 'web', '2026-10-07T12:00:00.000Z'),
          ('${user}', 't7', '2026-09', '2026-09-30', 'Cena', '', 'Food', 'Card', 3150, 'DOP', 'dr', '', 'web', '2026-10-07T12:00:00.000Z');
      `);
    }
    return db;
  }

  it('es la migración que sigue a la 0002', () => {
    expect(LATER).toContain(FILE);
    expect(BEFORE).toEqual(['0002_dated_rates_budget_log.sql']);
  });

  it('de todos los usuarios, y de meses cerrados también; el resto de cada fila queda igual', () => {
    const db = db0002();
    const before = dump(db, 'transactions');
    expect(before.filter((row) => row.method === 'Card')).toHaveLength(6);
    applyMigrations(db, [FILE]);
    expect(dump(db, 'transactions')).toEqual(before.map((row) => (row.method === 'Card' ? { ...row, method: 'Debit card' } : row)));
    const after = dump(db, 'transactions', 'user_id DESC, id');
    expect(after.map((row) => [row.user_id, row.id, row.method])).toEqual(
      ['frank', 'eda'].flatMap((user) => [
        [user, 't1', 'Debit card'],
        [user, 't2', 'Debit card'],
        [user, 't3', 'Transfer'],
        [user, 't4', 'Bank app'],
        // Texto libre: no es el valor 'Card' exacto y se queda como está.
        [user, 't5', 'Efectivo'],
        [user, 't6', 'card'],
        [user, 't7', 'Debit card'],
      ]),
    );
    // 'Card' en otra columna (descripción, lugar, categoría, notas) no es un método.
    expect(after.filter((row) => row.id === 't6').map((row) => [row.description, row.place, row.category])).toEqual([
      ['Card', 'Card', 'Card'],
      ['Card', 'Card', 'Card'],
    ]);
    expect(after.filter((row) => row.id === 't5').map((row) => row.notes)).toEqual(['Card', 'Card']);
  });

  it('no toca ninguna otra tabla ni el esquema', () => {
    const db = db0002();
    const tables = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    expect(tables).toContain('month_budget_log');
    const schema = () => db.sqlite.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all();
    const schemaBefore = schema();
    const before = Object.fromEntries(tables.filter((t) => t !== 'transactions').map((t) => [t, dump(db, t)]));
    applyMigrations(db, [FILE]);
    for (const table of Object.keys(before)) expect(dump(db, table), table).toEqual(before[table]);
    expect(schema()).toEqual(schemaBefore);
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('el servidor lee el método de hoy, que es el que se aplica por defecto al registrar', async () => {
    const sqlite = db0002();
    applyMigrations(sqlite, [FILE]);
    const db = asD1(sqlite);
    for (const user of ['frank', 'eda']) {
      const state = await loadState(db, user);
      const methods = Object.values(state.months).flatMap((m) => m.tx.map((t) => t.method));
      expect(methods.sort(), user).toEqual(['Bank app', 'Debit card', 'Debit card', 'Debit card', 'Efectivo', 'Transfer', 'card']);
      for (const method of methods.filter((m) => m === 'Debit card')) expect(METHODS).toContain(method);
      expect(methods).not.toContain('Card');
    }
    expect(METHODS[0]).toBe('Debit card');
  });

  it('sin transacciones con tarjeta no cambia nada, y aplicarla dos veces da lo mismo', () => {
    const empty = createTestDb(['0001_init.sql', ...BEFORE]);
    applyMigrations(empty, [FILE]);
    expect(dump(empty, 'transactions')).toEqual([]);
    const db = db0002();
    applyMigrations(db, [FILE]);
    const once = dump(db, 'transactions');
    applyMigrations(db, [FILE]);
    expect(dump(db, 'transactions')).toEqual(once);
  });
});
