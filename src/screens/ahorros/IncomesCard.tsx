import { useState } from 'react';
import { f2 } from '../../../shared/format';
import { monthOf } from '../../../shared/month';
import type { ISODate, MonthKey } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddRowButton, ExpandableCard, CardHeader, Num, useAddRow } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { IncomeTable } from './IncomeTable';
import { EMPTY_INCOME, incomeItems, incomeMonthKeys, incomeTotalOf, monthDraftDate } from './model';
import { AHORROS } from './strings';

/**
 * "Income": the incomes of ONE month, from newest to oldest, with the add row on top (the header button opens it).
 * The month is picked right here (arrows and select: the recorded months and the ones that have incomes); it starts
 * on the month shown in the app and is independent of the top bar's. Incomes added here do not raise the budget
 * unless their checkbox is checked. The header carries the income of the picked month.
 * An income added with a date in another month is still saved and the table jumps to that month, so it does not look lost.
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
    <ExpandableCard title={s('incomesTitle')}>
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
    </ExpandableCard>
  );
}
