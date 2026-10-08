import { useState } from 'react';
import { CURRENCIES, MAX_LEN } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, Card, CardHeader, CellDate, CellNumber, CellSelect, CellText, DeleteButton, Num, SheetTable, Td, Th } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { Converted, FallbackNote } from './Converted';
import { afterIncomeAdd, EMPTY_INCOME, incomeDraftInput, incomeItems, resolveIncomeDraft } from './model';
import { AHORROS } from './strings';

/**
 * "Income": los ingresos uno por uno, del más reciente al más antiguo, con la fila de agregar arriba. Cada uno entra
 * a una cuenta y mueve su saldo. No pertenecen a un mes: se agregan, editan y eliminan aunque el mes seleccionado
 * esté cerrado. La cabecera lleva el ingreso del mes seleccionado.
 */
export function IncomesCard() {
  const { state, monthKey, calc, main, accountOptions, actions } = useFinanzas();
  const { t, lang, label } = useI18n();
  const s = useStrings(AHORROS);
  const rows = incomeItems(state, lang);

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
      <SheetTable label={s('incomesTitle')} minWidth={760}>
        <thead>
          <tr>
            <Th width={128}>{t('date')}</Th>
            <Th>{t('description')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th align="right">{main}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          <IncomeAddRow />
          {rows.map((r) => (
            <tr key={r.id}>
              <Td kind="edit">
                <CellDate value={r.date} onCommit={(date) => actions.patchIncome(r.id, { date })} label={s('incomeDate')} />
              </Td>
              <Td kind="edit">
                <CellText
                  value={r.desc}
                  onCommit={(desc) => actions.patchIncome(r.id, { desc })}
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
                  label={t('account')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber value={r.amount} onCommit={(amount) => actions.patchIncome(r.id, { amount })} minWidth={70} label={t('amount')} />
              </Td>
              <Td kind="edit">
                <CellSelect value={r.cur} options={CURRENCIES} onCommit={(cur) => actions.patchIncome(r.id, { cur })} mono dense label={t('currency')} />
              </Td>
              <Converted value={r.main} note={r.mainNote} />
              <Td kind="action">
                <DeleteButton
                  compact
                  onClick={() => actions.removeIncome(r.id)}
                  label={s('deleteIncome', { date: r.date, amount: r.amountText, cur: r.cur })}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </SheetTable>
      <FallbackNote show={rows.some((r) => r.mainNote.fallback)} />
    </Card>
  );
}

/** Fila de agregar. El borrador vive aquí para que escribir en ella no repinte la lista. */
function IncomeAddRow() {
  const { state, today, accountOptions, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [draft, setDraft] = useState(EMPTY_INCOME);
  const shown = resolveIncomeDraft(draft, state, today);

  const add = () => {
    const input = incomeDraftInput(draft, state, today);
    if (!input || !actions.addIncome(input)) return false;
    setDraft(afterIncomeAdd);
  };

  return (
    <AddRow onAdd={add}>
      <Td kind="edit">
        <CellDate value={shown.date} onCommit={(date) => setDraft((d) => ({ ...d, date }))} label={s('incomeDate')} />
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
      <Td kind="add" colSpan={2}>
        <AddButton>{t('addIncome')}</AddButton>
      </Td>
    </AddRow>
  );
}
