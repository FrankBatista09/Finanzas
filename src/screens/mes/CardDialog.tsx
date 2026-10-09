import { useId, useRef, useState } from 'react';
import { CURRENCIES, MAX_LEN } from '../../../shared/constants';
import type { CreditCard } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { cardInUse, useFinanzas } from '../../store';
import { CheckField, Dialog, DialogButton, DialogFields, Field, Input, Select } from '../../ui';
import { cardFormErrors, cardToForm, formToInput, newCardForm } from './cardForm';
import styles from './CardDialog.module.css';
import { MES } from './strings';

/**
 * «New credit card» / «Edit credit card». Obligatorio solo el nombre; la moneda nace en la principal del usuario; el día de
 * pago puede quedar vacío («aún no se sabe»). Al editar se ve además si la tarjeta está activa y el botón de eliminarla, que
 * solo sirve si nada la usa. Enter guarda y Escape cancela (<Dialog>).
 */
export function CardDialog({ card, onClose }: { card: CreditCard | null; onClose: () => void }) {
  const { state, main, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState(() => (card ? cardToForm(card) : newCardForm(main)));
  const [tried, setTried] = useState(false);

  const errors = cardFormErrors(form, state.cards, card?.id ?? null);
  const nameError = errors.includes('nameTaken') ? s('errorCardNameTaken') : tried && errors.includes('name') ? s('errorCardName') : null;
  // Con una tarjeta en uso, cambiar su moneda reinterpretaría sus importes: el servidor lo rechaza, aquí ni se ofrece.
  const used = card ? cardInUse(state, card.id) : false;

  const save = () => {
    if (errors.length > 0) {
      setTried(true);
      if (errors.includes('name') || errors.includes('nameTaken')) nameRef.current?.focus();
      return;
    }
    const input = formToInput(form);
    if (card ? actions.patchCard(card.id, input) || shallowSame(card, input) : actions.addCard(input)) onClose();
    else setTried(true);
  };

  const remove = () => {
    if (card && actions.removeCard(card.id)) onClose();
  };

  const field = (key: 'bank' | 'last4' | 'limit' | 'cutoffDay' | 'dueDay') => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const bad = (key: 'last4' | 'limit' | 'cutoffDay' | 'dueDay') => (errors.includes(key) ? true : undefined);

  return (
    <Dialog
      title={card ? s('editCard') : s('newCard')}
      onCancel={onClose}
      onSubmit={save}
      maxWidth={480}
      footer={
        <>
          {card && (
            <div className={styles.remove}>
              <DialogButton variant="danger" onClick={remove} disabled={used} aria-describedby={used ? `${id}-blocked` : undefined}>
                {s('deleteCard')}
              </DialogButton>
              {used && (
                <span id={`${id}-blocked`} className={styles.removeHint}>
                  {s('deleteCardBlocked')}
                </span>
              )}
            </div>
          )}
          <div className={styles.actions}>
            <DialogButton variant="quiet" onClick={onClose}>
              {t('cancel')}
            </DialogButton>
            <DialogButton variant="primary" type="submit">
              {t('save')}
            </DialogButton>
          </div>
        </>
      }
    >
      <DialogFields>
        <Field label={s('cardNameLabel')} htmlFor={`${id}-name`}>
          <Input
            ref={nameRef}
            id={`${id}-name`}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            maxLength={MAX_LEN.name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
          />
          {nameError && (
            <div id={`${id}-name-error`} className={styles.error} role="alert">
              {nameError}
            </div>
          )}
        </Field>
        <div className={styles.pair}>
          <Field label={s('cardBank')} htmlFor={`${id}-bank`}>
            <Input id={`${id}-bank`} maxLength={MAX_LEN.name} {...field('bank')} />
          </Field>
          <Field label={s('cardLast4')} htmlFor={`${id}-last4`}>
            <Input id={`${id}-last4`} inputMode="numeric" maxLength={4} mono aria-invalid={bad('last4')} {...field('last4')} />
            {errors.includes('last4') && <div className={styles.error}>{s('errorCardLast4')}</div>}
          </Field>
        </div>
        <div className={styles.pair}>
          <Field label={t('currency')} htmlFor={`${id}-cur`}>
            <Select id={`${id}-cur`} value={form.cur} options={CURRENCIES} onChange={(cur) => setForm((f) => ({ ...f, cur }))} disabled={used} mono />
          </Field>
          <Field label={s('cardLimitLabel', { currency: form.cur })} htmlFor={`${id}-limit`}>
            <Input id={`${id}-limit`} type="number" step="any" min={0} inputMode="decimal" mono placeholder="0.00" aria-invalid={bad('limit')} {...field('limit')} />
            {errors.includes('limit') && <div className={styles.error}>{s('errorCardLimit')}</div>}
          </Field>
        </div>
        <div className={styles.pair}>
          <Field label={s('cardCutoffLabel')} htmlFor={`${id}-cutoff`}>
            <Input id={`${id}-cutoff`} type="number" step={1} min={1} max={31} inputMode="numeric" mono aria-invalid={bad('cutoffDay')} {...field('cutoffDay')} />
            {errors.includes('cutoffDay') && <div className={styles.error}>{s('errorCardDay')}</div>}
          </Field>
          <Field label={s('cardDueLabel')} htmlFor={`${id}-due`}>
            <Input id={`${id}-due`} type="number" step={1} min={1} max={31} inputMode="numeric" mono placeholder={s('cardDueUnknown')} aria-invalid={bad('dueDay')} {...field('dueDay')} />
            {errors.includes('dueDay') && <div className={styles.error}>{s('errorCardDay')}</div>}
          </Field>
        </div>
        {card && (
          <CheckField checked={form.active} onChange={(active) => setForm((f) => ({ ...f, active }))}>
            {s('cardActiveLabel')}
          </CheckField>
        )}
      </DialogFields>
    </Dialog>
  );
}

/** patchCard devuelve false también cuando no hay nada que cambiar: guardar sin tocar nada solo cierra el diálogo. */
function shallowSame(card: CreditCard, input: ReturnType<typeof formToInput>): boolean {
  return (
    card.name === input.name &&
    card.bank === input.bank &&
    card.last4 === input.last4 &&
    card.cur === input.cur &&
    card.limit === input.limit &&
    card.cutoffDay === input.cutoffDay &&
    card.dueDay === input.dueDay &&
    card.active === input.active
  );
}
