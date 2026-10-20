import { memo, useMemo, useRef, useState } from 'react';
import { cardPurchases, defaultCardId, FEE_CATEGORY, isCardTx, outsideOf, transferFees } from '../../../shared/calc';
import type { CardPurchase, TransferFee } from '../../../shared/calc';
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
import { PurchaseTag } from './PurchaseTag';
import { cardOptions, historyRows, labelled, MAX_LEN, methodChoices, optionsWith, rowAccountOptions, shortDate } from './rows';
import { MES } from './strings';
import styles from './TransactionsCard.module.css';

/**
 * "Transaction history": the add row at the top (the header button opens it) and, below, the
 * transactions from the most recent to the oldest, each with the account it comes out of and its amount in the
 * main currency and in the second one. Among them go the fees of the month's transfers: they count as one
 * more transaction (in the count and in the total of the header), but they are not stored rows: they come from the
 * transfer, so here they are read-only.
 */
export function TransactionsCard({ outside }: { outside: OutsideAdding }) {
  const { state, monthKey, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, draftDate, actions } = useFinanzas();
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTxDraft);
  const adding = useAddRow(() => setDraft(newTxDraft()));
  // The same list of visible accounts as long as the accounts do not change (see FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';
  // The "outside budget" link only opens the row (it never closes it), is separate from its card's button and only
  // shows while that card does not exist: with the card in view, its own header has the button.
  const outsideLink = useRef<HTMLButtonElement>(null);
  // The credit card a credit transaction goes to when it does not say which: the first active one.
  const firstCard = defaultCardId(state);
  // For each Credit-card purchase of the month: where it stands (unpaid, in a month's card total, paid).
  const purchases = useMemo(() => {
    const map = new Map<string, CardPurchase>();
    for (const card of state.cards) for (const p of cardPurchases(state, monthKey, card.id)) if (p.key === monthKey) map.set(p.tx.id, p);
    return map;
  }, [state, monthKey]);

  // A card purchase that no month has taken yet is not in the history: it waits in the card's statement panel until it
  // is added to a month (as a fixed expense or just to the history).
  const held = useMemo(() => new Set([...purchases].filter(([, p]) => p.status === 'unpaid').map(([id]) => id)), [purchases]);

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
            {s('txMeta', { count: calc.txCount - held.size })} <Num tone="ink">{f2(calc.varSpent)} {main}</Num>
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
            {second && <Th align="right">{second}</Th>}
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
                {/* Until it is touched, the currency is that of the chosen account. */}
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
              {/* The notes span the two computed columns, and the button the notes column and the delete column. */}
              <Td kind="edit" colSpan={second ? 2 : 1}>
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
          {historyRows(month.tx.filter((t) => !held.has(t.id)), transferFees(state, monthKey)).map((r) => {
            if (r.kind === 'fee') {
              const money = inBoth(r.fee.amount, r.fee.cur, undefined, r.fee.date);
              return <FeeRow key={r.key} fee={r.fee} inMain={money.main} inSecond={money.second} />;
            }
            // Each transaction, with the rate in effect on its date.
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
                viewKey={monthKey}
                purchase={purchases.get(r.tx.id)}
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
 * A transfer's fee in the history: same columns as a transaction, but as text, with no fields or ×.
 * It is not a stored row: it is changed (or removed) on the transfer, and the tag next to the name says so.
 */
function FeeRow({ fee, inMain, inSecond }: { fee: TransferFee; inMain: number; inSecond: number | null }) {
  const { catLabel } = useI18n();
  const s = useStrings(MES);
  const name = s('feeName', { via: fee.via });
  const from = s('feeFromTransfer', { date: shortDate(fee.date) });
  return (
    <tr className={styles.feeRow}>
      <Td kind="edit">
        {/* The same date field as the other rows, read-only: that way it shows in the same format. */}
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
      {inSecond !== null && (
        <Td kind="num" nowrap tone="muted">
          {f2(inSecond)}
        </Td>
      )}
      <Td />
      <Td kind="action" />
    </tr>
  );
}

interface TxRowProps {
  row: Transaction;
  /** The amount in the main currency and in the second one, with the month rates. */
  inMain: number;
  inSecond: number | null;
  /** Options of the account select (rows.ts rowAccountOptions). */
  accounts: readonly AccountOption[];
  /** The credit cards and the first active one (the one a credit transaction goes to when it does not say which). */
  cards: readonly CreditCard[];
  firstCard: string | null;
  /** Credit-card purchases only: where it stands; undefined = not a purchase of a card. */
  purchase: CardPurchase | undefined;
  /** The month being viewed (the status says "this month" for it). */
  viewKey: string;
  readOnly: boolean;
  actions: Actions;
}

/** memo: editing a cell re-renders only its row; the others keep their identity in the cache. */
const TxRow = memo(function TxRow({ row: tx, inMain, inSecond, accounts, cards, firstCard, purchase, viewKey, readOnly, actions }: TxRowProps) {
  const { t, catLabel, methodLabel } = useI18n();
  const s = useStrings(MES);
  // The transaction's description, for the labels of its cells ("Amount of Coffee").
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
        {/* The canonical name is stored and the language's name is shown; a value from outside the list is kept as an option. */}
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
          {isCardTx(tx) && purchase && (
            <span className={styles.settled}>
              <PurchaseTag purchase={purchase} viewKey={viewKey} />
            </span>
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
      {inSecond !== null && (
        <Td kind="num" nowrap tone="muted">
          {f2(inSecond)}
        </Td>
      )}
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
            <DeleteButton kind="kindTransaction" item={`${tx.desc} · ${f2(tx.amount)} ${tx.cur}`} onConfirm={() => actions.removeTx(tx.id)} label={t('deleteNamed', named)} />
          </>
        )}
      </Td>
    </tr>
  );
});
