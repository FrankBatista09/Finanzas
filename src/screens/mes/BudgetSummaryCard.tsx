import { budgetSummary } from '../../../shared/calc';
import { BudgetSummaryList } from '../../components/BudgetSummaryList';
import { useI18n } from '../../i18n';
import { useFinanzas } from '../../store';
import { CardHeader, ExpandableCard } from '../../ui';
import styles from './BudgetSummaryCard.module.css';

/**
 * "Month summary": how this month's budget came to be and what is left of it. It is derived from the budget log,
 * so a closed month shows it too.
 */
export function BudgetSummaryCard() {
  const { state, monthKey } = useFinanzas();
  const { t } = useI18n();
  return (
    <ExpandableCard title={t('budgetSummary')}>
      <CardHeader title={t('budgetSummary')} />
      <div className={styles.body}>
        <BudgetSummaryList summary={budgetSummary(state, monthKey)} />
      </div>
    </ExpandableCard>
  );
}
