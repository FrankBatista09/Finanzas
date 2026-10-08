import { useState } from 'react';
import { CURRENCIES } from '../../../shared/constants';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, Card, CardHeader, CellSelect, cx, DeleteButton, SheetTable, Td, Th } from '../../ui';
import { canAddRate, EMPTY_RATE, pickRateCurrency, ratePair } from './drafts';
import { RateCell } from './RateCell';
import styles from './RatesCard.module.css';
import { showRate, shownRates, usedCurrencies } from './rows';
import { MES } from './strings';

/**
 * "Tasas del mes": la tasa con la que se convierte cada par de monedas en este mes, como "1 USD = 58.76 DOP".
 * La escrita a mano para el mes se corrige aquí mismo o se quita; de las demás se dice de dónde salen (los envíos
 * del mes, otra moneda, un mes anterior) y, si es el valor fijo de respaldo, se avisa: nadie la ha escrito.
 * La fila de agregar escribe la de cualquier par.
 */
export function RatesCard() {
  const { month, main, second, rates, visibleAccounts, readOnly, actions } = useFinanzas();
  const { t, rateHint } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(EMPTY_RATE);

  const shown = shownRates(rates, usedCurrencies(main, second, visibleAccounts, month));
  const pair = ratePair(draft, shown, main, second);

  const add = () => {
    if (!canAddRate(draft) || !actions.setMonthRate(pair[0], pair[1], draft.rate)) return false;
    // Sin par elegido, la fila pasa sola al siguiente que falte por escribir.
    setDraft(EMPTY_RATE);
    return true;
  };

  return (
    <Card>
      <CardHeader title={t('monthRates')} />
      <SheetTable label={t('monthRates')}>
        <thead>
          <tr>
            <Th>{t('from')}</Th>
            <Th align="right">{t('rate')}</Th>
            <Th>{t('to')}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const typed = r.source === 'month';
            const names = { from: r.from, to: r.to };
            return (
              <tr key={`${r.from}-${r.to}`}>
                <Td kind="mono" nowrap>
                  1 {r.from} =
                </Td>
                {typed && !readOnly ? (
                  <Td kind="edit">
                    <RateCell value={r.rate} onCommit={(rate) => actions.setMonthRate(r.from, r.to, rate)} minWidth={64} label={s('pairRate', names)} />
                  </Td>
                ) : (
                  <Td kind="num" nowrap>
                    {showRate(r.rate)}
                  </Td>
                )}
                <Td>
                  <span className={styles.code}>{r.to}</span>
                  {/* De dónde sale, cuando no es la escrita para este mes. El valor de respaldo se destaca. */}
                  {!typed && <span className={cx(styles.hint, r.source === 'default' && styles.warn)}>{rateHint(r, r.from, r.to)}</span>}
                </Td>
                <Td kind="action">
                  {typed && !readOnly && <DeleteButton compact onClick={() => actions.removeMonthRate(r.from, r.to)} label={s('deleteRate', names)} />}
                </Td>
              </tr>
            );
          })}
          {!readOnly && (
            <AddRow onAdd={add}>
              <Td kind="edit">
                {/* Elegir la moneda del otro lado invierte el par: las dos nunca son la misma. */}
                <CellSelect
                  value={pair[0]}
                  options={CURRENCIES}
                  onCommit={(cur) => setDraft((d) => ({ ...d, pair: pickRateCurrency(pair, 'from', cur) }))}
                  mono
                  dense
                  label={s('newRateFrom')}
                />
              </Td>
              <Td kind="edit">
                <RateCell
                  value={draft.rate}
                  onCommit={(rate) => setDraft((d) => ({ ...d, rate }))}
                  blankZero
                  placeholder="0.00"
                  minWidth={64}
                  label={s('newRate')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={pair[1]}
                  options={CURRENCIES}
                  onCommit={(cur) => setDraft((d) => ({ ...d, pair: pickRateCurrency(pair, 'to', cur) }))}
                  mono
                  dense
                  label={s('newRateTo')}
                />
              </Td>
              <Td kind="add">
                <AddButton>{t('addRate')}</AddButton>
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </Card>
  );
}
