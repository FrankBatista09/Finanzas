-- FE Finance: la comisión de un envío (lo que Remitly cobra aparte, directo de la cuenta de origen).
-- Va en la moneda de la cuenta de origen y nunca se convierte para el saldo: le resta a esa cuenta y cuenta como
-- un gasto más del mes (shared/calc.ts transferFees). No se guarda como transacción.
-- Los envíos que ya existen quedan sin comisión (0): ni los saldos ni lo usado de los meses pasados cambian.
-- (El significado de transfers.budget cambia sin tocar los datos: un envío marcado ahora MUEVE presupuesto de
-- la cuenta de origen a la de destino en vez de solo sumarlo en la de destino.)

ALTER TABLE transfers ADD COLUMN fee REAL NOT NULL DEFAULT 0;
