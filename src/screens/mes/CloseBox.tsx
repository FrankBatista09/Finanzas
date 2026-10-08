import { nextKey } from '../../../shared/month';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import styles from './CloseBox.module.css';
import { MES } from './strings';

/** Caja punteada para cerrar el mes. El botón solo abre el modal de confirmación, que vive en App. */
export function CloseBox() {
  const { monthKey, actions } = useFinanzas();
  const { t, label } = useI18n();
  const s = useStrings(MES);
  return (
    <div className={styles.box}>
      <p className={styles.text}>{s('closeText', { next: label(nextKey(monthKey)) })}</p>
      <button type="button" className={styles.button} onClick={() => actions.requestCloseMonth()}>
        {t('closeMonth', { month: label(monthKey) })}
      </button>
    </div>
  );
}
