-- FE Finance: tasa propia por ingreso y por aporte, e ingresos recurrentes.
-- `rate` es la cantidad de moneda PRINCIPAL por 1 de la moneda de la fila (igual que MonthRate/Transfer.rate);
-- NULL = automática: la tasa vigente en la fecha de la fila, como hasta ahora. Los datos que ya existen quedan
-- con NULL y con recurring = 0, así que ninguna cifra cambia.
ALTER TABLE incomes ADD COLUMN rate REAL;
ALTER TABLE incomes ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contributions ADD COLUMN rate REAL;
-- Cuenta de la que sale un aporte (resta de su saldo). NULL = ninguna: no mueve saldos, como hasta ahora. Una
-- clave foránea compuesta (user_id, account_id) no se puede añadir con ALTER: la comprueba la app (server/db.ts).
ALTER TABLE contributions ADD COLUMN account_id TEXT;
