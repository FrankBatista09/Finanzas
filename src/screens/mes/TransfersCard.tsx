import { memo, useMemo, useState } from 'react';
import { isMoneyAccount, transferReceived } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import type { Currency, Transfer } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import type { CommitOn } from '../../ui';
import {
  AddButton,
  AddRow,
  AddRowButton,
  ExpandableCard,
  CardHeader,
  CardNote,
  CellCheckbox,
  CellDate,
  CellNumber,
  CellSelect,
  CellText,
  DeleteButton,
  SheetTable,
  Td,
  Th,
  useAddRow,
} from '../../ui';
import {
  afterTransferAdded,
  DEFAULT_VIA,
  newTransferDraft,
  pickTransferAccount,
  swapSides,
  transferFee,
  transferInput,
  transferRate,
  transferSides,
  typeTransferRate,
} from './drafts';
import type { TransferContext } from './drafts';
import { RateCell } from './RateCell';
import { lastFee, MAX_LEN, rowAccountOptions, shortDate, transferName, viaSuggestions } from './rows';
import { MES } from './strings';
import styles from './TransfersCard.module.css';

/**
 * "Transfers": the money that goes from one account to another during the month. It leaves the origin account in its
 * currency and enters the destination account multiplied by the transfer's rate. With the "Moves budget" checkbox, the
 * month's budget moves with it: it goes down in the origin account's part and up in the destination's. The fee (what
 * the service charges, from the origin account and in its currency) goes under the rate. Rows are edited like those
 * of the other tables.
 */
export function TransfersCard() {
  const { state, monthKey, month, accounts, visibleAccounts, defaultAccount, accountOptions, rateOf, readOnly, draftDate, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTransferDraft);
  const adding = useAddRow(() => setDraft(newTransferDraft()));
  const vias = useMemo(() => viaSuggestions(state.months, monthKey), [state.months, monthKey]);
  // The same list of visible accounts as long as the accounts do not change (see FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const currencies = useMemo(() => new Map(state.accounts.filter(isMoneyAccount).map((a) => [a.id, a.currency])), [state.accounts]);

  // The draft's accounts and rate are resolved with what exists now: untouched, they follow the default
  // account and the rate in effect on the draft's date (the one the server would give a transfer with no rate).
  const date = draft.date ?? draftDate;
  const ctx: TransferContext = {
    accounts,
    visible: visibleAccounts,
    defaultAccount,
    rateOf: (from, to) => rateOf(from, to, undefined, date).rate,
    lastFee: (via) => lastFee(state.months, monthKey, via),
  };
  const sides = transferSides(draft, ctx);
  const rate = transferRate(draft, ctx);
  const fromId = sides.from?.id ?? '';
  const toId = sides.to?.id ?? '';

  const add = () => {
    const input = transferInput(draft, draftDate, ctx);
    if (!input || !actions.addTransfer(input)) return false;
    setDraft(afterTransferAdded);
    return true;
  };

  return (
    <ExpandableCard title={s('transfersTitle')} className={styles.fit}>
      <CardHeader title={s('transfersTitle')} action={!readOnly && <AddRowButton control={adding}>{s('addTransfer')}</AddRowButton>} />
      <CardNote>{s('transfersNote')}</CardNote>
      {/* Half card: origin and destination share a column, the received amount goes under the amount and the fee under the rate, to fit without scrolling. */}
      <SheetTable minWidth={520} label={s('transfersTitle')}>
        <thead>
          <tr>
            <Th>{t('date')}</Th>
            <Th>{s('via')}</Th>
            <Th>
              {t('from')} → {t('to')}
            </Th>
            <Th align="right">{t('amount')}</Th>
            <Th align="right">{t('rate')}</Th>
            <Th align="center" className={styles.budgetTh} title={t('movesBudget')} aria-label={t('movesBudget')}>
              {t('budgetShort')}
            </Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {month.transfers.map((tr) => (
            <TransferRow
              key={tr.id}
              row={tr}
              fromCur={currencies.get(tr.fromAccountId)}
              toCur={currencies.get(tr.toAccountId)}
              fromOptions={rowAccountOptions(visible, accounts, tr.fromAccountId)}
              toOptions={rowAccountOptions(visible, accounts, tr.toAccountId)}
              vias={vias}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
          {!readOnly && (
            <AddRow control={adding} onAdd={add}>
              <Td kind="edit">
                <CellDate
                  value={draft.date ?? draftDate}
                  onCommit={(date) => setDraft((d) => ({ ...d, date }))}
                  minWidth={112}
                  label={s('newTransferDate')}
                />
              </Td>
              <Td kind="edit">
                {/* Free text with suggestions. It does not stay empty: the placeholder shows which via will be used. */}
                <CellText
                  value={draft.via}
                  onCommit={(via) => setDraft((d) => ({ ...d, via }))}
                  suggestions={vias}
                  placeholder={DEFAULT_VIA}
                  minWidth={80}
                  maxLength={MAX_LEN.label}
                  label={s('newTransferVia')}
                />
              </Td>
              <Td kind="edit">
                {/* Picking the account on the other side reverses the transfer: the two are never the same. */}
                <div className={styles.route}>
                  <span className={styles.origin}>
                    <CellSelect
                      value={fromId}
                      options={accountOptions(fromId)}
                      onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'from', id))}
                      dense
                      className={styles.account}
                      label={s('newTransferFrom')}
                    />
                    <span className={styles.arrow} aria-hidden="true">
                      →
                    </span>
                  </span>
                  <CellSelect
                    value={toId}
                    options={accountOptions(toId)}
                    onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'to', id))}
                    dense
                    className={styles.account}
                    label={s('newTransferTo')}
                  />
                </div>
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  dense
                  minWidth={64}
                  placeholder="500"
                  label={s('newTransferAmount')}
                />
                {draft.amount > 0 && sides.to && <Received amount={transferReceived({ amount: draft.amount, rate: rate.rate })} cur={sides.to.currency} />}
              </Td>
              <Td kind="edit">
                {/* The month rate for the currencies of the two accounts, until the user types their own. */}
                <RateCell
                  value={rate.rate}
                  onCommit={(value) => setDraft((d) => typeTransferRate(d, value))}
                  readOnly={rate.locked}
                  minWidth={68}
                  label={s('newTransferRate')}
                />
                {/* Untouched, the fee of the last transfer through that via: each service usually charges the same. */}
                <Fee value={transferFee(draft, ctx)} onCommit={(fee) => setDraft((d) => ({ ...d, fee }))} commitOn="change" label={s('newTransferFee')} />
              </Td>
              <Td kind="center">
                <CellCheckbox checked={draft.budget} onCommit={(budget) => setDraft((d) => ({ ...d, budget }))} label={s('newTransferBudget')} />
              </Td>
              <Td kind="add" className={styles.addCell}>
                <AddButton className={styles.addButton} />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </ExpandableCard>
  );
}

/** What enters the destination account (amount × rate), as a dimmed second line under the amount: "= 9,600.00 TRY". */
function Received({ amount, cur }: { amount: number; cur: Currency | undefined }) {
  const { t } = useI18n();
  return (
    <div className={styles.received} title={t('received')}>
      = {f2(amount)} {cur}
    </div>
  );
}

/**
 * The transfer's fee, as a second line under the rate: a dimmed label and its field, in the origin account's
 * currency (the same as the amount's). Empty means "no fee".
 */
function Fee({ value, onCommit, readOnly, commitOn, label }: { value: number; onCommit: (fee: number) => void; readOnly?: boolean; commitOn: CommitOn; label: string }) {
  const { t } = useI18n();
  return (
    <label className={styles.fee}>
      <span className={styles.feeLabel}>{t('fee')}</span>
      <CellNumber value={value} onCommit={onCommit} readOnly={readOnly} blankZero commitOn={commitOn} dense minWidth={58} placeholder={readOnly ? undefined : '0.00'} label={label} className={styles.feeInput} />
    </label>
  );
}

interface TransferRowProps {
  row: Transfer;
  /** Currencies of the origin and destination accounts; undefined if the account no longer exists. */
  fromCur: Currency | undefined;
  toCur: Currency | undefined;
  fromOptions: readonly AccountOption[];
  toOptions: readonly AccountOption[];
  vias: readonly string[];
  readOnly: boolean;
  actions: Actions;
}

/** memo: editing a cell re-renders only its row. */
const TransferRow = memo(function TransferRow({ row: tr, fromCur, toCur, fromOptions, toOptions, vias, readOnly, actions }: TransferRowProps) {
  const s = useStrings(MES);
  // The transfer's via and date, for the labels of its cells ("Rate of Remitly 02/10").
  const named = { name: transferName(tr) };
  // Between accounts of the same currency the rate is 1 and is not typed.
  const sameCurrency = fromCur !== undefined && fromCur === toCur;
  const pick = (side: 'from' | 'to', id: string) => actions.patchTransfer(tr.id, swapSides(tr, side, id));
  return (
    <tr>
      <Td kind="edit">
        <CellDate
          value={tr.date}
          onCommit={(date) => actions.patchTransfer(tr.id, { date })}
          readOnly={readOnly}
          minWidth={112}
          label={s('dateOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellText
          value={tr.via}
          onCommit={(via) => actions.patchTransfer(tr.id, { via })}
          readOnly={readOnly}
          suggestions={vias}
          minWidth={80}
          maxLength={MAX_LEN.label}
          label={s('viaOf', named)}
        />
      </Td>
      <Td kind="edit">
        <div className={styles.route}>
          <span className={styles.origin}>
            <CellSelect
              value={tr.fromAccountId}
              options={fromOptions}
              onCommit={(id) => pick('from', id)}
              disabled={readOnly}
              dense
              className={styles.account}
              label={s('fromOf', named)}
            />
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          </span>
          <CellSelect
            value={tr.toAccountId}
            options={toOptions}
            onCommit={(id) => pick('to', id)}
            disabled={readOnly}
            dense
            className={styles.account}
            label={s('toOf', named)}
          />
        </div>
      </Td>
      <Td kind="edit">
        {/* The amount leaves in the origin account's currency: its code goes next to it, inside the cell. */}
        <div className={styles.withCode}>
          <CellNumber
            value={tr.amount}
            onCommit={(amount) => actions.patchTransfer(tr.id, { amount })}
            readOnly={readOnly}
            dense
            minWidth={64}
            label={s('amountOf', named)}
          />
          <span className={styles.code}>{fromCur}</span>
        </div>
        <Received amount={transferReceived(tr)} cur={toCur} />
      </Td>
      <Td kind="edit">
        <RateCell
          value={tr.rate}
          onCommit={(rate) => actions.patchTransfer(tr.id, { rate })}
          readOnly={readOnly || sameCurrency}
          minWidth={68}
          label={s('rateOf', named)}
        />
        <Fee value={tr.fee} onCommit={(fee) => actions.patchTransfer(tr.id, { fee })} readOnly={readOnly} commitOn="blur" label={s('feeOf', named)} />
      </Td>
      <Td kind="center">
        <CellCheckbox
          checked={tr.budget}
          onCommit={(budget) => actions.patchTransfer(tr.id, { budget })}
          disabled={readOnly}
          label={s('transferBudgetOf', named)}
        />
      </Td>
      <Td kind="action">
        {!readOnly && <DeleteButton compact kind="kindTransfer" item={`${named.name} · ${f2(tr.amount)} ${fromCur ?? ''}`.trim()} onConfirm={() => actions.removeTransfer(tr.id)} label={s('deleteTransfer', { date: shortDate(tr.date) })} />}
      </Td>
    </tr>
  );
});
