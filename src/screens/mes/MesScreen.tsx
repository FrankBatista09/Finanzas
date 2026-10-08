// Hoja "Mes" (prototipo, líneas 336-521): gastos mensuales, categorías, tasas, envíos e historial del mes seleccionado.
// Todo sale de useFinanzas(); el panel resumen de arriba y los diálogos de cerrar y de borrar el mes los pinta App.
// Los textos están en strings.ts (inglés, español y turco) y salen en el idioma del usuario.

import { useI18n } from '../../i18n';
import { useFinanzas } from '../../store';
import { Stack } from '../../ui';
import { CategoriesCard } from './CategoriesCard';
import { CloseBox } from './CloseBox';
import { ClosedBanner } from './ClosedBanner';
import { FixedCard } from './FixedCard';
import styles from './MesScreen.module.css';
import { RatesCard } from './RatesCard';
import { TransactionsCard } from './TransactionsCard';
import { TransfersCard } from './TransfersCard';

export function MesScreen() {
  // Un mes cerrado es de solo lectura: lleva el banner con su resumen y pierde la caja de cerrar
  // (cada tarjeta esconde por su cuenta la fila de agregar y los botones ×).
  const { readOnly, actions } = useFinanzas();
  const { t } = useI18n();
  return (
    <Stack>
      {readOnly && <ClosedBanner />}
      <div className={styles.columns}>
        <FixedCard className={styles.fixed} />
        <div className={styles.side}>
          <CategoriesCard />
          <RatesCard />
          <TransfersCard />
        </div>
      </div>
      <TransactionsCard />
      {!readOnly && <CloseBox />}
      {/* Borrar el mes, abierto o cerrado: discreto y al final. Solo abre el diálogo de confirmación, que vive en App. */}
      <div className={styles.footer}>
        <button type="button" className={styles.deleteMonth} onClick={() => actions.requestDeleteMonth()}>
          {t('deleteMonth')}
        </button>
      </div>
    </Stack>
  );
}
