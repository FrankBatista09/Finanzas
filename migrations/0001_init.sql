-- FE Finance: esquema inicial.
-- D1 es la fuente de verdad del histórico; el Excel es solo formato de exportación/importación.
-- Cada fila guarda su monto y su moneda originales. Nada convertido ni ningún saldo se persiste: los saldos de
-- las cuentas, el ingreso del mes y todos los totales se calculan del histórico (shared/calc.ts).
--
-- Cada usuario (los de la variable de entorno USERS, p. ej. "frank:Frank,eda:Eda") tiene sus finanzas aparte:
-- todas las tablas llevan user_id y todas las claves son (user_id, …). Así dos usuarios pueden tener el mismo
-- mes, la misma cuenta o incluso los mismos ids (los datos de ejemplo) sin tocarse, y una consulta que olvide
-- filtrar por usuario no puede enlazar filas de otro: las claves foráneas también incluyen user_id.
-- Los usuarios no tienen tabla: existen por configuración. Las cuentas y metas iniciales de un usuario nuevo las
-- crea el servidor la primera vez que entra (shared/constants.ts DEFAULT_ACCOUNTS, DEFAULT_GOALS).

CREATE TABLE months (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,                   -- 'YYYY-MM'
  closed     INTEGER NOT NULL DEFAULT 0,
  closed_at  TEXT,
  PRIMARY KEY (user_id, key)
);

-- Cuentas del usuario. El saldo es `opening` más los movimientos; no se guarda.
CREATE TABLE accounts (
  user_id  TEXT NOT NULL,
  id       TEXT NOT NULL,
  name     TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  opening  REAL NOT NULL DEFAULT 0,           -- saldo inicial, en la moneda de la cuenta
  hidden   INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

-- Presupuesto del mes repartido por cuenta: lo que se planea gastar de cada una, en su moneda.
CREATE TABLE month_budgets (
  user_id    TEXT NOT NULL,
  month_key  TEXT NOT NULL,
  account_id TEXT NOT NULL,
  amount     REAL NOT NULL,
  PRIMARY KEY (user_id, month_key, account_id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);

-- Tasas del mes escritas a mano: 1 from_currency = rate to_currency. Una sola fila por par (en un sentido).
CREATE TABLE month_rates (
  user_id       TEXT NOT NULL,
  month_key     TEXT NOT NULL,
  from_currency TEXT NOT NULL CHECK (from_currency IN ('DOP','USD','TRY')),
  to_currency   TEXT NOT NULL CHECK (to_currency IN ('DOP','USD','TRY')),
  rate          REAL NOT NULL CHECK (rate > 0),
  PRIMARY KEY (user_id, month_key, from_currency, to_currency),
  CHECK (from_currency <> to_currency),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE
);

CREATE TABLE fixed_expenses (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  month_key  TEXT NOT NULL,
  name       TEXT NOT NULL,
  day        TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  paid       INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,                   -- cuenta de la que se paga
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX fixed_month ON fixed_expenses(user_id, month_key, sort);

CREATE TABLE transactions (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  month_key   TEXT NOT NULL,
  date        TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  description TEXT NOT NULL,
  place       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  method      TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  account_id  TEXT NOT NULL,                  -- cuenta de la que sale
  notes       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'web',    -- 'web' | 'claude' | 'import'
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX tx_month ON transactions(user_id, month_key, date);

-- Envío de una cuenta a otra: sale `amount` (moneda de origen) y entra amount × rate (moneda de destino).
CREATE TABLE transfers (
  user_id         TEXT NOT NULL,
  id              TEXT NOT NULL,
  month_key       TEXT NOT NULL,
  date            TEXT NOT NULL,
  via             TEXT NOT NULL,
  from_account_id TEXT NOT NULL,
  to_account_id   TEXT NOT NULL,
  amount          REAL NOT NULL,
  rate            REAL NOT NULL,
  PRIMARY KEY (user_id, id),
  CHECK (from_account_id <> to_account_id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, from_account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, to_account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX transfers_month ON transfers(user_id, month_key, date);

-- Ingresos: dinero que entra a una cuenta. No pertenecen a un mes; cuentan en el de su fecha.
CREATE TABLE incomes (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  date        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX incomes_date ON incomes(user_id, date);

CREATE TABLE goals (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('DOP','USD','TRY')),
  monthly     REAL,                           -- ahorro mensual planeado, en `currency`; NULL = aportes variables
  start_month TEXT,                           -- 'YYYY-MM'; con plan, los tres van juntos
  end_month   TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

-- Aportes a metas. Son un apartado: no mueven el saldo de ninguna cuenta.
CREATE TABLE contributions (
  user_id  TEXT NOT NULL,
  id       TEXT NOT NULL,
  goal_id  TEXT NOT NULL,
  date     TEXT NOT NULL,
  amount   REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id)
);
CREATE INDEX contributions_goal ON contributions(user_id, goal_id, date);

-- Ajustes por usuario: 'default_rate' (USD→DOP de respaldo), 'theme' (JSON de ThemeColors), 'language',
-- 'main_currency', 'second_currency', 'default_account' e 'initialized' (marca que ya se le crearon las cuentas
-- y metas iniciales, para no recrearlas si las borra).
CREATE TABLE settings (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
