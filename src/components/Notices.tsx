import { useI18n } from '../i18n';
import { useShell } from '../store';
import styles from './Notices.module.css';

/** Avisos de guardado fallido y similares: no bloquean y se quitan solos. */
export function Notices() {
  const { notices, dismissNotice } = useShell();
  const { t } = useI18n();
  return (
    // El contenedor existe siempre para que los lectores de pantalla anuncien lo que se le añada.
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
