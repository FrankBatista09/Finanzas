import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddRowButton, ExpandableCard, CardHeader, CardNote, Num, useAddRow } from '../../ui';
import { IncomeTable } from '../ahorros/IncomeTable';
import { EMPTY_MONTH_INCOME, incomeItems } from '../ahorros/model';
import { MES } from './strings';

/**
 * The month's "Income": the money received outside transfers (a payment, a gift, a refund) dated in the selected
 * month. It is the same table as in Savings, with a different default: what is added here goes into the account and
 * also raises this month's budget, unless its checkbox is unchecked. With the month closed the card is read-only,
 * like the rest of the sheet: the API would accept the change (an income does not belong to a month) and it can be
 * done from Savings, but here it would move the budget of a month that looks closed.
 */
export function IncomeCard() {
  const { state, monthKey, calc, main, draftDate, readOnly } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(MES);
  const adding = useAddRow();

  return (
    <ExpandableCard title={t('income')}>
      <CardHeader
        title={t('income')}
        meta={
          <>
            {t('total')}{' '}
            <Num tone="ink">
              {f2(calc.income)} {main}
            </Num>
          </>
        }
        action={!readOnly && <AddRowButton control={adding}>{t('addIncome')}</AddRowButton>}
      />
      <CardNote>{s('incomeNote')}</CardNote>
      <IncomeTable
        label={t('income')}
        rows={incomeItems(state, lang, monthKey)}
        empty={EMPTY_MONTH_INCOME}
        date={draftDate}
        adding={adding}
        readOnly={readOnly}
        compact
      />
    </ExpandableCard>
  );
}
