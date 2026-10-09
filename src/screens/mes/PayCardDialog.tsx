import { useId, useRef, useState } from 'react';
import { f2 } from '../../../shared/format';
import { nextKey } from '../../../shared/month';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { Dialog, DialogButton, DialogFields, DialogText, Field, Input, Select } from '../../ui';
import { payAmount, payForm, payRest } from './cardPay';
import { MES } from './strings';

/**
 * «Pagar la tarjeta de crédito»: se abre al marcar la casilla de su fila. Propone pagar todo desde la cuenta de la
 * tarjeta; se puede pagar solo una parte, y lo que quede pasa al mes siguiente. Se monta para abrirlo.
 */
export function PayCardDialog({ onClose }: { onClose: () => void }) {
  const { state, monthKey, calc, main, accountOptions, actions } = useFinanzas();
  const { t, label } = useI18n();
  const s = useStrings(MES);
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Se lee una vez, al abrir: un refresco de los datos no debe pisar lo que se esté escribiendo.
  const [form, setForm] = useState(() => payForm(state, monthKey));
  const total = calc.card.total;
  const amount = payAmount(form.amount, total);
  const valid = amount !== null && form.accountId !== '';
  const next = label(nextKey(monthKey));

  const confirm = () => {
    if (amount === null || !actions.payCard(amount, form.accountId)) return;
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
            {t('cancel')}
          </DialogButton>
          <DialogButton variant="primary" type="submit" disabled={!valid}>
            {s('payCardConfirm')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={`${id}-body`}>{s('payCardBody', { total: f2(total), currency: main, next })}</DialogText>
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
      <DialogText>{amount === null ? s('payCardInvalid') : s('payCardRest', { next, rest: f2(payRest(form.amount, total)), currency: main })}</DialogText>
    </Dialog>
  );
}
