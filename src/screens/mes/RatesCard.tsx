import { useState } from 'react';
import { CURRENCIES } from '../../../shared/constants';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, AddRowButton, ExpandableCard, CardHeader, CardNote, CellDate, CellSelect, cx, DeleteButton, SheetTable, Td, Th, useAddRow } from '../../ui';
import { canAddRate, EMPTY_RATE, pickRateCurrency, rateDate, ratePair } from './drafts';
import { RateCell } from './RateCell';
import styles from './RatesCard.module.css';
import { currenciesInUse, noRatesNeeded, rateRows, shortDate, showRate, shownRates } from './rows';
import { MES } from './strings';

/**
 * "Month rates": the rate at which each currency pair is converted this month, as "1 USD = 58.76 DOP".
 * The ones typed by hand carry their date (a pair can have several: each one applies from its date until the
 * next) and are corrected or removed right here. A pair with none typed this month shows the rate in effect
 * and where it comes from (the month's transfers, another currency, an earlier month, or the fixed default value,
 * which is flagged): there is nothing stored to remove there, but typing in its cell creates the pair's rate. The add
 * row (the header button opens it) writes the rate of any pair, from the chosen date.
 */
export function RatesCard() {
  const { state, month, monthKey, main, second, rates, readOnly, draftDate, actions } = useFinanzas();
  const { t, rateHint } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(EMPTY_RATE);
  const adding = useAddRow(() => setDraft(EMPTY_RATE));

  const shown = shownRates(rates, currenciesInUse(state, monthKey), main);
  const rows = rateRows(shown, month.rates, rates, monthKey, draftDate);
  const pair = ratePair(draft, shown, main, second);
  const date = rateDate(draft, pair, rates, monthKey, draftDate);
  // With all the money in one currency the table is unnecessary; "Add rate" stays in case the user wants to type a standalone rate.
  const empty = noRatesNeeded(shown) && !adding.open;

  const add = () => {
    if (!canAddRate(draft) || !actions.setMonthRate(pair[0], pair[1], draft.rate, date)) return false;
    // With no pair or date chosen, the row moves on its own to the next pair still to be typed.
    setDraft(EMPTY_RATE);
    return true;
  };

  const header = <CardHeader title={t('monthRates')} action={!readOnly && <AddRowButton control={adding}>{t('addRate')}</AddRowButton>} />;
  if (empty) {
    return (
      <ExpandableCard title={t('monthRates')}>
        {header}
        <CardNote>{s('noRatesNeeded', { currency: main })}</CardNote>
      </ExpandableCard>
    );
  }

  return (
    <ExpandableCard title={t('monthRates')}>
      {header}
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
                    {/* The same cell for both kinds of row: typing in one with nothing stored makes it the typed one without losing focus. */}
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
                  {/* Where it comes from, when it is not one typed this month. The default value is highlighted. */}
                  {!typed && <span className={cx(styles.hint, r.info.source === 'default' && styles.warn)}>{rateHint(r.info, r.from, r.to)}</span>}
                </Td>
                <Td kind="action">
                  {typed && !readOnly && (
                    <DeleteButton compact kind="kindRate" item={`${names.date} · 1 ${r.from} = ${showRate(r.rate)} ${r.to}`} onConfirm={() => actions.removeMonthRate(r.from, r.to, r.date)} label={s('deleteRateSince', names)} />
                  )}
                </Td>
              </tr>
            );
          })}
          {!readOnly && (
            <AddRow control={adding} onAdd={add}>
              <Td kind="edit">
                <CellDate value={date} onCommit={(next) => setDraft((d) => ({ ...d, date: next }))} label={s('newRateDate')} />
              </Td>
              <Td kind="edit">
                {/* Choosing the currency of the other side flips the pair: the two are never the same. */}
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
                <AddButton />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </ExpandableCard>
  );
}
