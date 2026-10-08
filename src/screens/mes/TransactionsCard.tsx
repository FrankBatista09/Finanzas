import { memo, useMemo, useState } from 'react';
import { FEE_CATEGORY, transferFees } from '../../../shared/calc';
import type { TransferFee } from '../../../shared/calc';
import { CATS, CURRENCIES, METHODS } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { Transaction } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import {
  AddButton,
  AddRow,
  AddRowButton,
  Card,
  CardHeader,
  CellDate,
  CellNumber,
  CellSelect,
  CellText,
  DeleteButton,
  Dialog,
  DialogButton,
  Num,
  SheetTable,
  Td,
  Th,
  useAddRow,
} from '../../ui';
import { afterTxAdded, canAddTx, draftAccount, draftCurrency, newTxDraft, txInput } from './drafts';
import { historyRows, labelled, MAX_LEN, optionsWith, rowAccountOptions, shortDate } from './rows';
import { MES } from './strings';
import styles from './TransactionsCard.module.css';

/**
 * "Historial de transacciones": la fila para agregar arriba (la abre el botón de la cabecera) y, debajo, las
 * transacciones de la más reciente a la más antigua, cada una con la cuenta de la que sale y su importe en la
 * moneda principal y en la segunda. Entre ellas van las comisiones de los envíos del mes: cuentan como una
 * transacción más (en el número y en el total de la cabecera), pero no son filas guardadas: salen del envío, así
 * que aquí solo se leen.
 */
export function TransactionsCard() {
  const { state, monthKey, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, draftDate, actions } = useFinanzas();
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTxDraft);
  const adding = useAddRow(() => setDraft(newTxDraft()));
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
        action={!readOnly && <AddRowButton control={adding}>{s('addTx')}</AddRowButton>}
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
            <AddRow control={adding} onAdd={add}>
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
                  minWidth={130}
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
          {historyRows(month.tx, transferFees(state, monthKey)).map((r) => {
            if (r.kind === 'fee') {
              const money = inBoth(r.fee.amount, r.fee.cur, undefined, r.fee.date);
              return <FeeRow key={r.key} fee={r.fee} inMain={money.main} inSecond={money.second} />;
            }
            // Cada transacción, con la tasa vigente en su fecha.
            const money = inBoth(r.tx.amount, r.tx.cur, undefined, r.tx.date);
            return (
              <TxRow
                key={r.key}
                row={r.tx}
                inMain={money.main}
                inSecond={money.second}
                accounts={rowAccountOptions(visible, accounts, r.tx.accountId)}
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

/**
 * La comisión de un envío en el historial: mismas columnas que una transacción, pero en texto, sin campos ni ×.
 * No es una fila guardada: se cambia (o se quita) en el envío, y la etiqueta junto al nombre lo dice.
 */
function FeeRow({ fee, inMain, inSecond }: { fee: TransferFee; inMain: number; inSecond: number }) {
  const { catLabel } = useI18n();
  const s = useStrings(MES);
  const name = s('feeName', { via: fee.via });
  const from = s('feeFromTransfer', { date: shortDate(fee.date) });
  return (
    <tr className={styles.feeRow}>
      <Td kind="edit">
        {/* El mismo campo de fecha que las demás filas, de solo lectura: así sale en el mismo formato. */}
        <CellDate value={fee.date} readOnly tone="soft" label={s('dateOf', { name })} />
      </Td>
      <Td nowrap>
        {name}
        <span className={styles.feeTag} title={from}>
          {s('feeTag')}
        </span>
      </Td>
      <Td tone="soft">{fee.via}</Td>
      <Td>{catLabel(FEE_CATEGORY)}</Td>
      <Td />
      <Td kind="num" nowrap>
        {f2(fee.amount)}
      </Td>
      <Td kind="mono">{fee.cur}</Td>
      <Td tone="soft" className={styles.feeAccount} title={fee.account.name}>
        {fee.account.name}
      </Td>
      <Td kind="num" nowrap medium>
        {f2(inMain)}
      </Td>
      <Td kind="num" nowrap tone="muted">
        {f2(inSecond)}
      </Td>
      <Td />
      <Td kind="action" />
    </tr>
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
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(tx.notes);
  // Al cerrar se guarda lo editado; al abrir se parte de lo que haya guardado.
  const close = () => {
    setOpen(false);
    if (!readOnly && text !== tx.notes) actions.patchTx(tx.id, { notes: text });
  };
  if (!open && text !== tx.notes) setText(tx.notes);
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
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <CellText
            value={tx.notes}
            onCommit={(notes) => actions.patchTx(tx.id, { notes })}
            readOnly={readOnly}
            small
            tone="muted"
            maxLength={MAX_LEN.notes}
            label={s('notesOf', named)}
          />
          {/* La celda es estrecha: una descripción larga se abre aparte para leerla o editarla con espacio. */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={s('openNotes', named)}
            title={s('openNotes', named)}
            style={{ border: 0, background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 8px', font: 'inherit' }}
          >
            ⋯
          </button>
        </div>
        {open && (
          <Dialog
            title={tx.desc}
            onCancel={close}
            maxWidth={560}
            footer={
              <DialogButton variant="primary" onClick={close}>
                {s('closeNotes')}
              </DialogButton>
            }
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={readOnly}
              maxLength={MAX_LEN.notes}
              rows={10}
              aria-label={s('notesOf', named)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '8px 10px',
                font: 'var(--fs-body)/1.5 var(--font-ui)',
                color: 'var(--ink)',
                background: 'var(--focus-bg)',
                resize: 'vertical',
              }}
            />
          </Dialog>
        )}
      </Td>
      <Td kind="action">{!readOnly && <DeleteButton onClick={() => actions.removeTx(tx.id)} label={t('deleteNamed', named)} />}</Td>
    </tr>
  );
});
