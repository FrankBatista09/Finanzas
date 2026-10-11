import { useI18n } from '../i18n';
import { useShell } from '../store';
import styles from './Notices.module.css';

/** Notices for failed saves and the like: they do not block and go away on their own. */
export function Notices() {
  const { notices, dismissNotice } = useShell();
  const { t } = useI18n();
  return (
    // The container always exists so that screen readers announce whatever is added to it.
    <div className={styles.stack} role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={styles.notice}>
          <span className={styles.text}>{n.text}</span>
          <button type="button" className={styles.close} onClick={() => dismissNotice(n.id)} title={t('close')} aria-label={t('dismissNotice')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
