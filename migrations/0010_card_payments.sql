-- FE Finance: varios pagos de la tarjeta de crédito en un mes, cada uno con su cuenta y su fecha. Sustituye a
-- months.card_paid / months.card_account_id (0009), que quedan en su sitio pero la app ya no las lee ni las escribe:
-- no se borran para no tocar datos que pueden estar en producción. Misma forma que `outside_expenses`: se borran
-- con su mes y la cuenta es del mismo usuario (las de oro las rechaza la API). Importes en la moneda principal.
CREATE TABLE card_payments (
  user_id    TEXT NOT NULL,
  id         TEXT NOT NULL,
  month_key  TEXT NOT NULL,
  date       TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  account_id TEXT NOT NULL,                   -- cuenta de la que sale
  amount     REAL NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, month_key) REFERENCES months(user_id, key) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id) REFERENCES accounts(user_id, id)
);
CREATE INDEX card_payments_month ON card_payments(user_id, month_key, sort);

-- Cada mes con card_paid pasa a ser un pago, fechado el último día del mes (la app convertía con la última tasa
-- del mes). Cuenta: la guardada si aún existe; si no, la cuenta por defecto; si no, la primera de dinero. Sin
-- ninguna cuenta no hay a qué cargarlo y el pago no se copia (card_paid sigue ahí).
INSERT INTO card_payments (user_id, id, month_key, date, account_id, amount, sort)
SELECT user_id, lower(hex(randomblob(16))), key, date(key || '-01', '+1 month', '-1 day'), account_id, card_paid, 0
FROM (
  SELECT m.user_id, m.key, m.card_paid,
    COALESCE(
      (SELECT a.id FROM accounts a WHERE a.user_id = m.user_id AND a.id = m.card_account_id AND a.currency <> 'XAU'),
      (SELECT a.id FROM accounts a JOIN settings s ON s.user_id = a.user_id AND s.key = 'default_account' AND s.value = a.id
        WHERE a.user_id = m.user_id AND a.currency <> 'XAU'),
      (SELECT a.id FROM accounts a WHERE a.user_id = m.user_id AND a.currency <> 'XAU' ORDER BY a.sort, a.rowid LIMIT 1)
    ) AS account_id
  FROM months m
  WHERE m.card_paid IS NOT NULL
)
WHERE account_id IS NOT NULL;
