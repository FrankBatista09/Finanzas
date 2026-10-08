-- FE Finance: un envío puede subir el presupuesto de su mes, como ya hacen los ingresos (incomes.budget, 0002).
-- Con budget = 1 el envío suma a la parte de la cuenta de destino lo que le entra (amount × rate); a la de origen
-- no le resta. No se escribe nada en month_budget_log: lo suma el cálculo (shared/calc.ts).
-- Los envíos que ya existen quedan en 0: el presupuesto de los meses pasados no cambia.

ALTER TABLE transfers ADD COLUMN budget INTEGER NOT NULL DEFAULT 0;
