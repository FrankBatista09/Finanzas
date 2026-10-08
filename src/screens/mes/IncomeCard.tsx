import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Card, CardHeader, CardNote, Num } from '../../ui';
import { IncomeTable } from '../ahorros/IncomeTable';
import { EMPTY_MONTH_INCOME, incomeItems } from '../ahorros/model';
import { MES } from './strings';

/**
 * "Income" del mes: el dinero recibido fuera de los envíos (un pago, un regalo, un reembolso) con fecha en el mes
 * seleccionado. Es la misma tabla de Savings, con otra costumbre: lo que se agrega aquí entra a la cuenta y además
 * sube el presupuesto de este mes, salvo que se desmarque su casilla. Con el mes cerrado la tarjeta es de solo
 * lectura, como el resto de la hoja: la API sí admitiría el cambio (un ingreso no pertenece a un mes) y desde
 * Savings se puede hacer, pero aquí movería el presupuesto de un mes que se ve cerrado.
 */
export function IncomeCard() {
  const { state, monthKey, calc, main, draftDate, readOnly } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(MES);

  return (
    <Card>
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
      />
      <CardNote>{s('incomeNote')}</CardNote>
      <IncomeTable
        label={t('income')}
        rows={incomeItems(state, lang, monthKey)}
        empty={EMPTY_MONTH_INCOME}
        date={draftDate}
        readOnly={readOnly}
        compact
      />
    </Card>
  );
}
