import { memo, useMemo, useState } from 'react';
import { outsideOf, outsideSummary } from '../../../shared/calc';
import { CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { OutsideExpense } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import { AddButton, AddRow, AddRowButton, Card, CardHeader, CellDate, CellNumber, CellSelect, CellText, DeleteButton, Num, SheetTable, Td, Th, useAddRow } from '../../ui';
import type { AddRowControl } from '../../ui';
import { afterOutsideAdded, canAddOutside, draftAccount, draftCurrency, newOutsideDraft, outsideInput } from './drafts';
import type { OutsideDraft } from './drafts';
import { NotesCell } from './NotesCell';
import { MAX_LEN, rowAccountOptions } from './rows';
import { MES } from './strings';
import styles from './TransactionsCard.module.css';

/** Lo que MesScreen guarda para que el enlace de "Transaction history" pueda abrir esta tarjeta aunque no se vea. */
export interface OutsideAdding {
  control: AddRowControl;
  draft: OutsideDraft;
  setDraft: (update: (draft: OutsideDraft) => OutsideDraft) => void;
}

export function useOutsideAdding(): OutsideAdding {
  const [draft, setDraft] = useState(newOutsideDraft);
  const control = useAddRow(() => setDraft(newOutsideDraft()));
  return { control, draft, setDraft };
}

/** La tarjeta se ve cuando el mes tiene alguno o cuando se abre su fila de agregar; si no, no existe (sin tabla vacía). */
export function outsideCardVisible(count: number, adding: OutsideAdding): boolean {
  return count > 0 || adding.control.open;
}

/**
 * "Outside budget": gastos que salen de una cuenta (le restan al saldo como una transacción) pero no son parte del
 * presupuesto: no cuentan en lo usado, lo disponible ni las categorías. La cabecera dice cuántos hay y cuánto suman.
 */
export function OutsideCard({ adding: { control, draft, setDraft } }: { adding: OutsideAdding }) {
  const { state, monthKey, month, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, draftDate, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';
  const summary = outsideSummary(state, monthKey);

  const add = () => {
    if (!canAddOutside(draft) || !actions.addOutside(outsideInput(draft, draftDate, ctx))) return false;
    setDraft(afterOutsideAdded);
    return true;
  };

  return (
    <Card>
      <CardHeader
        wrap
        title={s('outsideTitle')}
        meta={
          <>
            {s('outsideMeta', { count: summary.count })} <Num tone="ink">{f2(summary.total)} {main}</Num>
          </>
        }
        action={!readOnly && <AddRowButton control={control}>{s('addOutside')}</AddRowButton>}
      />
      <SheetTable minWidth={900} label={s('outsideTitle')}>
        <thead>
          <tr>
            <Th width={128}>{t('date')}</Th>
            <Th>{s('description')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right" width={100}>
              {t('amount')}
            </Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th align="right">{main}</Th>
            <Th align="right">{second}</Th>
            <Th>{s('notes')}</Th>
            <Th blank width={56} />
          </tr>
        </thead>
        <tbody>
          {!readOnly && (
            <AddRow control={control} onAdd={add}>
              <Td kind="edit">
                <CellDate value={draft.date ?? draftDate} onCommit={(date) => setDraft((d) => ({ ...d, date }))} label={s('newOutsideDate')} />
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.name}
                  onCommit={(name) => setDraft((d) => ({ ...d, name }))}
                  placeholder={s('newOutside')}
                  maxLength={MAX_LEN.desc}
                  label={s('newOutside')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={draftAccountId}
                  options={accountOptions(draftAccountId)}
                  minWidth={130}
                  onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
                  label={s('newOutsideAccount')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  placeholder="0.00"
                  label={s('newOutsideAmount')}
                />
              </Td>
              <Td kind="edit">
                {/* Mientras no se toque, la moneda es la de la cuenta elegida. */}
                <CellSelect
                  value={draftCurrency(draft, ctx)}
                  options={CURRENCIES}
                  onCommit={(cur) => setDraft((d) => ({ ...d, cur }))}
                  mono
                  dense
                  label={s('newOutsideCurrency')}
                />
              </Td>
              <Td kind="edit" colSpan={3}>
                <CellText
                  value={draft.desc}
                  onCommit={(desc) => setDraft((d) => ({ ...d, desc }))}
                  placeholder={s('notesOptional')}
                  maxLength={MAX_LEN.notes}
                  label={s('newOutsideNotes')}
                />
              </Td>
              <Td kind="add">
                <AddButton />
              </Td>
            </AddRow>
          )}
          {[...outsideOf(month)]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
            .map((o) => {
              const money = inBoth(o.amount, o.cur, undefined, o.date);
              return (
                <OutsideRow
                  key={o.id}
                  row={o}
                  inMain={money.main}
                  inSecond={money.second}
                  accounts={rowAccountOptions(visible, accounts, o.accountId)}
                  readOnly={readOnly}
                  actions={actions}
                />
              );
            })}
        </tbody>
      </SheetTable>
    </Card>
  );
}

interface OutsideRowProps {
  row: OutsideExpense;
  inMain: number;
  inSecond: number;
  accounts: readonly AccountOption[];
  readOnly: boolean;
  actions: Actions;
}

const OutsideRow = memo(function OutsideRow({ row, inMain, inSecond, accounts, readOnly, actions }: OutsideRowProps) {
  const { t } = useI18n();
  const s = useStrings(MES);
  const named = { name: row.name };
  return (
    <tr>
      <Td kind="edit">
        <CellDate value={row.date} onCommit={(date) => actions.patchOutside(row.id, { date })} readOnly={readOnly} tone="soft" label={s('dateOf', named)} />
      </Td>
      <Td kind="edit">
        <CellText
          value={row.name}
          onCommit={(name) => actions.patchOutside(row.id, { name })}
          commitOn="blur"
          readOnly={readOnly}
          maxLength={MAX_LEN.desc}
          label={s('description')}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={row.accountId}
          options={accounts}
          onCommit={(accountId) => actions.patchOutside(row.id, { accountId })}
          disabled={readOnly}
          tone="soft"
          label={s('accountOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellNumber value={row.amount} onCommit={(amount) => actions.patchOutside(row.id, { amount })} readOnly={readOnly} label={s('amountOf', named)} />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={row.cur}
          options={CURRENCIES}
          onCommit={(cur) => actions.patchOutside(row.id, { cur })}
          disabled={readOnly}
          mono
          dense
          label={s('currencyOf', named)}
        />
      </Td>
      <Td kind="num" nowrap medium>
        {f2(inMain)}
      </Td>
      <Td kind="num" nowrap tone="muted">
        {f2(inSecond)}
      </Td>
      <NotesCell value={row.desc} onCommit={(desc) => actions.patchOutside(row.id, { desc })} readOnly={readOnly} name={row.name} />
      <Td kind="action">
        {!readOnly && (
          <>
            <button
              type="button"
              className={styles.moveButton}
              onClick={() => actions.moveOutsideToBudget(row.id)}
              aria-label={s('moveToBudget', named)}
              title={s('moveToBudget', named)}
            >
              ↖
            </button>
            <DeleteButton onClick={() => actions.removeOutside(row.id)} label={t('deleteNamed', named)} />
          </>
        )}
      </Td>
    </tr>
  );
});
