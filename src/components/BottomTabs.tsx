import { useI18n } from '../i18n';
import type { CoreKey } from '../i18n';
import { useFinanzas, useShell } from '../store';
import type { Sheet } from '../store';
import { cx } from '../ui';
import styles from './BottomTabs.module.css';

const SHEETS: readonly { id: Sheet; name: CoreKey }[] = [
  { id: 'mes', name: 'month' },
  { id: 'ahorros', name: 'savings' },
];

/** Fixed bottom bar: the two sheets and, only with the development tools enabled, the data buttons. */
export function BottomTabs() {
  const { sheet, goToSheet, devTools } = useShell();
  const { user, actions } = useFinanzas();
  const { t } = useI18n();

  // Both act on the data of the user being viewed: the confirmation says whose.
  const reset = () => {
    if (window.confirm(t('devResetConfirm', { name: user.name }))) void actions.devReset();
  };
  const seed = () => {
    if (window.confirm(t('devSeedConfirm', { name: user.name }))) void actions.devSeed();
  };

  return (
    <nav className={styles.nav} aria-label={t('sheets')}>
      {SHEETS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={cx(styles.tab, sheet === s.id && styles.tabOn)}
          aria-current={sheet === s.id ? 'page' : undefined}
          onClick={() => goToSheet(s.id)}
        >
          {t(s.name)}
        </button>
      ))}
      <div className={styles.spacer} />
      {devTools && (
        <>
          <button type="button" className={styles.util} onClick={reset}>
            {t('devReset')}
          </button>
          <button type="button" className={cx(styles.util, styles.utilDanger)} onClick={seed}>
            {t('devSeed')}
          </button>
        </>
      )}
    </nav>
  );
}
