import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { ExpandableCard, CardHeader, SheetTable, Td, Th } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { Converted, FallbackNote } from './Converted';
import { incomeRowViews, NO_NOTE } from './model';
import type { RateNote } from './model';
import { AHORROS } from './strings';

// La suma del mes mezcla filas con tasas distintas: aquí solo se marca que alguna usó la de respaldo.
const FALLBACK: RateNote = { hint: '', fallback: true };

/**
 * "Income by month": una fila por mes con lo que entró, lo que se apartó y qué porcentaje es, en la moneda principal.
 * Aquí no se escribe nada: el ingreso de un mes es la suma de sus ingresos (la tarjeta "Income").
 */
export function IncomeCard() {
  const { state, main } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(AHORROS);
  const rows = incomeRowViews(state, lang);

  return (
    <ExpandableCard title={t('incomeByMonth')} className={styles.income}>
      <CardHeader className={styles.head} title={t('incomeByMonth')} meta={s('incomeNote', { currency: main })} />
      <SheetTable label={t('incomeByMonth')}>
        <thead>
          <tr>
            <Th>{t('month')}</Th>
            <Th align="right">{t('income')}</Th>
            <Th align="right">{t('saved')}</Th>
            <Th align="right" last>
              {t('pctSaved')}
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <Td nowrap>{r.label}</Td>
              <Converted value={r.income} note={r.incomeFallback ? FALLBACK : NO_NOTE} />
              <Converted value={r.saved} note={r.savedFallback ? FALLBACK : NO_NOTE} />
              <Td kind="num" tone="ok" last>
                {r.pct}
              </Td>
            </tr>
          ))}
        </tbody>
      </SheetTable>
      <FallbackNote show={rows.some((r) => r.incomeFallback || r.savedFallback)} />
    </ExpandableCard>
  );
}
