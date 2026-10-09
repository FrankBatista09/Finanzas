import { memo, useMemo, useRef, useState } from 'react';
import { defaultCardId, FEE_CATEGORY, isCardTx, outsideOf, transferFees } from '../../../shared/calc';
import type { TransferFee } from '../../../shared/calc';
import { CATS, CREDIT_CARD_METHOD, CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { CreditCard, Transaction } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import {
  AddButton,
  AddRow,
  AddRowButton,
  ExpandableCard,
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
  useAddRow,
} from '../../ui';
import { outsideCardVisible } from './OutsideCard';
import type { OutsideAdding } from './OutsideCard';
import { afterTxAdded, canAddTx, draftAccount, draftCurrency, newTxDraft, txInput } from './drafts';
import { NotesCell } from './NotesCell';
import { cardOptions, historyRows, labelled, MAX_LEN, methodChoices, optionsWith, rowAccountOptions, shortDate } from './rows';
import { MES } from './strings';
import styles from './TransactionsCard.module.css';

/**
 * "Historial de transacciones": la fila para agregar arriba (la abre el botón de la cabecera) y, debajo, las
 * transacciones de la más reciente a la más antigua, cada una con la cuenta de la que sale y su importe en la
 * moneda principal y en la segunda. Entre ellas van las comisiones de los envíos del mes: cuentan como una
 * transacción más (en el número y en el total de la cabecera), pero no son filas guardadas: salen del envío, así
 * que aquí solo se leen.
 */
export function TransactionsCard({ outside }: { outside: OutsideAdding }) {
  const { state, monthKey, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, draftDate, actions } = useFinanzas();
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTxDraft);
  const adding = useAddRow(() => setDraft(newTxDraft()));
  // La misma lista de cuentas visibles mientras no cambien las cuentas (ver FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';
  // El enlace de "fuera de presupuesto" solo abre la fila (nunca la cierra), va aparte del botón de su tarjeta y solo
  // se ve mientras esa tarjeta no existe: con ella a la vista, su propia cabecera tiene el botón.
  const outsideLink = useRef<HTMLButtonElement>(null);
  // La tarjeta a la que va una transacción de crédito que no dice cuál: la primera activa.
  const firstCard = defaultCardId(state);

  const add = () => {
    if (!canAddTx(draft) || !actions.addTx(txInput(draft, draftDate, ctx))) return false;
    setDraft(afterTxAdded);
    return true;
  };

  return (
    <ExpandableCard title={s('txTitle')}>
      <CardHeader
        wrap
        title={s('txTitle')}
        meta={
          <>
            {s('txMeta', { count: calc.txCount })} <Num tone="ink">{f2(calc.varSpent)} {main}</Num>
          </>
        }
        action={
          !readOnly && (
            <>
              {!outsideCardVisible(outsideOf(month).length, outside) && (
                <AddRowButton control={{ ...outside.control, buttonRef: outsideLink }} variant="link">
                  {s('addOutside')}
                </AddRowButton>
              )}
              <AddRowButton control={adding}>{s('addTx')}</AddRowButton>
            </>
          )
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
            <Th blank width={56} />
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
                <div className={styles.methodCell}>
                  <CellSelect
                    value={draft.method}
                    options={labelled(methodChoices(firstCard !== null, draft.method), methodLabel)}
                    onCommit={(method) => setDraft((d) => ({ ...d, method }))}
                    label={s('newTxMethod')}
                  />
                  {draft.method === CREDIT_CARD_METHOD && firstCard && (
                    <CellSelect
                      value={draft.cardId ?? firstCard}
                      options={cardOptions(state.cards, draft.cardId)}
                      onCommit={(cardId) => setDraft((d) => ({ ...d, cardId }))}
                      tone="soft"
                      label={s('newTxCard')}
                    />
                  )}
                </div>
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
                cards={state.cards}
                firstCard={firstCard}
                readOnly={readOnly}
                actions={actions}
              />
            );
          })}
        </tbody>
      </SheetTable>
    </ExpandableCard>
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
  /** Las tarjetas y la primera activa (a la que va una transacción de crédito que no dice cuál). */
  cards: readonly CreditCard[];
  firstCard: string | null;
  readOnly: boolean;
  actions: Actions;
}

/** memo: al editar una celda solo se vuelve a pintar su fila; las demás conservan su identidad en la caché. */
const TxRow = memo(function TxRow({ row: tx, inMain, inSecond, accounts, cards, firstCard, readOnly, actions }: TxRowProps) {
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
        <div className={styles.methodCell}>
          <CellSelect
            value={tx.method}
            options={labelled(methodChoices(firstCard !== null, tx.method), methodLabel)}
            onCommit={(method) => actions.patchTx(tx.id, { method })}
            disabled={readOnly}
            tone="soft"
            label={s('methodOf', named)}
          />
          {isCardTx(tx) && (tx.cardId ?? firstCard) && (
            <CellSelect
              value={tx.cardId ?? firstCard!}
              options={cardOptions(cards, tx.cardId ?? firstCard)}
              onCommit={(cardId) => actions.patchTx(tx.id, { cardId })}
              disabled={readOnly}
              tone="soft"
              label={s('cardOfNamed', named)}
            />
          )}
        </div>
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
      <NotesCell value={tx.notes} onCommit={(notes) => actions.patchTx(tx.id, { notes })} readOnly={readOnly} name={tx.desc} />
      <Td kind="action">
        {!readOnly && (
          <>
            <button
              type="button"
              className={styles.moveButton}
              onClick={() => actions.moveTxOutside(tx.id)}
              aria-label={s('moveOutside', named)}
              title={s('moveOutside', named)}
            >
              ↘
            </button>
            <DeleteButton onClick={() => actions.removeTx(tx.id)} label={t('deleteNamed', named)} />
          </>
        )}
      </Td>
    </tr>
  );
});
