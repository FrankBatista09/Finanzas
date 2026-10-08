import { memo, useMemo, useState } from 'react';
import { CATS, CURRENCIES, METHODS } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { Transaction } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import {
  AddButton,
  AddRow,
  Card,
  CardHeader,
  CellDate,
  CellNumber,
  CellSelect,
  CellText,
  DeleteButton,
  Num,
  SheetTable,
  Td,
  Th,
} from '../../ui';
import { afterTxAdded, canAddTx, draftAccount, draftCurrency, newTxDraft, txInput } from './drafts';
import { labelled, MAX_LEN, optionsWith, rowAccountOptions, sortTxDesc, withMoney } from './rows';
import { MES } from './strings';

/**
 * "Historial de transacciones": la fila para agregar arriba y, debajo, las transacciones de la más reciente a la
 * más antigua, cada una con la cuenta de la que sale y su importe en la moneda principal y en la segunda.
 */
export function TransactionsCard() {
  const { state, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, draftDate, actions } = useFinanzas();
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTxDraft);
  // La misma lista de cuentas visibles mientras no cambien las cuentas (ver FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';

  const add = () => {
    if (!canAddTx(draft) || !actions.addTx(txInput(draft, draftDate, ctx))) return false;
    setDraft(afterTxAdded);
    return true;
  };

  return (
    <Card>
      <CardHeader
        wrap
        title={s('txTitle')}
        meta={
          <>
            {s('txMeta', { count: calc.txCount })} <Num tone="ink">{f2(calc.varSpent)} {main}</Num>
          </>
        }
      />
      <SheetTable minWidth={1100} label={s('txTitle')}>
        <thead>
          <tr>
            <Th width={128}>{t('date')}</Th>
            <Th>{s('description')}</Th>
            <Th>{s('place')}</Th>
            <Th width={130}>{s('category')}</Th>
            <Th width={122}>{s('method')}</Th>
            <Th align="right" width={100}>
              {t('amount')}
            </Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right">{main}</Th>
            <Th align="right">{second}</Th>
            <Th>{s('notes')}</Th>
            <Th blank width={32} />
          </tr>
        </thead>
        <tbody>
          {!readOnly && (
            <AddRow onAdd={add}>
              <Td kind="edit">
                <CellDate
                  value={draft.date ?? draftDate}
                  onCommit={(date) => setDraft((d) => ({ ...d, date }))}
                  label={s('newTxDate')}
                />
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.desc}
                  onCommit={(desc) => setDraft((d) => ({ ...d, desc }))}
                  placeholder={s('newTx')}
                  maxLength={MAX_LEN.desc}
                  label={s('newTx')}
                />
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.place}
                  onCommit={(place) => setDraft((d) => ({ ...d, place }))}
                  placeholder={s('place')}
                  maxLength={MAX_LEN.place}
                  label={s('newTxPlace')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={draft.cat}
                  options={labelled(CATS, catLabel)}
                  onCommit={(cat) => setDraft((d) => ({ ...d, cat }))}
                  label={s('newTxCategory')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={draft.method}
                  options={labelled(METHODS, methodLabel)}
                  onCommit={(method) => setDraft((d) => ({ ...d, method }))}
                  label={s('newTxMethod')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  placeholder="0.00"
                  label={s('newTxAmount')}
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
                  label={s('newTxCurrency')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={draftAccountId}
                  options={accountOptions(draftAccountId)}
                  onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
                  label={s('newTxAccount')}
                />
              </Td>
              {/* Las notas ocupan las dos columnas calculadas, y el botón la de notas y la de eliminar. */}
              <Td kind="edit" colSpan={2}>
                <CellText
                  value={draft.notes}
                  onCommit={(notes) => setDraft((d) => ({ ...d, notes }))}
                  placeholder={s('notesOptional')}
                  maxLength={MAX_LEN.notes}
                  label={s('newTxNotes')}
                />
              </Td>
              <Td kind="add" colSpan={2}>
                <AddButton />
              </Td>
            </AddRow>
          )}
          {withMoney(sortTxDesc(month.tx), inBoth).map(({ row, main: inMain, second: inSecond }) => (
            <TxRow
              key={row.id}
              row={row}
              inMain={inMain}
              inSecond={inSecond}
              accounts={rowAccountOptions(visible, accounts, row.accountId)}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
        </tbody>
      </SheetTable>
    </Card>
  );
}

interface TxRowProps {
  row: Transaction;
  /** El importe en la moneda principal y en la segunda, con las tasas del mes. */
  inMain: number;
  inSecond: number;
  /** Opciones del selector de cuenta (rows.ts rowAccountOptions). */
  accounts: readonly AccountOption[];
  readOnly: boolean;
  actions: Actions;
}

/** memo: al editar una celda solo se vuelve a pintar su fila; las demás conservan su identidad en la caché. */
const TxRow = memo(function TxRow({ row: tx, inMain, inSecond, accounts, readOnly, actions }: TxRowProps) {
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  // La descripción de la transacción, para las etiquetas de sus celdas ("Amount of Coffee").
  const named = { name: tx.desc };
  return (
    <tr>
      <Td kind="edit">
        <CellDate value={tx.date} onCommit={(date) => actions.patchTx(tx.id, { date })} readOnly={readOnly} tone="soft" label={s('dateOf', named)} />
      </Td>
      <Td kind="edit">
        <CellText
          value={tx.desc}
          onCommit={(desc) => actions.patchTx(tx.id, { desc })}
          commitOn="blur"
          readOnly={readOnly}
          maxLength={MAX_LEN.desc}
          label={s('description')}
        />
      </Td>
      <Td kind="edit">
        <CellText
          value={tx.place}
          onCommit={(place) => actions.patchTx(tx.id, { place })}
          readOnly={readOnly}
          tone="soft"
          maxLength={MAX_LEN.place}
          label={s('placeOf', named)}
        />
      </Td>
      <Td kind="edit">
        {/* Se guarda el nombre canónico y se ve el del idioma; un valor de fuera de la lista se conserva como opción. */}
        <CellSelect
          value={tx.cat}
          options={labelled(optionsWith(CATS, tx.cat), catLabel)}
          onCommit={(cat) => actions.patchTx(tx.id, { cat })}
          disabled={readOnly}
          label={s('categoryOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={tx.method}
          options={labelled(optionsWith(METHODS, tx.method), methodLabel)}
          onCommit={(method) => actions.patchTx(tx.id, { method })}
          disabled={readOnly}
          tone="soft"
          label={s('methodOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellNumber value={tx.amount} onCommit={(amount) => actions.patchTx(tx.id, { amount })} readOnly={readOnly} label={s('amountOf', named)} />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={tx.cur}
          options={CURRENCIES}
          onCommit={(cur) => actions.patchTx(tx.id, { cur })}
          disabled={readOnly}
          mono
          dense
          label={s('currencyOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={tx.accountId}
          options={accounts}
          onCommit={(accountId) => actions.patchTx(tx.id, { accountId })}
          disabled={readOnly}
          tone="soft"
          label={s('accountOf', named)}
        />
      </Td>
      <Td kind="num" nowrap medium>
        {f2(inMain)}
      </Td>
      <Td kind="num" nowrap tone="muted">
        {f2(inSecond)}
      </Td>
      <Td kind="edit">
        <CellText
          value={tx.notes}
          onCommit={(notes) => actions.patchTx(tx.id, { notes })}
          readOnly={readOnly}
          small
          tone="muted"
          maxLength={MAX_LEN.notes}
          label={s('notesOf', named)}
        />
      </Td>
      <Td kind="action">{!readOnly && <DeleteButton onClick={() => actions.removeTx(tx.id)} label={t('deleteNamed', named)} />}</Td>
    </tr>
  );
});
