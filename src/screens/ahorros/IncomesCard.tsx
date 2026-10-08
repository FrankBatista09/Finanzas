import { useState } from 'react';
import { f2 } from '../../../shared/format';
import { monthOf } from '../../../shared/month';
import type { ISODate, MonthKey } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddRowButton, Card, CardHeader, Num, useAddRow } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { IncomeTable } from './IncomeTable';
import { EMPTY_INCOME, incomeItems, incomeMonthKeys, incomeTotalOf, monthDraftDate } from './model';
import { AHORROS } from './strings';

/**
 * "Income": los ingresos de UN mes, del más reciente al más antiguo, con la fila de agregar arriba (la abre el
 * botón de la cabecera). El mes se elige aquí mismo (flechas y lista: los meses registrados y los que tienen
 * ingresos); arranca en el mes que se ve en la app y es independiente del de la barra superior. Los que se
 * agregan aquí no suben el presupuesto salvo que se marque su casilla. La cabecera lleva el ingreso del mes elegido.
 * Un ingreso agregado con fecha de otro mes se guarda igual y la tabla salta a ese mes, para que no parezca que se perdió.
 */
export function IncomesCard() {
  const { state, monthKey, main } = useFinanzas();
  const { t, lang, label } = useI18n();
  const s = useStrings(AHORROS);
  const adding = useAddRow();
  const { today } = useFinanzas();
  const [picked, setPicked] = useState<MonthKey | null>(null);
  const shown = picked ?? monthKey;
  const keys = incomeMonthKeys(state, shown);
  const at = keys.indexOf(shown);
  const jump = (date: ISODate) => {
    if (monthOf(date) !== shown) setPicked(monthOf(date));
  };

  const picker = (
    <span className={styles.monthPicker}>
      <button type="button" onClick={() => setPicked(keys[at - 1]!)} disabled={at <= 0} aria-label={t('prevMonth')}>
        ‹
      </button>
      <select value={shown} onChange={(e) => setPicked(e.target.value)} aria-label={s('incomeMonth')}>
        {keys.map((k) => (
          <option key={k} value={k}>
            {label(k)}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => setPicked(keys[at + 1]!)} disabled={at >= keys.length - 1} aria-label={t('nextMonth')}>
        ›
      </button>
    </span>
  );

  return (
    <Card>
      <CardHeader
        className={styles.head}
        title={s('incomesTitle')}
        meta={
          <>
            {picker}
            <Num tone="ink">
              {f2(incomeTotalOf(state, shown))} {main}
            </Num>
          </>
        }
        action={<AddRowButton control={adding}>{t('addIncome')}</AddRowButton>}
      />
      <IncomeTable
        label={s('incomesTitle')}
        rows={incomeItems(state, lang, shown, true)}
        empty={EMPTY_INCOME}
        date={monthDraftDate(shown, today)}
        adding={adding}
        gold
        onAdded={jump}
      />
    </Card>
  );
}
