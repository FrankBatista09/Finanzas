-- FE Finance: cuentas en oro. Una cuenta puede estar en 'XAU' (oro, medido en gramos) además de en una moneda,
-- y los ingresos que le entran son gramos, también en 'XAU'. El oro no vale en ninguna otra tabla: gastos fijos,
-- transacciones, tasas, metas y aportes siguen admitiendo solo DOP, USD y TRY.
-- El precio del oro (lo que vale 1 gramo) es un ajuste del usuario: la fila 'gold_price' de `settings`, que es
-- clave/valor y no necesita cambiar.
--
-- La base de producción tiene datos reales: aquí todo lo que existe se conserva tal cual.
-- SQLite no sabe cambiar un CHECK: las dos tablas se rehacen.
--   · accounts  la referencian fixed_expenses, transactions, transfers (dos veces), incomes y month_budget_log.
--               Ninguna de esas claves foráneas tiene ON DELETE: borrar la tabla no arrastra ni una fila de
--               las hijas; solo deja sus referencias sin destino hasta que las cuentas vuelven a estar.
--   · incomes   no la referencia nadie; su índice se borra con ella y se vuelve a crear.
--
-- Las claves foráneas van diferidas (lo que D1 pide para rehacer tablas): se comprueban al final de la
-- transacción de la migración. El orden de los pasos de `accounts` importa. SQLite no vuelve a mirar las tablas
-- al terminar: lleva la cuenta de las referencias rotas, que sube al borrar la tabla (una por cada fila hija) y
-- solo baja cuando se INSERTA la fila padre que faltaba en una tabla que se llame `accounts`. Por eso las filas
-- se guardan primero en una copia, la tabla se borra y se crea de nuevo YA con su nombre, y se insertan en ella
-- desde la copia. (Crear `accounts_new`, llenarla y renombrarla no sirve: renombrar no baja esa cuenta y la
-- migración fallaría entera con "FOREIGN KEY constraint failed" en cuanto hubiera una fila hija.) Tampoco se
-- renombra la tabla vieja: eso reescribiría las claves foráneas de las hijas para que la siguieran.
-- Las tablas hijas no se tocan. Las filas se copian en el orden de su rowid, que es el orden en que la app las
-- lee (ORDER BY sort, rowid).

PRAGMA defer_foreign_keys = true;

-- Copia de paso, sin restricciones: nadie la referencia y se borra al final.
CREATE TABLE accounts_copy AS SELECT user_id, id, name, currency, opening, hidden, sort FROM accounts ORDER BY rowid;

DROP TABLE accounts;

CREATE TABLE accounts (
  user_id  TEXT NOT NULL,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY','XAU')),
  opening  REAL NOT NULL DEFAULT 0,           -- saldo inicial, en la moneda de la cuenta (gramos si es 'XAU')
  hidden   INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

INSERT INTO accounts (user_id, id, name, currency, opening, hidden, sort)
SELECT user_id, id, name, currency, opening, hidden, sort FROM accounts_copy ORDER BY rowid;

DROP TABLE accounts_copy;

-- Ingresos: los de una cuenta de oro van en gramos ('XAU'). `budget` es la columna que añadió la 0002.
CREATE TABLE incomes_new (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY','XAU')),
  budget      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

INSERT INTO incomes_new (user_id, id, date, description, account_id, amount, currency, budget)
SELECT user_id, id, date, description, account_id, amount, currency, budget FROM incomes ORDER BY rowid;

DROP TABLE incomes;
ALTER TABLE incomes_new RENAME TO incomes;
CREATE INDEX incomes_date ON incomes(user_id, date);
