import { useId, useRef, useState } from 'react';
import { f2 } from '../../shared/format';
import type { MonthKey } from '../../shared/types';
import { useI18n } from '../i18n';
import { useFinanzas, useShell } from '../store';
import { CheckField, Dialog, DialogButton, DialogFields, DialogText, Field, Input } from '../ui';
import { closeBudgetForm, closeFieldInvalid, closeRequest } from './budgetModel';

/** Modal de cierre de mes. Lo abre actions.requestCloseMonth(); Escape y un clic fuera equivalen a Cancelar. */
export function CloseMonthModal() {
  const { closeDialog } = useShell();
  if (!closeDialog) return null;
  // key: si el diálogo se abre para otro mes, sus campos arrancan con las partes de ese mes.
  return <CloseDialog key={closeDialog.key} monthKey={closeDialog.key} busy={closeDialog.busy} />;
}

/**
 * Pregunta dos cosas: si el mes se añade también al Excel (los dos botones de siempre) y con qué presupuesto
 * arranca el mes siguiente: una parte por cuenta, que nace con la de este mes, y si se le suma lo que sobró.
 * Si el mes siguiente ya existe el cierre no lo toca, así que lo segundo no se pregunta.
 */
function CloseDialog({ monthKey, busy }: { monthKey: MonthKey; busy: boolean }) {
  const { confirmClose, cancelClose } = useShell();
  const { state, main } = useFinanzas();
  const { t, label } = useI18n();
  const id = useId();
  // El foco entra en Cancelar: la opción que no cambia nada.
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Las partes se leen una vez, al abrir: un refresco de los datos no debe pisar lo que se esté escribiendo.
  const [form] = useState(() => closeBudgetForm(state, monthKey));
  const [fields, setFields] = useState(form.fields);
  const [addLeftover, setAddLeftover] = useState(false);

  const request = closeRequest(form, fields, addLeftover);
  const invalid = request === null;
  const confirm = (withExcel: boolean) => {
    if (request !== null) confirmClose(withExcel, request);
  };
  const next = label(form.next);

  return (
    <Dialog
      title={t('closeMonth', { month: label(monthKey) })}
      onCancel={cancelClose}
      busy={busy}
      describedBy={`${id}-body`}
      initialFocus={cancelRef}
      footer={
        <>
          <DialogButton ref={cancelRef} variant="quiet" onClick={cancelClose} disabled={busy}>
            {t('cancel')}
          </DialogButton>
          <DialogButton onClick={() => confirm(false)} disabled={busy || invalid}>
            {t('closeOnlyPage')}
          </DialogButton>
          <DialogButton variant="primary" onClick={() => confirm(true)} disabled={busy || invalid}>
            {t('closeWithExcel')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={`${id}-body`}>{t('closeDialogBody', { next })}</DialogText>
      {fields.length > 0 && <DialogText>{t('closeBudgetIntro', { next })}</DialogText>}
      {(fields.length > 0 || form.leftover !== null) && (
        <DialogFields>
          {fields.map((f, i) => (
            <Field key={f.accountId} label={t('closeBudgetOf', { account: f.name, currency: f.currency })} htmlFor={`${id}-${i}`}>
              <Input
                id={`${id}-${i}`}
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                mono
                placeholder="0.00"
                value={f.amount}
                onChange={(e) => setFields((all) => all.map((x) => (x.accountId === f.accountId ? { ...x, amount: e.target.value } : x)))}
                disabled={busy}
                aria-invalid={closeFieldInvalid(f.amount) ? true : undefined}
              />
            </Field>
          ))}
          {form.leftover !== null && (
            <CheckField checked={addLeftover} onChange={setAddLeftover} disabled={busy}>
              {t('closeAddLeftover', { amount: f2(form.leftover), currency: main, next })}
            </CheckField>
          )}
        </DialogFields>
      )}
    </Dialog>
  );
}
