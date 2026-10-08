import type { Sheet } from '../store';
import { BudgetPanel } from './BudgetPanel';
import { MoneyPanel } from './MoneyPanel';

/**
 * Panel resumen: va arriba en las dos hojas, con lo propio de cada una. En "Mes", el presupuesto (por cuenta, su
 * dona y su lista); en "Savings", el dinero total y su reparto por cuenta. Ninguna enseña lo de la otra.
 */
export function SummaryPanel({ sheet }: { sheet: Sheet }) {
  return sheet === 'ahorros' ? <MoneyPanel /> : <BudgetPanel />;
}
