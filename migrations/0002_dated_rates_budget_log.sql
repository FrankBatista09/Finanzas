-- FE Finance: tasas con fecha, registro del presupuesto, ingresos que suben el presupuesto y moneda "≈" de las metas.
-- La base de producción ya tiene 0001 con datos reales: aquí todo lo que existe se conserva.
--   · month_rates    cada tasa escrita pasa a valer desde el primer día de su mes;
--   · month_budgets  cada parte pasa a ser un movimiento 'initial' del registro, con fecha del primer día del mes;
--   · incomes        ninguno sube el presupuesto (budget = 0);
--   · goals          sin moneda "≈" propia (NULL = la moneda principal del usuario).
-- Las dos tablas que cambian de clave primaria se rehacen (SQLite no sabe alterarla). Ninguna otra tabla las
-- referencia; aun así las claves foráneas se difieren al final de la transacción de la migración, que es lo que
-- D1 pide para rehacer tablas.

PRAGMA defer_foreign_keys = true;

-- Tasas escritas a mano: 1 from_currency = rate to_currency desde `date` (incluida) hasta la siguiente del par.
-- Varias por par en un mes, una por fecha. Que no haya dos del mismo par y fecha en sentidos opuestos lo cuida
-- el servidor (setMonthRate), como antes cuidaba que hubiera una sola por par.
CREATE TABLE month_rates_new (
  user_id       TEXT NOT NULL,
  month_key     TEXT NOT NULL,
  from_currency TEXT NOT NULL CHECK (from_currency IN ('DOP','USD','TRY')),
  to_currency   TEXT NOT NULL CHECK (to_currency IN ('DOP','USD','TRY')),
  date          TEXT NOT NULL,                -- 'YYYY-MM-DD', dentro de month_key
  rate          REAL NOT NULL CHECK (rate > 0),
  PRIMARY KEY (user_id, month_key, from_currency, to_currency, date),
  CHECK (from_currency <> to_currency),
  CHECK (substr(date, 1, 7) = month_key),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE
);

INSERT INTO month_rates_new (user_id, month_key, from_currency, to_currency, date, rate)
SELECT user_id, month_key, from_currency, to_currency, month_key || '-01', rate FROM month_rates ORDER BY rowid;

DROP TABLE month_rates;
ALTER TABLE month_rates_new RENAME TO month_rates;

-- Registro del presupuesto del mes: el presupuesto de una cuenta es la suma de sus movimientos, en su moneda.
-- Sustituye a month_budgets (un monto por cuenta que se sobrescribía): así queda la historia de cada cambio.
CREATE TABLE month_budget_log (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  month_key  TEXT NOT NULL,
  date       TEXT NOT NULL,                   -- 'YYYY-MM-DD', dentro de month_key
  account_id TEXT NOT NULL,
  amount     REAL NOT NULL,                   -- en la moneda de la cuenta; puede ser negativo
  kind       TEXT NOT NULL DEFAULT 'adjust' CHECK (kind IN ('initial','adjust','leftover')),
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id),
  CHECK (substr(date, 1, 7) = month_key),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX budget_log_month ON month_budget_log(user_id, month_key, date);
-- El sobrante del mes anterior se suma como mucho una vez por mes.
CREATE UNIQUE INDEX budget_log_leftover ON month_budget_log(user_id, month_key) WHERE kind = 'leftover';

INSERT INTO month_budget_log (user_id, id, month_key, date, account_id, amount, kind, note)
SELECT user_id, lower(hex(randomblob(16))), month_key, month_key || '-01', account_id, amount, 'initial', ''
FROM month_budgets ORDER BY rowid;

DROP TABLE month_budgets;

-- Un ingreso con budget = 1 sube además el presupuesto del mes de su fecha (lo suma shared/calc.ts; no se
-- escribe nada en el registro).
ALTER TABLE incomes ADD COLUMN budget INTEGER NOT NULL DEFAULT 0;

-- Moneda en la que también se muestra lo ahorrado en la meta; NULL = la moneda principal del usuario.
ALTER TABLE goals ADD COLUMN approx_currency TEXT CHECK (approx_currency IN ('DOP','USD','TRY'));
