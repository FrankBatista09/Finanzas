// Hoja "Mes" (prototipo, líneas 336-521): gastos mensuales, categorías, tasas, envíos, ingresos e historial del mes seleccionado.
// Todo sale de useFinanzas(); el panel resumen de arriba y los diálogos de cerrar y de borrar el mes los pinta App.
// Los textos están en strings.ts (inglés, español y turco) y salen en el idioma del usuario.

import { outsideOf } from '../../../shared/calc';
import { useI18n } from '../../i18n';
import { useFinanzas } from '../../store';
import { Stack } from '../../ui';
import { CategoriesCard } from './CategoriesCard';
import { useColumnCap } from './columnCap';
import { CloseBox } from './CloseBox';
import { ClosedBanner } from './ClosedBanner';
import { CreditCardsCard } from './CreditCardsCard';
import { FixedCard } from './FixedCard';
import { IncomeCard } from './IncomeCard';
import styles from './MesScreen.module.css';
import { OutsideCard, outsideCardVisible, useOutsideAdding } from './OutsideCard';
import { RatesCard } from './RatesCard';
import { TransactionsCard } from './TransactionsCard';
import { TransfersCard } from './TransfersCard';

export function MesScreen() {
  // Un mes cerrado es de solo lectura: lleva el banner con su resumen y pierde la caja de cerrar
  // (cada tarjeta esconde por su cuenta la fila de agregar y los botones ×).
  const { readOnly, actions, month } = useFinanzas();
  // Lo guarda la pantalla porque el enlace de "Transaction history" abre la tarjeta aunque todavía no se vea.
  const outside = useOutsideAdding();
  const { t } = useI18n();
  const { columns, side } = useColumnCap();
  return (
    <Stack>
      {readOnly && <ClosedBanner />}
      <div ref={columns} className={styles.columns}>
        <FixedCard className={styles.fixed} cardClassName={styles.capped} />
        <div ref={side} className={styles.side}>
          <CategoriesCard />
          <RatesCard />
          <CreditCardsCard />
        </div>
      </div>
      {/* Envíos e ingresos, uno al lado del otro con el mismo ancho y alto; cuando no caben, se apilan. */}
      <div className={styles.pair}>
        <TransfersCard />
        <IncomeCard />
      </div>
      <TransactionsCard outside={outside} />
      {outsideCardVisible(outsideOf(month).length, outside) && <OutsideCard adding={outside} />}
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
