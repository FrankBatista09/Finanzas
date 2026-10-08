import { useId } from 'react';
import { f0, f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { cx } from '../../ui';
import styles from './ClosedBanner.module.css';
import { MES } from './strings';

/** Resumen de un mes cerrado, en la moneda principal, con el botón para reabrirlo. Solo se pinta en meses cerrados. */
export function ClosedBanner() {
  const { monthKey, calc, main, actions } = useFinanzas();
  const { t, label } = useI18n();
  const s = useStrings(MES);
  const titleId = useId();
  return (
    <section className={styles.banner} aria-labelledby={titleId}>
      <div className={styles.heading}>
        <h2 id={titleId} className={styles.title}>
          {t('summaryOf', { month: label(monthKey) })}
        </h2>
        <div className={styles.note}>
          {s('closedNote')} {s('amountsIn', { currency: main })}
        </div>
      </div>
      <div className={styles.stats}>
        <Stat name={t('income')} value={f0(calc.income)} />
        <Stat name={s('spent')} value={f2(calc.used)} />
        <Stat name={s('saved')} value={f0(calc.saved)} />
        <Stat name={s('vsBudget')} value={f2(calc.avail)} className={calc.avail < 0 ? styles.valueOver : styles.valueOk} />
      </div>
      <button type="button" className={styles.reopen} onClick={() => actions.reopenMonth()}>
        {s('reopen')}
      </button>
    </section>
  );
}

function Stat({ name, value, className }: { name: string; value: string; className?: string }) {
  return (
    <div>
      {name}
      <div className={cx(styles.value, className)}>{value}</div>
    </div>
  );
}
