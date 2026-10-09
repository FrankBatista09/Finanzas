import { useId, useState } from 'react';
import { MAX_LEN } from '../../shared/constants';
import { firstDay, lastDay } from '../../shared/month';
import { useI18n } from '../i18n';
import { useFinanzas } from '../store';
import { Dialog, DialogButton, DialogFields, DialogText, Field, Input, Select } from '../ui';
import { extraInput, extraProblem, newExtraForm } from './budgetModel';

/**
 * "Extra budget": money added to the month's budget after it was set. It is written as one dated 'adjust' entry,
 * so the original budget stays as it was and the history and the month summary show the addition on its own.
 * Mounted to open, unmounted to close.
 */
export function ExtraBudgetDialog({ onClose }: { onClose: () => void }) {
  const { monthKey, calc, visibleAccounts, today, actions } = useFinanzas();
  const { t } = useI18n();
  const id = useId();
  // Read once on open: a data refresh must not overwrite what is being typed.
  const [form, setForm] = useState(() => newExtraForm(monthKey, today, calc.budgetParts, visibleAccounts));
  const account = visibleAccounts.find((a) => a.id === form.accountId);
  const problem = extraProblem(form, monthKey);

  const confirm = () => {
    const input = extraInput(form, monthKey);
    if (input && actions.addBudgetEntry(input)) onClose();
  };

  return (
    <Dialog
      title={t('addBudgetExtra')}
      onCancel={onClose}
      onSubmit={confirm}
      describedBy={`${id}-body`}
      footer={
        <>
          <DialogButton variant="quiet" onClick={onClose}>
            {t('cancel')}
          </DialogButton>
          <DialogButton variant="primary" type="submit" disabled={problem !== null}>
            {t('extraConfirm')}
          </DialogButton>
        </>
      }
    >
      <DialogText id={`${id}-body`}>{t('extraBudgetBody')}</DialogText>
      <DialogFields>
        <Field label={t('extraAccount')} htmlFor={`${id}-account`}>
          <Select
            id={`${id}-account`}
            value={form.accountId}
            options={visibleAccounts.map((a) => ({ value: a.id, label: `${a.name} (${a.currency})` }))}
            onChange={(accountId) => setForm((f) => ({ ...f, accountId }))}
          />
        </Field>
        <Field label={`${t('amount')}${account ? ` (${account.currency})` : ''}`} htmlFor={`${id}-amount`}>
          <Input
            id={`${id}-amount`}
            type="number"
            step="any"
            min={0}
            inputMode="decimal"
            mono
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
        </Field>
        <Field label={t('extraNote')} htmlFor={`${id}-note`}>
          <Input
            id={`${id}-note`}
            value={form.note}
            maxLength={MAX_LEN.desc}
            placeholder={t('extraNotePlaceholder')}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </Field>
        <Field label={t('date')} htmlFor={`${id}-date`}>
          <Input
            id={`${id}-date`}
            type="date"
            value={form.date}
            min={firstDay(monthKey)}
            max={lastDay(monthKey)}
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            aria-invalid={problem === 'date' ? true : undefined}
          />
        </Field>
      </DialogFields>
      {problem === 'date' && <DialogText>{t('extraDateOutside')}</DialogText>}
    </Dialog>
  );
}
