import { cardCalc, cardHint, cardUtilization } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { DeleteButton, Dialog, DialogButton, NumberField } from '../../ui';
import { cardItems } from './cardItems';
import { isFullyPaid } from './cardPay';
import { PayHint } from './CreditCardsCard';
import styles from './CardDetailsDialog.module.css';
import { MES } from './strings';

interface Props {
  cardId: string;
  onClose: () => void;
  /** Opens the pay dialog (the screen owns it, so it also works from the expanded table). */
  onPay: () => void;
}

/**
 * The breakdown behind a credit card's row in "Monthly expenses", for the month being viewed: previous balance, other
 * charges (editable while the month is open), everything charged this month item by item, what was paid and what is left.
 * With a limit and a cutoff it also shows the utilization and the same 10 % hint as the "Credit cards" card.
 */
export function CardDetailsDialog({ cardId, onClose, onPay }: Props) {
  const { state, monthKey, accounts, readOnly, latestMonth, today, actions } = useFinanzas();
  const { lang } = useI18n();
  const s = useStrings(MES);
  const calc = cardCalc(state, monthKey, cardId);
  const { card, cur } = calc;
  const items = cardItems(state, monthKey, cardId);
  const left = Math.max(0, calc.remainder);
  const fullyPaid = isFullyPaid(calc.remainder);
  const util = cardUtilization(card, calc.remainder);
  // As in "Credit cards": the hint only makes sense in the latest month.
  const hint = latestMonth ? cardHint(card, calc.remainder, today) : null;
  const money = (n: number) => `${f2(n)} ${cur}`;

  return (
    <Dialog
      title={card.name}
      onCancel={onClose}
      maxWidth={560}
      footer={
        <>
          <DialogButton variant="quiet" onClick={onClose}>
            {s('payCardClose')}
          </DialogButton>
          {!readOnly && !fullyPaid && (
            <DialogButton variant="primary" onClick={onPay}>
              {s('cardPay')}
            </DialogButton>
          )}
        </>
      }
    >
      <div className={styles.body}>
        <Line label={s('cardPrev')} value={money(calc.previous)} />
        <div className={styles.line}>
          <span>{s('cardOtherCharges')}</span>
          {readOnly ? (
            <span className={styles.value}>{money(calc.other)}</span>
          ) : (
            <span className={styles.edit}>
              <NumberField value={calc.other} onCommit={(other) => actions.setCardOther(cardId, other)} className={styles.input} aria-label={s('cardOther', { name: card.name })} />
              <span className={styles.cur}>{cur}</span>
            </span>
          )}
        </div>
        <Line label={s('cardChargedMonth')} value={money(calc.charged)} />
        {items.length === 0 ? (
          <p className={styles.empty}>{s('cardNoItems')}</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={`${item.kind}-${item.id}`} className={styles.item}>
                <span className={styles.itemName}>{item.name}</span>
                <span className={styles.itemDate}>{item.date ?? s('cardMonthly')}</span>
                <span className={styles.value}>
                  {f2(item.amount)} {item.cur}
                  {item.cur !== cur && <span className={styles.converted}>{s('cardItemConverted', { amount: f2(item.converted), currency: cur })}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Line label={s('cardTotalOwed')} value={money(calc.total)} strong />
        <h3 className={styles.heading}>{s('payCardPayments')}</h3>
        {calc.payments.length === 0 ? (
          <p className={styles.empty}>{s('cardNoPayments')}</p>
        ) : (
          <ul className={styles.list}>
            {calc.payments.map((p) => {
              const account = accounts.find((a) => a.id === p.accountId)?.name ?? '—';
              return (
                <li key={p.id} className={styles.item}>
                  <span className={styles.itemName}>{account}</span>
                  <span className={styles.itemDate}>{p.date}</span>
                  <span className={styles.value}>
                    {money(p.amount)}
                    {!readOnly && <DeleteButton compact label={s('payCardRemove', { amount: f2(p.amount), currency: cur, account, date: p.date })} onClick={() => actions.removeCardPayment(cardId, p.id)} />}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Line label={s('cardPaidLabel')} value={money(calc.paid)} />
        <Line label={s('cardRemaining')} value={money(left)} strong />
        {util !== null && (
          <div className={styles.util}>
            <Line label={s('cardUtilization')} value={s('cardUtilizationOf', { pct: (util * 100).toFixed(1), limit: f2(card.limit!), currency: cur })} />
            {hint && <PayHint card={card} hint={hint} lang={lang} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? styles.strong : styles.line}>
      <span>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
}
