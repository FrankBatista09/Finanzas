-- FE Finance: varias tarjetas de crédito con nombre, opcionales. Hasta aquí había UNA implícita por mes (0009 y 0010):
--  · months.card_other   → month_cards.other (una fila por mes y tarjeta; solo las ≠ 0)
--  · card_payments       → gana card_id (clave foránea a credit_cards)
--  · fixed_expenses.on_card sigue siendo la casilla; card_id dice a qué tarjeta (NULL = la primera activa)
--  · transactions.card_id: solo cuenta con método 'Credit card' (NULL = la primera activa)
-- months.card_other / card_paid / card_account_id se quedan en su sitio, sin que la app los lea ni los escriba.
--
-- La base de producción tiene datos reales. A cada usuario con CUALQUIER dato de tarjeta (otros cargos ≠ 0, un pago, un
-- gasto fijo en tarjeta o una transacción con 'Credit card') se le crea una tarjeta 'Credit card' (id 'card') en su
-- moneda principal, sin límite ni fechas, y todo lo suyo pasa a apuntarla: los totales, saldos, usado y pendiente
-- salen idénticos. Quien no usaba la tarjeta no recibe ninguna. Los importes siguen igual: antes eran de la moneda
-- principal y la tarjeta nace en ella.

CREATE TABLE credit_cards (
  user_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  bank         TEXT,
  last4        TEXT,
  currency     TEXT NOT NULL CHECK (currency IN ('DOP','USD','TRY')),
  credit_limit REAL CHECK (credit_limit IS NULL OR credit_limit > 0),
  cutoff_day   INTEGER CHECK (cutoff_day IS NULL OR (cutoff_day BETWEEN 1 AND 31)),
  due_day      INTEGER CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE month_cards (
  user_id   TEXT NOT NULL,
  month_key TEXT NOT NULL,
  card_id   TEXT NOT NULL,
  other     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month_key, card_id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, card_id) REFERENCES credit_cards(user_id, id)
);

-- Una clave foránea compuesta no se puede añadir con ALTER: se guarda una copia de los pagos, se rehace la tabla y se
-- vuelven a insertar en el mismo orden. Nadie referencia a card_payments; su índice se borra con ella y se crea de nuevo.
CREATE TABLE card_payments_copy AS SELECT user_id, id, month_key, date, account_id, amount, sort FROM card_payments ORDER BY rowid;
DROP TABLE card_payments;

ALTER TABLE fixed_expenses ADD COLUMN card_id TEXT;
ALTER TABLE transactions ADD COLUMN card_id TEXT;

-- Quién tiene datos de tarjeta, y en qué moneda principal (una guardada que no sea DOP/USD/TRY cuenta como DOP).
INSERT INTO credit_cards (user_id, id, name, bank, last4, currency, credit_limit, cutoff_day, due_day, active, sort)
SELECT u.user_id, 'card', 'Credit card', NULL, NULL,
       COALESCE((SELECT s.value FROM settings s WHERE s.user_id = u.user_id AND s.key = 'main_currency' AND s.value IN ('DOP','USD','TRY')), 'DOP'),
       NULL, NULL, NULL, 1, 0
FROM (
  SELECT user_id FROM months WHERE card_other <> 0
  UNION SELECT user_id FROM card_payments_copy
  UNION SELECT user_id FROM fixed_expenses WHERE on_card = 1
  UNION SELECT user_id FROM transactions WHERE method = 'Credit card'
) u;

INSERT INTO month_cards (user_id, month_key, card_id, other)
SELECT user_id, key, 'card', card_other FROM months WHERE card_other <> 0 ORDER BY rowid;

UPDATE fixed_expenses SET card_id = 'card' WHERE on_card = 1;
UPDATE transactions SET card_id = 'card' WHERE method = 'Credit card';

CREATE TABLE card_payments (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  month_key  TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  date       TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  account_id TEXT NOT NULL,                   -- cuenta de la que sale
  amount     REAL NOT NULL,                   -- en la moneda de la tarjeta
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id),
  FOREIGN KEY (user_id, card_id) REFERENCES credit_cards(user_id, id)
);
CREATE INDEX card_payments_month ON card_payments(user_id, month_key, sort);

INSERT INTO card_payments (user_id, id, month_key, card_id, date, account_id, amount, sort)
SELECT user_id, id, month_key, 'card', date, account_id, amount, sort FROM card_payments_copy ORDER BY rowid;

DROP TABLE card_payments_copy;
