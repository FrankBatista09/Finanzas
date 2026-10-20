import { useId, useState } from 'react';
import { cardAccountFor, cardCalc, unsettledCardPurchases } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Select } from '../../ui';
import { canPaySelection, pendingAfter, selection } from './cardPurchases';
import { shortDate } from './rows';
import { MES } from './strings';
import styles from './UnpaidPurchases.module.css';

/** The unpaid credit card purchases of a card (up to the viewed month), for the link "Unpaid purchases (N)". */
export function useUnpaidPurchases(cardId: string) {
  const { state, monthKey } = useFinanzas();
  return unsettledCardPurchases(state, monthKey, cardId);
}

/**
 * Pick which purchases a card payment covers: the list of the card's unpaid purchases with a checkbox each, the sum of
 * the checked ones, the account to pay from and the button. What is left unchecked stays pending on the card. In a
 * closed month it is only a list. Mounted by the "Credit cards" card (when its link is open) and by the card details dialog.
 */
export function UnpaidPurchases({ cardId, maxHeight }: { cardId: string; maxHeight?: number }) {
  const { state, monthKey, readOnly, accountOptions, actions } = useFinanzas();
  const { catLabel } = useI18n();
  const s = useStrings(MES);
  const id = useId();
  const purchases = useUnpaidPurchases(cardId);
  const calc = cardCalc(state, monthKey, cardId);
  const cur = calc.cur;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [account, setAccount] = useState<string | null>(null);
  const options = accountOptions(account);
  const accountId = account ?? cardAccountFor(state, monthKey, cardId)?.id ?? '';
  const sel = selection(purchases, checked);
  const can = !readOnly && accountId !== '' && canPaySelection(sel, calc.remainder);
  const pending = pendingAfter(calc.remainder, sel.sum);

  const toggle = (txId: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(txId)) next.add(txId);
      return next;
    });
  const pay = () => {
    if (can && actions.payCardPurchases(cardId, sel.ids, accountId)) setChecked(new Set());
  };

  return (
    <div className={styles.panel}>
      <ul className={styles.list} style={maxHeight ? { maxHeight } : undefined} aria-label={s('purchasesTitle')}>
        {purchases.map(({ tx, amount }) => (
          <li key={tx.id} className={styles.row}>
            {!readOnly && <input type="checkbox" className={styles.check} checked={checked.has(tx.id)} onChange={() => toggle(tx.id)} aria-label={s('purchaseSelect', { name: tx.desc })} />}
            <span className={styles.date}>{shortDate(tx.date)}</span>
            <span className={styles.name} title={`${tx.desc} · ${catLabel(tx.cat)}`}>
              {tx.desc} · {catLabel(tx.cat)}
            </span>
            <span className={styles.amount}>
              {f2(tx.amount)} {tx.cur}
              {tx.cur !== cur && <span className={styles.converted}>{s('cardItemConverted', { amount: f2(amount), currency: cur })}</span>}
            </span>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className={styles.footer}>
          <span className={styles.selected}>{s('purchaseSelected', { amount: f2(sel.sum), currency: cur })}</span>
          <label className={styles.from} htmlFor={`${id}-account`}>
            {s('purchasePayFrom')}
            <Select id={`${id}-account`} value={accountId} options={options} onChange={setAccount} />
          </label>
          <button type="button" className={styles.pay} disabled={!can} onClick={pay}>
            {s('purchasePay')}
          </button>
          {pending > 0.005 && <span className={styles.note}>{s('purchasePending', { amount: f2(pending), currency: cur })}</span>}
        </div>
      )}
    </div>
  );
}
