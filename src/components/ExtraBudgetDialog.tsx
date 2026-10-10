import { useId, useState } from 'react';
import { MAX_LEN } from '../../shared/constants';
import { f2 } from '../../shared/format';
import { firstDay, lastDay } from '../../shared/month';
import { useI18n } from '../i18n';
import { useFinanzas } from '../store';
import { Dialog, DialogButton, DialogFields, DialogText, Field, Input, Select } from '../ui';
import { accountAvailable, extraAmount, extraDefaultAmount, extraIncomeOptions, extraInput, extraProblem, extraWarnings, newExtraForm } from './budgetModel';
import styles from './ExtraBudgetDialog.module.css';

/**
 * "Extra budget": money added to the month's budget after it was set. It is written as one dated 'adjust' entry,
 * so the original budget stays as it was and the history and the month summary show the addition on its own.
 * Mounted to open, unmounted to close.
 */
export function ExtraBudgetDialog({ onClose }: { onClose: () => void }) {
  const { state, monthKey, calc, visibleAccounts, today, balances, actions } = useFinanzas();
  const { t } = useI18n();
  const id = useId();
  // Read once on open: a data refresh must not overwrite what is being typed.
  const [form, setForm] = useState(() => newExtraForm(monthKey, today, calc.budgetParts, visibleAccounts));
  const account = visibleAccounts.find((a) => a.id === form.accountId);
  const problem = extraProblem(form, monthKey);
  const incomes = extraIncomeOptions(state, monthKey, form.accountId);
  const income = incomes.find((i) => i.id === form.incomeId);
  const accountAvail = accountAvailable(balances, form.accountId);
  const warnings = extraWarnings(extraAmount(form.amount), income ? income.available : null, accountAvail);
  const currency = account?.currency ?? '';
  const incomeName = (desc: string) => desc || t('extraIncomeNoDesc');

  // Choosing an income proposes what is left of it, capped by what the account holds; the amount stays editable.
  const chooseIncome = (incomeId: string) =>
    setForm((f) => {
      const chosen = incomes.find((i) => i.id === incomeId);
      const proposed = extraDefaultAmount(chosen ? chosen.available : null, accountAvail);
      return { ...f, incomeId, amount: proposed === null ? f.amount : String(proposed) };
    });

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
            // An income belongs to one account: changing the account drops it.
            onChange={(accountId) => setForm((f) => ({ ...f, accountId, incomeId: '' }))}
          />
          {accountAvail !== null && (
            <p className={styles.help}>{t('extraAccountBalance', { amount: f2(accountAvail), currency })}</p>
          )}
        </Field>
        <Field label={t('extraFromIncome')} htmlFor={`${id}-income`}>
          <Select
            id={`${id}-income`}
            value={form.incomeId}
            options={[
              { value: '', label: t('extraNoIncome') },
              ...incomes.map((i) => ({ value: i.id, label: `${incomeName(i.desc)} · ${i.date} · ${i.amount} ${i.currency}` })),
            ]}
            onChange={chooseIncome}
          />
          {income && !income.whole && <p className={styles.help}>{t('extraIncomeLeft', { amount: f2(income.available), currency })}</p>}
          {income?.whole && <p className={styles.help}>{t('extraIncomeWhole')}</p>}
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
        {warnings.income !== null && (
          <p className={styles.warn} role="status">
            {t('extraIncomeOver', { amount: f2(warnings.income), currency })}
          </p>
        )}
        {warnings.account !== null && (
          <p className={styles.warn} role="status">
            {t('extraAccountOver', { amount: f2(warnings.account), currency })}
          </p>
        )}
      </DialogFields>
      {problem === 'date' && <DialogText>{t('extraDateOutside')}</DialogText>}
    </Dialog>
  );
}
