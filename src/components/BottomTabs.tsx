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

/** Barra inferior fija: las dos hojas y, solo con las utilidades de desarrollo activas, los botones de datos. */
export function BottomTabs() {
  const { sheet, goToSheet, devTools } = useShell();
  const { user, actions } = useFinanzas();
  const { t } = useI18n();

  // Los dos actúan sobre los datos del usuario que se está viendo: la confirmación dice de quién.
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
