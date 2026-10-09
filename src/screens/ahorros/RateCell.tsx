import { fRate } from '../../../shared/format';
import type { Currency } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { CellNumber, CellSelect, Td } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { AHORROS } from './strings';

export interface RateCellProps {
  /** Moneda de la fila y moneda principal: la tasa es principal por 1 de la moneda de la fila. */
  cur: Currency;
  main: Currency;
  /** Tasa propia; null = la del mes. */
  rate: number | null;
  /** La automática (la vigente en la fecha de la fila), o null si la fila no tiene control. */
  auto: number | null;
  onCommit: (rate: number | null) => void;
  disabled?: boolean;
}

// Las tasas bajas (TRY→DOP no, pero DOP→USD sí) necesitan más decimales para decir algo.
const show = (n: number) => (n > 0 && n < 1 ? n.toFixed(4) : fRate(n));

/**
 * El control "Rate" de un ingreso o un aporte: «Month rate» (automática, con la tasa vigente atenuada al lado) o
 * «Manual» (un número: cuánto de la moneda principal vale 1 de la moneda de la fila). Sin control, una celda vacía,
 * cuando la moneda de la fila es la principal.
 */
export function RateCell({ cur, main, rate, auto, onCommit, disabled }: RateCellProps) {
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  if (auto === null) return <Td />;
  const manual = rate !== null;
  const options = [
    { value: 'auto', label: t('monthRate') },
    { value: 'manual', label: s('rateManual') },
  ];
  const title = s('rateOf', { currency: main, from: cur });
  return (
    <Td kind="edit">
      <div className={styles.rateCell} title={title}>
        <CellSelect
          value={manual ? 'manual' : 'auto'}
          options={options}
          // Al pasar a Manual arranca con la tasa de hoy de la fila: se corrige en vez de teclear desde cero.
          onCommit={(v) => onCommit(v === 'manual' ? Number(auto.toFixed(6)) : null)}
          disabled={disabled}
          dense
          label={`${t('rate')} (${cur}→${main})`}
        />
        {manual ? (
          <CellNumber
            value={rate}
            // Una tasa vacía o 0 no vale: se queda la anterior.
            onCommit={(v) => v > 0 && onCommit(v)}
            readOnly={disabled}
            dense
            minWidth={64}
            label={`${t('rate')} (${cur}→${main})`}
          />
        ) : (
          <span className={styles.rateAuto}>{show(auto)}</span>
        )}
      </div>
    </Td>
  );
}
