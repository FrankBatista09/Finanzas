import { useId, useRef, useState } from 'react';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { DeleteButton, Dialog, DialogButton, DialogFields, DialogText, Field, Input, Select } from '../../ui';
import { isFullyPaid, payAmount, payForm, payRest } from './cardPay';
import styles from './PayCardDialog.module.css';
import { MES } from './strings';

/**
 * «Pagar la tarjeta de crédito»: se abre al pulsar la casilla de su fila. Propone pagar lo que falta desde la cuenta
 * del último pago; se puede pagar solo una parte y volver más tarde (hay varios pagos por mes). Lista los pagos ya
 * hechos, cada uno con su ×. Con todo pagado solo sirve para revisarlos y quitar alguno. Se monta para abrirlo.
 */
export function PayCardDialog({ onClose }: { onClose: () => void }) {
  const { state, monthKey, calc, main, accountOptions, accounts, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Se lee una vez, al abrir: un refresco de los datos no debe pisar lo que se esté escribiendo.
  const [form, setForm] = useState(() => payForm(state, monthKey));
  const { total, paid, payments } = calc.card;
  const left = calc.card.remainder;
  const fullyPaid = isFullyPaid(left);
  const amount = payAmount(form.amount, left);
  const valid = !fullyPaid && amount !== null && form.accountId !== '';

  const confirm = () => {
    if (!valid || !actions.payCard(amount, form.accountId)) return;
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
        {s('payCardTotal', { total: f2(total), currency: main })}
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
                <DeleteButton compact label={s('payCardRemove', { amount: f2(p.amount), currency: main, account, date: p.date })} onClick={() => actions.removeCardPayment(p.id)} />
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
