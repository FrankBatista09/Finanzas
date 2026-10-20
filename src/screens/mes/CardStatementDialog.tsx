import { useState } from 'react';
import { cardStatementItems } from '../../../shared/calc';
import { CATS, CREDIT_CARD_METHOD, CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import { statementPeriod } from '../../../shared/statements';
import type { ISODate } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, AddRowButton, CellDate, CellNumber, CellSelect, CellText, cx, DeleteButton, Dialog, DialogButton, SheetTable, Td, Th, useAddRow } from '../../ui';
import { canPick, currentStatement, dayLabel, itemsIn, selection, statementCutoffs, statementTotals, stepStatement } from './cardStatement';
import styles from './CardStatementDialog.module.css';
import { afterTxAdded, canAddTx, draftCurrency, newTxDraft, txInput } from './drafts';
import { NotesCell } from './NotesCell';
import { PurchaseTag } from './PurchaseTag';
import { labelled, MAX_LEN, shortDate } from './rows';
import { MES } from './strings';

/**
 * "Transactions · <card>": the card's purchases, grouped into statements by its cutoff day. Each statement lists the
 * card's Credit-card transactions and its on-card fixed expenses with where they stand (unpaid, this month, paid). Unpaid
 * transactions are checked and added to the viewed month, as fixed monthly expenses or just marked in the transaction
 * history; that is what puts them in the card total. Paying stays where it was: the card's row in Fixed monthly expenses.
 * Read-only in a closed month.
 */
export function CardStatementDialog({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const { state, monthKey, today, readOnly, draftDate, accounts, defaultAccount, main, actions } = useFinanzas();
  const { t, lang, catLabel } = useI18n();
  const s = useStrings(MES);
  const card = state.cards.find((c) => c.id === cardId);
  const items = cardStatementItems(state, monthKey, cardId);
  const cutoffDay = card?.cutoffDay ?? null;
  const cutoffs = statementCutoffs(items, today, cutoffDay);
  const [picked, setPicked] = useState<ISODate | null>(null);
  // The statement the user stepped to, or the one containing today; a picked one that no longer exists falls back to it.
  const selected = cutoffDay ? (picked && cutoffs.includes(picked) ? picked : currentStatement(today, cutoffDay)) : null;
  const [newestFirst, setNewestFirst] = useState(false);
  const inStatement = itemsIn(items, selected);
  const shown = newestFirst ? [...inStatement].reverse() : inStatement;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [destination, setDestination] = useState<'fixed' | 'history'>('fixed');
  const sel = selection(shown, checked);
  const totals = statementTotals(shown);

  const fresh = () => ({ ...newTxDraft(), method: CREDIT_CARD_METHOD, cur: card?.cur ?? null });
  const [draft, setDraft] = useState(fresh);
  const adding = useAddRow(() => setDraft(fresh));
  const ctx = { accounts, defaultAccount, main };

  if (!card) return null;
  const cur = card.cur;
  const editable = !readOnly;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const include = () => {
    if (sel.ids.length > 0 && actions.includeCardPurchases(cardId, sel.ids, destination)) setChecked(new Set());
  };
  const add = () => {
    if (!canAddTx(draft) || !actions.addTx({ ...txInput(draft, draftDate, ctx), method: CREDIT_CARD_METHOD, cardId })) return false;
    setDraft(afterTxAdded);
    return true;
  };
  const step = (delta: number) => {
    setPicked(stepStatement(cutoffs, selected!, delta));
    setChecked(new Set());
  };
  const period = selected && cutoffDay ? statementPeriod(selected, cutoffDay) : null;
  const at = selected ? cutoffs.indexOf(selected) : -1;

  return (
    <Dialog
      size="large"
      title={s('stmtTitle', { name: card.name })}
      onCancel={onClose}
      footer={
        <>
          {editable && (
            <div className={styles.include}>
              <span className={styles.selected}>{s('purchaseSelected', { amount: f2(sel.sum), currency: cur })}</span>
              <fieldset className={styles.destination}>
                <legend>{s('stmtAddTo')}</legend>
                <label>
                  <input type="radio" name="destination" checked={destination === 'fixed'} onChange={() => setDestination('fixed')} />
                  {s('stmtToFixed')}
                </label>
                <label>
                  <input type="radio" name="destination" checked={destination === 'history'} onChange={() => setDestination('history')} />
                  {s('stmtToHistory')}
                </label>
              </fieldset>
              <DialogButton variant="primary" disabled={sel.ids.length === 0} onClick={include}>
                {s('stmtAddToMonth')}
              </DialogButton>
            </div>
          )}
          <DialogButton variant="secondary" onClick={onClose}>
            {t('close')}
          </DialogButton>
        </>
      }
    >
      <div className={styles.content}>
      <div className={styles.bar}>
        {selected && period ? (
          <div className={styles.picker}>
            <button type="button" className={styles.arrow} aria-label={s('stmtPrev')} title={s('stmtPrev')} disabled={at <= 0} onClick={() => step(-1)}>
              ‹
            </button>
            <span className={styles.statement}>
              <b>{s('stmtCutoff', { date: dayLabel(selected, lang) })}</b>
              <span className={styles.period}>
                {dayLabel(period.from, lang)} – {dayLabel(period.to, lang)}
              </span>
            </span>
            <button type="button" className={styles.arrow} aria-label={s('stmtNext')} title={s('stmtNext')} disabled={at >= cutoffs.length - 1} onClick={() => step(1)}>
              ›
            </button>
          </div>
        ) : (
          <div className={styles.picker}>
            <b>{s('stmtAll')}</b>
            <span className={styles.period}>{s('stmtNoCutoff')}</span>
          </div>
        )}
        {editable && card.active && <AddRowButton control={adding}>{s('stmtAddPurchase')}</AddRowButton>}
      </div>
      <SheetTable minWidth={900} className={styles.grid} label={s('stmtTitle', { name: card.name })}>
        <thead>
          <tr>
            <Th blank width={30} />
            <Th width={104}>
              <button type="button" className={styles.sort} onClick={() => setNewestFirst((v) => !v)} title={s(newestFirst ? 'stmtSortNewest' : 'stmtSortOldest')} aria-label={s(newestFirst ? 'stmtSortNewest' : 'stmtSortOldest')}>
                {t('date')} {newestFirst ? '▼' : '▲'}
              </button>
            </Th>
            <Th width={190}>{s('description')}</Th>
            <Th>{s('notes')}</Th>
            <Th width={110}>{s('category')}</Th>
            <Th width={100}>{s('stmtOrigin')}</Th>
            <Th align="right" width={190}>
              {t('amount')}
            </Th>
            <Th width={150}>{s('stmtStatus')}</Th>
            <Th blank width={40} />
          </tr>
        </thead>
        <tbody>
          {editable && card.active && (
            <AddRow control={adding} onAdd={add}>
              <Td kind="center" />
              <Td kind="edit">
                <CellDate value={draft.date ?? draftDate} onCommit={(date) => setDraft((d) => ({ ...d, date }))} label={s('newTxDate')} />
              </Td>
              <Td kind="edit">
                <CellText value={draft.desc} onCommit={(desc) => setDraft((d) => ({ ...d, desc }))} placeholder={s('newTx')} maxLength={MAX_LEN.desc} label={s('newTx')} />
              </Td>
              <Td kind="edit">
                <CellText value={draft.notes} onCommit={(notes) => setDraft((d) => ({ ...d, notes }))} placeholder={s('notesOptional')} maxLength={MAX_LEN.notes} label={s('newTxNotes')} />
              </Td>
              <Td kind="edit">
                <CellSelect value={draft.cat} options={labelled(CATS, catLabel)} onCommit={(cat) => setDraft((d) => ({ ...d, cat }))} label={s('newTxCategory')} />
              </Td>
              <Td kind="center" />
              <Td kind="edit">
                <div className={styles.amountCell}>
                  <CellNumber value={draft.amount} onCommit={(amount) => setDraft((d) => ({ ...d, amount }))} blankZero placeholder="0.00" label={s('newTxAmount')} />
                  <CellSelect value={draftCurrency(draft, ctx)} options={CURRENCIES} onCommit={(c) => setDraft((d) => ({ ...d, cur: c }))} mono dense label={s('newTxCurrency')} />
                </div>
              </Td>
              <Td kind="add" colSpan={2}>
                <AddButton />
              </Td>
            </AddRow>
          )}
          {shown.map((item) => (
            <tr key={`${item.kind}-${item.id}`}>
              <Td kind="center">
                {editable && canPick(item) && (
                  <input type="checkbox" className={styles.check} checked={checked.has(item.id)} onChange={() => toggle(item.id)} aria-label={s('purchaseSelect', { name: item.name })} />
                )}
              </Td>
              {item.kind === 'tx' && item.date ? (
                <>
                  <Td kind="edit">
                    <CellDate value={item.date} onCommit={(date) => actions.patchTx(item.id, { date })} readOnly={!editable} tone="soft" label={s('dateOf', { name: item.name })} />
                  </Td>
                  <Td kind="edit">
                    <CellText value={item.name} onCommit={(desc) => actions.patchTx(item.id, { desc })} commitOn="blur" readOnly={!editable} maxLength={MAX_LEN.desc} label={s('description')} />
                  </Td>
                  <NotesCell value={item.notes ?? ''} onCommit={(notes) => actions.patchTx(item.id, { notes })} readOnly={!editable} name={item.name} />
                  <Td kind="edit">
                    <CellSelect value={item.cat ?? CATS[0]} options={labelled(CATS, catLabel)} onCommit={(cat) => actions.patchTx(item.id, { cat })} disabled={!editable} label={s('category')} />
                  </Td>
                </>
              ) : (
                <>
                  <Td kind="mono" nowrap>
                    {item.date ? shortDate(item.date) : s('stmtMonthly')}
                  </Td>
                  <Td>
                    <span className={styles.name} title={item.name}>
                      {item.name}
                    </span>
                  </Td>
                  <Td />
                  <Td tone="soft">{item.cat ? catLabel(item.cat) : ''}</Td>
                </>
              )}
              <Td tone="soft">{item.kind === 'tx' ? s('stmtOriginTx') : s('stmtOriginFixed')}</Td>
              <Td kind="num" nowrap>
                {f2(item.amount)} {item.cur}
                {item.cur !== cur && <span className={styles.converted}>{s('cardItemConverted', { amount: f2(item.converted), currency: cur })}</span>}
              </Td>
              <Td>
                <PurchaseTag purchase={item} viewKey={monthKey} />
              </Td>
              <Td kind="action">
                {editable && item.kind === 'tx' && (
                  <DeleteButton kind="kindTransaction" item={`${item.name} · ${f2(item.amount)} ${item.cur}`} onConfirm={() => actions.removeTx(item.id)} label={t('deleteNamed', { name: item.name })} />
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </SheetTable>
      {shown.length === 0 && <p className={styles.empty}>{s('stmtEmpty')}</p>}
      <div className={styles.totals}>
        <span>{s('stmtTotal', { amount: f2(totals.total), currency: cur })}</span>
        <span className={cx(totals.unpaid > 0 && styles.unpaidTotal)}>{s('stmtUnpaidTotal', { amount: f2(totals.unpaid), currency: cur })}</span>
      </div>
      {shown.some((i) => i.kind === 'fixed') && <p className={styles.note}>{s('stmtFixedNote')}</p>}
      </div>
    </Dialog>
  );
}
