import { useState } from 'react';
import { CURRENCIES, MAX_LEN } from '../../../shared/constants';
import type { ISODate } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, CellCheckbox, CellDate, CellNumber, CellSelect, CellText, DeleteButton, SheetTable, Td, Th } from '../../ui';
import { Converted, FallbackNote } from './Converted';
import { afterIncomeAdd, incomeDraftInput, resolveIncomeDraft } from './model';
import type { IncomeDraft, IncomeItemView } from './model';
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
  /** La hoja de un mes cerrado: se ve, pero no se agrega, edita ni elimina desde ahí (sí desde Savings). */
  readOnly?: boolean;
}

/**
 * La tabla de ingresos, uno por uno, con la fila de agregar arriba: la comparten "Income" de Savings (todos) y
 * "Income" de la hoja del mes (los de ese mes). Cada ingreso entra a una cuenta y mueve su saldo; con la casilla
 * "Adds to budget" sube además el presupuesto del mes de su fecha. No pertenecen a un mes: en Savings se agregan,
 * editan y eliminan aunque el mes seleccionado esté cerrado.
 */
export function IncomeTable({ label, rows, empty, date, readOnly = false }: IncomeTableProps) {
  const { main, accountOptions, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);

  return (
    <>
      <SheetTable label={label} minWidth={820}>
        <thead>
          <tr>
            <Th width={128}>{t('date')}</Th>
            <Th>{t('description')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th align="right">{main}</Th>
            <Th align="center">{t('addsToBudget')}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {!readOnly && <IncomeAddRow empty={empty} date={date} />}
          {rows.map((r) => {
            const named = { date: r.date, amount: r.amountText, cur: r.cur };
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
                    minWidth={140}
                    maxLength={MAX_LEN.desc}
                    label={t('description')}
                  />
                </Td>
                <Td kind="edit">
                  <CellSelect
                    value={r.accountId}
                    options={accountOptions(r.accountId)}
                    onCommit={(accountId) => actions.patchIncome(r.id, { accountId })}
                    disabled={readOnly}
                    label={t('account')}
                  />
                </Td>
                <Td kind="edit">
                  <CellNumber value={r.amount} onCommit={(amount) => actions.patchIncome(r.id, { amount })} readOnly={readOnly} minWidth={70} label={t('amount')} />
                </Td>
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
                <Converted value={r.main} note={r.mainNote} />
                <Td kind="center">
                  <CellCheckbox
                    checked={r.budget}
                    onCommit={(budget) => actions.patchIncome(r.id, { budget })}
                    disabled={readOnly}
                    label={s('incomeBudgetOf', named)}
                  />
                </Td>
                <Td kind="action">
                  {!readOnly && <DeleteButton compact onClick={() => actions.removeIncome(r.id)} label={s('deleteIncome', named)} />}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </SheetTable>
      <FallbackNote show={rows.some((r) => r.mainNote.fallback)} />
    </>
  );
}

/** Fila de agregar. El borrador vive aquí para que escribir en ella no repinte la lista. */
function IncomeAddRow({ empty, date }: Pick<IncomeTableProps, 'empty' | 'date'>) {
  const { state, accountOptions, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [draft, setDraft] = useState(empty);
  const shown = resolveIncomeDraft(draft, state, date);

  const add = () => {
    const input = incomeDraftInput(draft, state, date);
    if (!input || !actions.addIncome(input)) return false;
    setDraft(afterIncomeAdd);
  };

  return (
    <AddRow onAdd={add}>
      <Td kind="edit">
        <CellDate value={shown.date} onCommit={(next) => setDraft((d) => ({ ...d, date: next }))} label={s('incomeDate')} />
      </Td>
      <Td kind="edit">
        <CellText
          value={shown.desc}
          onCommit={(desc) => setDraft((d) => ({ ...d, desc }))}
          placeholder={s('incomeDescPlaceholder')}
          minWidth={140}
          maxLength={MAX_LEN.desc}
          label={t('description')}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={shown.accountId}
          options={accountOptions(shown.accountId)}
          onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
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
      <Td kind="edit">
        <CellSelect value={shown.cur} options={CURRENCIES} onCommit={(cur) => setDraft((d) => ({ ...d, cur }))} mono dense label={t('currency')} />
      </Td>
      {/* La columna de la cifra convertida queda vacía: todavía no hay ingreso que convertir. */}
      <Td />
      <Td kind="center">
        <CellCheckbox checked={shown.budget} onCommit={(budget) => setDraft((d) => ({ ...d, budget }))} label={s('newIncomeBudget')} />
      </Td>
      <Td kind="add">
        <AddButton>{t('addIncome')}</AddButton>
      </Td>
    </AddRow>
  );
}
