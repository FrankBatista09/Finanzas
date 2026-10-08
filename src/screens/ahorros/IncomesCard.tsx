import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, Num } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { IncomeTable } from './IncomeTable';
import { EMPTY_INCOME, incomeItems } from './model';
import { AHORROS } from './strings';

/**
 * "Income": los ingresos uno por uno, del más reciente al más antiguo, con la fila de agregar arriba. Los que se
 * agregan aquí no suben el presupuesto salvo que se marque su casilla. La cabecera lleva el ingreso del mes
 * seleccionado.
 */
export function IncomesCard() {
  const { state, monthKey, calc, main, today } = useFinanzas();
  const { lang, label } = useI18n();
  const s = useStrings(AHORROS);

  return (
    <Card>
      <CardHeader
        className={styles.head}
        title={s('incomesTitle')}
        meta={
          <>
            {label(monthKey)}{' '}
            <Num tone="ink">
              {f2(calc.income)} {main}
            </Num>
          </>
        }
      />
      <IncomeTable label={s('incomesTitle')} rows={incomeItems(state, lang)} empty={EMPTY_INCOME} date={today} gold />
    </Card>
  );
}
