-- FE Finance: tarjeta de crédito como pago diferido. Solo se añaden columnas con valor por defecto: ninguna fila
-- existente cambia ni ninguna cifra (todo queda como estaba hasta que se use la tarjeta).
--  · fixed_expenses.on_card: el gasto se paga con la tarjeta (al marcarlo se CARGA a ella, no sale de ninguna cuenta).
--  · months.card_other: "otros cargos" de la tarjeta en ese mes, en la moneda principal.
--  · months.card_paid: lo que se pagó de la tarjeta ese mes, en la moneda principal; NULL = sin pagar.
--  · months.card_account_id: cuenta de la que salió ese pago (NULL = ninguna). Una clave foránea compuesta
--    (user_id, account_id) no se puede añadir con ALTER: la comprueba la app (server/db.ts), como en 0007.
-- El saldo arrastrado de un mes a otro no se guarda: se deriva (shared/calc.ts cardCalc).
ALTER TABLE fixed_expenses ADD COLUMN on_card INTEGER NOT NULL DEFAULT 0;
ALTER TABLE months ADD COLUMN card_other REAL NOT NULL DEFAULT 0;
ALTER TABLE months ADD COLUMN card_paid REAL;
ALTER TABLE months ADD COLUMN card_account_id TEXT;
