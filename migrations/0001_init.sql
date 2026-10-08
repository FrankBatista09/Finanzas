-- Finanzas personales: esquema inicial.
-- D1 es la fuente de verdad del histórico; el Excel es solo formato de exportación/importación.
-- DOP/USD de cada fila se calculan con la tasa del mes y no se persisten: aquí va el monto y la moneda originales.

CREATE TABLE months (
  key        TEXT PRIMARY KEY,                -- 'YYYY-MM'
  budget_dop REAL NOT NULL DEFAULT 0,
  income_usd REAL NOT NULL DEFAULT 0,
  acc_usd    REAL NOT NULL DEFAULT 0,         -- Cuenta USA (foto al cierre en meses cerrados)
  acc_dop    REAL NOT NULL DEFAULT 0,         -- Cuenta RD
  closed     INTEGER NOT NULL DEFAULT 0,
  closed_at  TEXT
);

CREATE TABLE fixed_expenses (
  id        TEXT PRIMARY KEY,
  month_key TEXT NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  day       TEXT NOT NULL DEFAULT '',
  amount    REAL NOT NULL,
  currency  TEXT NOT NULL CHECK (currency IN ('DOP','USD')),
  paid      INTEGER NOT NULL DEFAULT 0,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX fixed_month ON fixed_expenses(month_key, sort);

CREATE TABLE transactions (
  id          TEXT PRIMARY KEY,
  month_key   TEXT NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  date        TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  description TEXT NOT NULL,
  place       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  method      TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('DOP','USD')),
  notes       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'web',    -- 'web' | 'claude' | 'import'
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tx_month ON transactions(month_key, date);

CREATE TABLE transfers (
  id        TEXT PRIMARY KEY,
  month_key TEXT NOT NULL REFERENCES months(key) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  via       TEXT NOT NULL,
  usd       REAL NOT NULL,
  rate      REAL NOT NULL
);
CREATE INDEX transfers_month ON transfers(month_key, date);

CREATE TABLE goals (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  monthly_usd REAL,                           -- NULL = aportes variables
  start_month TEXT,
  end_month   TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE contributions (
  id       TEXT PRIMARY KEY,
  goal_id  TEXT NOT NULL REFERENCES goals(id),
  date     TEXT NOT NULL,
  amount   REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('DOP','USD'))
);
CREATE INDEX contributions_goal ON contributions(goal_id, date);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO goals (id, name, monthly_usd, start_month, end_month, sort) VALUES
  ('emerg',    'Fondo de emergencia', NULL, NULL,      NULL,      0),
  ('personal', 'Ahorro personal',     NULL, NULL,      NULL,      1),
  ('turquia',  'Viaje a Turquía',     3000, '2026-08', '2027-10', 2);

INSERT INTO settings (key, value) VALUES ('default_rate', '58.76');
