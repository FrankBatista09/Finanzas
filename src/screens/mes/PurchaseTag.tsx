import type { CardPurchase } from '../../../shared/calc';
import { useI18n, useStrings } from '../../i18n';
import { cx } from '../../ui';
import styles from './PurchaseTag.module.css';
import { shortDate } from './rows';
import { MES } from './strings';

/**
 * Where a Credit-card purchase stands: "unpaid" (in no month yet), "this month" (in the card total of the viewed month, or
 * "in <month>" for another), or "paid dd/mm" (a payment covered it). Read-only, no field.
 */
export function PurchaseTag({ purchase, viewKey }: { purchase: Pick<CardPurchase, 'status' | 'includedIn' | 'payment'>; viewKey: string }) {
  const { label } = useI18n();
  const s = useStrings(MES);
  const { status, includedIn, payment } = purchase;
  const text =
    status === 'paid' && payment
      ? s('txPurchasePaid', { date: shortDate(payment.date) })
      : status === 'month' && includedIn
        ? includedIn === viewKey
          ? s('txPurchaseMonth')
          : s('txPurchaseInMonth', { month: label(includedIn) })
        : s('txPurchaseUnpaid');
  return <span className={cx(styles.tag, status === 'paid' && styles.paid, status === 'month' && styles.month)}>{text}</span>;
}
