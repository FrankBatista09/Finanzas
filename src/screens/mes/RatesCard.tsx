import { useState } from 'react';
import { CURRENCIES } from '../../../shared/constants';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, Card, CardHeader, CardNote, CellDate, CellSelect, cx, DeleteButton, SheetTable, Td, Th } from '../../ui';
import { canAddRate, EMPTY_RATE, pickRateCurrency, rateDate, ratePair } from './drafts';
import { RateCell } from './RateCell';
import styles from './RatesCard.module.css';
import { rateRows, shortDate, showRate, shownRates, usedCurrencies } from './rows';
import { MES } from './strings';

/**
 * "Tasas del mes": con qué tasa se convierte cada par de monedas en este mes, como "1 USD = 58.76 DOP".
 * Las escritas a mano van con su fecha (un par puede tener varias: cada una vale desde su fecha hasta la
 * siguiente) y se corrigen o se quitan aquí mismo. De un par sin ninguna escrita en este mes se enseña la vigente
 * y de dónde sale (los envíos del mes, otra moneda, un mes anterior, o el valor fijo de respaldo, que se avisa):
 * ahí no hay nada guardado que quitar, pero escribir en su celda crea la tasa del par. La fila de agregar escribe
 * la de cualquier par, desde la fecha que se elija.
 */
export function RatesCard() {
  const { month, monthKey, main, second, rates, visibleAccounts, readOnly, draftDate, actions } = useFinanzas();
  const { t, rateHint } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(EMPTY_RATE);

  const shown = shownRates(rates, usedCurrencies(main, second, visibleAccounts, month));
  const rows = rateRows(shown, month.rates, rates, monthKey, draftDate);
  const pair = ratePair(draft, shown, main, second);
  const date = rateDate(draft, pair, rates, monthKey, draftDate);

  const add = () => {
    if (!canAddRate(draft) || !actions.setMonthRate(pair[0], pair[1], draft.rate, date)) return false;
    // Sin par ni fecha elegidos, la fila pasa sola al siguiente par que falte por escribir.
    setDraft(EMPTY_RATE);
    return true;
  };

  return (
    <Card>
      <CardHeader title={t('monthRates')} />
      <CardNote>{s('ratesNote')}</CardNote>
      <SheetTable label={t('monthRates')}>
        <thead>
          <tr>
            <Th>{s('rateSince')}</Th>
            <Th>{t('from')}</Th>
            <Th align="right">{t('rate')}</Th>
            <Th>{t('to')}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const typed = r.kind === 'typed';
            const names = { from: r.from, to: r.to, date: shortDate(r.date) };
            return (
              <tr key={r.key}>
                <Td kind="mono" tone={typed ? undefined : 'faint'} nowrap>
                  {typed ? shortDate(r.date) : '—'}
                </Td>
                <Td kind="mono" nowrap>
                  1 {r.from} =
                </Td>
                {readOnly ? (
                  <Td kind="num" nowrap>
                    {showRate(r.rate)}
                  </Td>
                ) : (
                  <Td kind="edit">
                    {/* La misma celda para las dos clases de fila: al escribir en una sin guardar, pasa a ser la escrita sin perder el foco. */}
                    <RateCell
                      value={r.rate}
                      onCommit={(rate) => actions.setMonthRate(r.from, r.to, rate, r.date)}
                      minWidth={64}
                      format={typed ? undefined : showRate}
                      label={typed ? s('pairRateSince', names) : s('pairRate', names)}
                    />
                  </Td>
                )}
                <Td>
                  <span className={styles.code}>{r.to}</span>
                  {/* De dónde sale, cuando no es una escrita en este mes. El valor de respaldo se destaca. */}
                  {!typed && <span className={cx(styles.hint, r.info.source === 'default' && styles.warn)}>{rateHint(r.info, r.from, r.to)}</span>}
                </Td>
                <Td kind="action">
                  {typed && !readOnly && (
                    <DeleteButton compact onClick={() => actions.removeMonthRate(r.from, r.to, r.date)} label={s('deleteRateSince', names)} />
                  )}
                </Td>
              </tr>
            );
          })}
          {!readOnly && (
            <AddRow onAdd={add}>
              <Td kind="edit">
                <CellDate value={date} onCommit={(next) => setDraft((d) => ({ ...d, date: next }))} label={s('newRateDate')} />
              </Td>
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
