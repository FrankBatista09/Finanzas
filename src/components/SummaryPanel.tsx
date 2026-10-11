import type { Sheet } from '../store';
import { BudgetPanel } from './BudgetPanel';
import { MoneyPanel } from './MoneyPanel';

/**
 * Summary panel: it sits at the top of both sheets, with each one's own content. In "Month", the budget (by account,
 * its donut and its list); in "Savings", the total money and its split by account. Neither shows the other's.
 */
export function SummaryPanel({ sheet }: { sheet: Sheet }) {
  return sheet === 'ahorros' ? <MoneyPanel /> : <BudgetPanel />;
}
