import { fRate } from '../../../shared/format';
import type { Currency } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { CellNumber, CellSelect, Td } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { AHORROS } from './strings';

export interface RateCellProps {
  /** Row currency and main currency: the rate is main currency per 1 of the row's currency. */
  cur: Currency;
  main: Currency;
  /** Own rate; null = the month rate. */
  rate: number | null;
  /** The automatic one (the one in effect on the row's date), or null if the row has no control. */
  auto: number | null;
  onCommit: (rate: number | null) => void;
  disabled?: boolean;
}

// Low rates (not TRY→DOP, but DOP→USD) need more decimals to say anything.
const show = (n: number) => (n > 0 && n < 1 ? n.toFixed(4) : fRate(n));

/**
 * The "Rate" control of an income or a contribution: "Month rate" (automatic, with the rate in effect dimmed next to
 * it) or "Manual" (a number: how much of the main currency 1 of the row's currency is worth). No control, an empty
 * cell, when the row's currency is the main one.
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
          // Switching to Manual starts with the row's rate as of today: it gets corrected instead of typed from scratch.
          onCommit={(v) => onCommit(v === 'manual' ? Number(auto.toFixed(6)) : null)}
          disabled={disabled}
          dense
          label={`${t('rate')} (${cur}→${main})`}
        />
        {manual ? (
          <CellNumber
            value={rate}
            // An empty or 0 rate is not valid: the previous one stays.
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
