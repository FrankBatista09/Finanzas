import { useId, useRef, useState } from 'react';
import { cardCalc } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { DeleteButton, Dialog, DialogButton, DialogFields, DialogText, Field, Input, Select } from '../../ui';
import { isFullyPaid, payAmount, payForm, payRest } from './cardPay';
import styles from './PayCardDialog.module.css';
import { MES } from './strings';

/**
 * "Pay credit card": opens when the checkbox of its row is clicked. It proposes paying what is left from the account
 * of the last payment; you can pay only a part and come back later (there are several payments per month). It lists
 * the payments already made, each with its ×. With everything paid it only serves to review them and remove one.
 * Mount it to open it.
 */
export function PayCardDialog({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const { state, monthKey, accountOptions, accounts, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Read once, on open: a data refresh must not overwrite what is being typed.
  const [form, setForm] = useState(() => payForm(state, monthKey, cardId));
  // The amounts are in the credit card's currency.
  const { total, paid, payments, remainder: left, card } = cardCalc(state, monthKey, cardId);
  const main = card.cur;
  const fullyPaid = isFullyPaid(left);
  const amount = payAmount(form.amount, left);
  const valid = !fullyPaid && amount !== null && form.accountId !== '';

  const confirm = () => {
    if (!valid || !actions.payCard(cardId, amount, form.accountId)) return;
    onClose();
  };

  return (
    <Dialog
      title={s('payCardTitle')}
      onCancel={onClose}
      onSubmit={confirm}
      describedBy={`${id}-body`}
      footer={
        <>
          <DialogButton ref={cancelRef} variant="quiet" onClick={onClose}>
            {fullyPaid ? s('payCardClose') : t('cancel')}
          </DialogButton>
          {!fullyPaid && (
            <DialogButton variant="primary" type="submit" disabled={!valid}>
              {s('payCardConfirm')}
            </DialogButton>
          )}
        </>
      }
    >
      <DialogText id={`${id}-body`}>
        {card.name} · {s('payCardTotal', { total: f2(total), currency: main })}
        {payments.length > 0 && ` · ${s('payCardPaid', { paid: f2(paid), currency: main })}`}
        {` · ${s('payCardLeft', { left: f2(Math.max(0, left)), currency: main })}`}
      </DialogText>
      {payments.length > 0 && (
        <ul className={styles.payments} aria-label={s('payCardPayments')}>
          {payments.map((p) => {
            const account = accounts.find((a) => a.id === p.accountId)?.name ?? '—';
            return (
              <li key={p.id} className={styles.payment}>
                <span className={styles.paymentInfo}>
                  {p.date} · {account} · {f2(p.amount)} {main}
                </span>
                <DeleteButton compact kind="kindPayment" item={`${p.date} · ${account} · ${f2(p.amount)} ${main}`} label={s('payCardRemove', { amount: f2(p.amount), currency: main, account, date: p.date })} onConfirm={() => actions.removeCardPayment(cardId, p.id)} />
              </li>
            );
          })}
        </ul>
      )}
      {!fullyPaid && (
        <>
          <DialogText>{s('payCardBody')}</DialogText>
          <DialogFields>
            <Field label={s('payCardAmount', { currency: main })} htmlFor={`${id}-amount`}>
              <Input
                id={`${id}-amount`}
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                mono
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                aria-invalid={amount === null ? true : undefined}
              />
            </Field>
            <Field label={s('payCardAccount')} htmlFor={`${id}-account`}>
              <Select id={`${id}-account`} value={form.accountId} options={accountOptions(form.accountId)} onChange={(accountId) => setForm((f) => ({ ...f, accountId }))} />
            </Field>
          </DialogFields>
          <DialogText>{amount === null ? s('payCardInvalid') : s('payCardRest', { rest: f2(payRest(form.amount, left)), currency: main })}</DialogText>
        </>
      )}
    </Dialog>
  );
}
