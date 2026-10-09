-- FE Finance: gastos fuera de presupuesto. Le restan a su cuenta como una transacción, pero no cuentan en lo usado,
-- lo disponible, las categorías ni el conteo del mes (shared/calc.ts). Solo se añade una tabla: nada de lo que ya
-- existe cambia. Misma forma que `transactions`: se borran con su mes y la cuenta es del mismo usuario (las
-- cuentas de oro las rechaza la API, igual que en las demás tablas).
CREATE TABLE outside_expenses (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  month_key   TEXT NOT NULL,
  date        TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL,                  -- cuenta de la que sale
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX outside_month ON outside_expenses(user_id, month_key, date);
