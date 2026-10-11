import { useId, useRef, useState } from 'react';
import { budgetSummary } from '../../shared/calc';
import { f2 } from '../../shared/format';
import type { MonthKey } from '../../shared/types';
import { useI18n } from '../i18n';
import { useFinanzas, useShell } from '../store';
import { CheckField, Dialog, DialogButton, DialogFields, DialogText, Field, Input } from '../ui';
import { closeBudgetForm, closeFieldInvalid, closeRequest } from './budgetModel';
import { BudgetSummaryList } from './BudgetSummaryList';

/** Close-month dialog. actions.requestCloseMonth() opens it; Escape and a click outside are the same as Cancel. */
export function CloseMonthModal() {
  const { closeDialog } = useShell();
  if (!closeDialog) return null;
  // key: if the dialog opens for another month, its fields start with that month's parts.
  return <CloseDialog key={closeDialog.key} monthKey={closeDialog.key} busy={closeDialog.busy} />;
}

/**
 * Asks two things: whether the month is also added to the Excel workbook (the two usual buttons) and what budget
 * the next month starts with: one part per account, which starts out as this month's, and whether what was left
 * over is added to it. If the next month already exists the close does not touch it, so the second is not asked.
 */
function CloseDialog({ monthKey, busy }: { monthKey: MonthKey; busy: boolean }) {
  const { confirmClose, cancelClose } = useShell();
  const { state, main } = useFinanzas();
  const { t, label } = useI18n();
  const id = useId();
  // Focus lands on Cancel: the option that changes nothing.
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The parts are read once, on open: a data refresh must not overwrite what is being typed.
  const [form] = useState(() => closeBudgetForm(state, monthKey));
  const [fields, setFields] = useState(form.fields);
  const [addLeftover, setAddLeftover] = useState(false);
  const summary = budgetSummary(state, monthKey);

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
      <DialogFields>
        <BudgetSummaryList summary={summary} compact />
      </DialogFields>
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
