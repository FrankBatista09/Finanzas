import { useState } from 'react';
import { CURRENCIES, GOLD_UNIT, isGold, MAX_LEN } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { Balances } from '../../../shared/calc';
import type { AppState, Income, ISODate } from '../../../shared/types';
import type { IncomeShortfall } from '../../components/budgetModel';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AddRowControl } from '../../ui';
import { AddButton, AddRow, CellCheckbox, CellDate, CellNumber, CellSelect, CellText, DeleteButton, SheetTable, Td, Th } from '../../ui';
import { incomeShortfalls } from '../../components/budgetModel';
import { Converted, FallbackNote } from './Converted';
import { RateCell } from './RateCell';
import { afterIncomeAdd, autoRate, incomeDraftInput, resolveIncomeDraft } from './model';
import type { IncomeDraft, IncomeItemView } from './model';
import styles from './IncomeTable.module.css';
import { AHORROS } from './strings';

export interface IncomeTableProps {
  /** Nombre accesible de la tabla (el título de su tarjeta). */
  label: string;
  /** Los ingresos que se ven (./model incomeItems). */
  rows: readonly IncomeItemView[];
  /** Con qué arranca la fila de agregar: EMPTY_INCOME en Savings; EMPTY_MONTH_INCOME en la hoja del mes. */
  empty: IncomeDraft;
  /** La fecha que propone la fila de agregar mientras no se elija otra. */
  date: ISODate;
  /** La fila de agregar, que abre el "+ Add income" de la cabecera de la tarjeta (useAddRow). */
  adding: AddRowControl;
  /** La hoja de un mes cerrado: se ve, pero no se agrega, edita ni elimina desde ahí (sí desde Savings). */
  readOnly?: boolean;
  /**
   * La tarjeta de la hoja del mes, que ocupa media fila: sin la columna del equivalente en la moneda principal y
   * con la casilla bajo un encabezado corto, para caber sin scroll horizontal.
   */
  compact?: boolean;
  /**
   * Savings: se ofrecen también las cuentas de oro. Un ingreso a una de ellas son gramos: sin moneda que elegir,
   * sin equivalente y sin casilla de presupuesto. En la hoja del mes el oro no aparece.
   */
  gold?: boolean;
  /** Se llama con la fecha de cada ingreso agregado (Savings salta al mes de un ingreso que cae fuera del que se ve). */
  onAdded?: (date: ISODate) => void;
}

/**
 * La tabla de ingresos, uno por uno, con la fila de agregar arriba (a petición): la comparten "Income" de Savings (todos) y
 * "Income" de la hoja del mes (los de ese mes). Cada ingreso entra a una cuenta y mueve su saldo; con la casilla
 * "Adds to budget" sube además el presupuesto del mes de su fecha. No pertenecen a un mes: en Savings se agregan,
 * editan y eliminan aunque el mes seleccionado esté cerrado.
 */
export function IncomeTable({ label, rows, empty, date, adding, readOnly = false, compact = false, gold = false, onAdded }: IncomeTableProps) {
  const { state, balances, main, accountOptions: moneyOptions, incomeAccountOptions, actions } = useFinanzas();
  const accountOptions = gold ? incomeAccountOptions : moneyOptions;
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const byId = new Map(state.incomes.map((i) => [i.id, i]));
  const shortfalls = incomeShortfalls(
    state,
    balances,
    rows.flatMap((r) => byId.get(r.id) ?? []),
  );
  const shortById = new Map(shortfalls.map((f) => [f.id, f]));

  return (
    <>
      <SheetTable label={label} minWidth={compact ? 560 : 1000}>
        <thead>
          <tr>
            <Th width={compact ? 104 : 128}>{t('date')}</Th>
            <Th>{t('description')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th width={compact ? 44 : 60}>{t('currencyShort')}</Th>
            {!compact && <Th>{t('rate')}</Th>}
            {!compact && <Th align="right">{main}</Th>}
            {compact ? (
              <Th align="center" title={t('addsToBudget')} aria-label={t('addsToBudget')}>
                {t('budgetShort')}
              </Th>
            ) : (
              <Th align="center">{t('addsToBudget')}</Th>
            )}
            {!compact && <Th align="center">{s('recurring')}</Th>}
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {/* Cerrada se desmonta: su borrador se descarta con ella. */}
          {!readOnly && adding.open && <IncomeAddRow empty={empty} date={date} adding={adding} compact={compact} gold={gold} onAdded={onAdded} />}
          {rows.map((r) => {
            const grams = isGold(r.cur);
            const named = { date: r.date, amount: r.amountText, cur: grams ? GOLD_UNIT : r.cur };
            return (
              <tr key={r.id}>
                <Td kind="edit">
                  <CellDate value={r.date} onCommit={(next) => actions.patchIncome(r.id, { date: next })} readOnly={readOnly} label={s('incomeDate')} />
                </Td>
                <Td kind="edit">
                  <CellText
                    value={r.desc}
                    onCommit={(desc) => actions.patchIncome(r.id, { desc })}
                    readOnly={readOnly}
                    minWidth={compact ? 96 : 140}
                    maxLength={MAX_LEN.desc}
                    label={t('description')}
                  />
                </Td>
                <Td kind="edit">
                  <CellSelect
                    value={r.accountId}
                    options={accountOptions(r.accountId)}
                    onCommit={(accountId) => actions.patchIncome(r.id, { accountId })}
                    disabled={readOnly || r.linked === true}
                    minWidth={compact ? 108 : undefined}
                    label={t('account')}
                  />
                </Td>
                <Td kind="edit">
                  <CellNumber value={r.amount} onCommit={(amount) => actions.patchIncome(r.id, { amount })} readOnly={readOnly} minWidth={70} label={t('amount')} />
                </Td>
                {isGold(r.cur) ? (
                  <Td kind="mono" tone="muted" title={t('gold')}>
                    {GOLD_UNIT}
                  </Td>
                ) : (
                  <Td kind="edit">
                    <CellSelect
                      value={r.cur}
                      options={CURRENCIES}
                      onCommit={(cur) => actions.patchIncome(r.id, { cur })}
                      disabled={readOnly}
                      mono
                      dense
                      label={t('currency')}
                    />
                  </Td>
                )}
                {!compact && (
                  <RateCell
                    cur={r.cur === 'XAU' ? main : r.cur}
                    main={main}
                    rate={r.rate}
                    auto={r.rateAuto}
                    onCommit={(rate) => actions.patchIncome(r.id, { rate })}
                    disabled={readOnly}
                  />
                )}
                {!compact && <Converted value={r.main} note={r.mainNote} />}
                <Td kind="center" title={r.budgetTaken ? t('incomeTakenTitle', { ...r.budgetTaken }) : undefined}>
                  <span className={styles.budgetCell}>
                    <CellCheckbox
                      checked={r.budget}
                      onCommit={(budget) => actions.patchIncome(r.id, { budget })}
                      disabled={readOnly || grams}
                      label={s('incomeBudgetOf', named)}
                    />
                    {r.budgetTaken && <TakenMark text={t('incomeTakenTitle', { ...r.budgetTaken })} />}
                    <ShortfallMark text={shortById.has(r.id) ? shortfallText(s, shortById.get(r.id)!) : null} />
                  </span>
                </Td>
                {!compact && (
                  <Td kind="center">
                    <CellCheckbox
                      checked={r.recurring}
                      onCommit={(recurring) => actions.patchIncome(r.id, { recurring })}
                      disabled={readOnly}
                      label={s('incomeRecurringOf', named)}
                    />
                  </Td>
                )}
                <Td kind="action">
                  {!readOnly &&
                    (r.linked ? (
                      <span className={styles.linked} title={t('incomeLinkedTitle')} aria-label={t('incomeLinkedTitle')} role="img">
                        ⛓
                      </span>
                    ) : (
                      <DeleteButton compact onClick={() => actions.removeIncome(r.id)} label={s('deleteIncome', named)} />
                    ))}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </SheetTable>
      {/* El asterisco que explica va en la columna convertida: sin ella no hay nada que explicar. */}
      <FallbackNote show={!compact && rows.some((r) => r.mainNote.fallback)} />
      {shortfalls.length > 0 && (
        <ul className={styles.shortList} aria-label={s('shortListLabel')}>
          {shortfalls.map((f) => (
            <li key={f.id} className={styles.shortItem}>
              <span className={styles.shortText} role="status">
                <span aria-hidden="true">⚠ </span>
                {shortfallText(s, f)} {s('shortAdvice')}
              </span>
              {!readOnly && (
                <button type="button" className={styles.shortRemove} onClick={() => actions.patchIncome(f.id, { budget: false })} aria-label={s('shortRemoveOf', { description: f.desc })}>
                  {s('shortRemove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Fila de agregar. El borrador vive aquí para que escribir en ella no repinte la lista. */
function IncomeAddRow({ empty, date, adding, compact, gold, onAdded }: Pick<IncomeTableProps, 'empty' | 'date' | 'adding' | 'compact' | 'gold' | 'onAdded'>) {
  const { state, balances, main, accountOptions: moneyOptions, incomeAccountOptions, actions } = useFinanzas();
  const accountOptions = gold ? incomeAccountOptions : moneyOptions;
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [draft, setDraft] = useState(empty);
  const shown = resolveIncomeDraft(draft, state, date, gold);
  const grams = isGold(shown.cur);
  // The draft as an income, only to ask the same question the saved rows ask.
  const asIncome: Income = { id: '', date: shown.date, desc: shown.desc, accountId: shown.accountId, amount: shown.amount, cur: shown.cur, budget: shown.budget, rate: shown.rate };

  const add = () => {
    const input = incomeDraftInput(draft, state, date, gold);
    if (!input || !actions.addIncome(input)) return false;
    onAdded?.(input.date);
    setDraft(afterIncomeAdd);
  };

  return (
    <AddRow control={adding} onAdd={add}>
      <Td kind="edit">
        <CellDate value={shown.date} onCommit={(next) => setDraft((d) => ({ ...d, date: next }))} label={s('incomeDate')} />
      </Td>
      <Td kind="edit">
        <CellText
          value={shown.desc}
          onCommit={(desc) => setDraft((d) => ({ ...d, desc }))}
          placeholder={s('incomeDescPlaceholder')}
          minWidth={compact ? 96 : 140}
          maxLength={MAX_LEN.desc}
          label={t('description')}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={shown.accountId}
          options={accountOptions(shown.accountId)}
          onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
          minWidth={compact ? 108 : undefined}
          label={t('account')}
        />
      </Td>
      <Td kind="edit">
        <CellNumber
          value={shown.amount}
          onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
          blankZero
          placeholder="0.00"
          minWidth={70}
          label={t('amount')}
        />
      </Td>
      {isGold(shown.cur) ? (
        <Td kind="mono" tone="muted" title={t('gold')}>
          {GOLD_UNIT}
        </Td>
      ) : (
        <Td kind="edit">
          <CellSelect value={shown.cur} options={CURRENCIES} onCommit={(cur) => setDraft((d) => ({ ...d, cur }))} mono dense label={t('currency')} />
        </Td>
      )}
      {!compact && (
        <RateCell
          cur={isGold(shown.cur) ? main : shown.cur}
          main={main}
          rate={shown.rate}
          auto={autoRate(state, shown.date, shown.cur)}
          onCommit={(rate) => setDraft((d) => ({ ...d, rate }))}
        />
      )}
      {/* La columna de la cifra convertida queda vacía: todavía no hay ingreso que convertir. */}
      {!compact && <Td />}
      <Td kind="center">
        <span className={styles.budgetCell}>
          <CellCheckbox checked={shown.budget} onCommit={(budget) => setDraft((d) => ({ ...d, budget }))} disabled={grams} label={s('newIncomeBudget')} />
          <ShortfallMark text={addShortText(s, state, balances, asIncome)} />
        </span>
      </Td>
      {!compact && (
        <Td kind="center">
          <CellCheckbox checked={shown.recurring} onCommit={(recurring) => setDraft((d) => ({ ...d, recurring }))} label={s('newIncomeRecurring')} />
        </Td>
      )}
      <Td kind="add">
        {/* El botón largo ("Add income") es ya el de la cabecera, que abre esta fila: aquí va el "Add" corto. */}
        <AddButton aria-label={t('addIncome')} />
      </Td>
    </AddRow>
  );
}

/** A muted dot: part of this income was taken for the budget by hand; the figures are in its tooltip. */
function TakenMark({ text }: { text: string }) {
  return (
    <span className={styles.taken} title={text} aria-label={text} role="img">
      ◐
    </span>
  );
}

type Strings = (key: 'shortLine' | 'shortLineNone', values: Record<string, string>) => string;

/** The sentence of one warning line, without the advice: used by the line and by the tooltip of the row mark. */
function shortfallText(s: Strings, f: IncomeShortfall) {
  const values = { description: f.desc || '—', account: f.accountName, available: f2(f.available), amount: f2(f.amount), cur: f.currency };
  return s(f.available > 0 ? 'shortLine' : 'shortLineNone', values);
}

/** Only the add row: the draft is not saved, so it gets the mark and its tooltip but no line below the table. */
function addShortText(s: Strings, state: AppState, balances: Balances, draft: Income) {
  const [f] = incomeShortfalls(state, balances, [draft]);
  return f ? shortfallText(s, f) : null;
}

/** Soft warning next to "Adds to budget": the account holds less than the income adds. It never blocks anything. */
function ShortfallMark({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className={styles.shortfall} title={text} aria-label={text} role="img">
      ⚠
    </span>
  );
}
