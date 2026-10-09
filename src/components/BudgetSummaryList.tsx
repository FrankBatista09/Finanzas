import type { BudgetSummary } from '../../shared/calc';
import { useI18n } from '../i18n';
import { cx } from '../ui';
import { summaryRows } from './budgetModel';
import styles from './BudgetSummaryList.module.css';

/**
 * The month's budget story as a list: initial, what was added or taken on which date, total, spent and what is
 * left. Read-only; used by the close dialog (compact).
 */
export function BudgetSummaryList({ summary, compact = false }: { summary: BudgetSummary; compact?: boolean }) {
  const { t } = useI18n();
  const rows = summaryRows(summary, compact);
  const { main, second } = summary;
  return (
    <ul className={styles.list}>
      {rows.map((r) => {
        const closing = r.kind === 'total' || r.kind === 'spent' || r.kind === 'remaining';
        const sign = r.kind === 'addition' ? '+' : '';
        return (
          <li key={r.key} className={cx(styles.row, r.kind === 'total' && styles.total, r.strong && styles.strong)}>
            <span className={styles.label}>
              {r.date && <span className={styles.date}>{r.date} · </span>}
              {t(r.labelKey)}
              {r.note && <span className={styles.note}> · {r.note}</span>}
              {r.account && <span className={styles.soft}> · {r.account}</span>}
              {r.original && <span className={styles.soft}> ({r.original})</span>}
            </span>
            <span className={cx(styles.figure, r.negative && styles.negative)}>
              {sign}
              {r.amount} {main}
              {second && r.second !== null && closing && (
                <span className={styles.second}>
                  ≈ {r.second} {second}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
