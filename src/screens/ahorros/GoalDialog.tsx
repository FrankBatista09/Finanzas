import { useId, useRef, useState } from 'react';
import { CURRENCIES, MAX_LEN } from '../../../shared/constants';
import type { Goal } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { CheckField, Dialog, DialogButton, DialogFields, Field, Input, MonthPicker, Select, useConfirmDelete } from '../../ui';
import styles from './GoalDialog.module.css';
import { formToInput, goalFormErrors, goalToForm, newGoalForm, planSummary, setCur, setEnd, setMonthly, setStart, setTarget } from './goalForm';
import { wholeAmount } from './model';
import { AHORROS } from './strings';

export interface GoalDialogProps {
  /** The goal being edited; null to create one. */
  goal: Goal | null;
  /** Called on save, on delete and on cancel (Escape, a click outside or the button). */
  onClose: () => void;
}

/**
 * "New goal" / "Edit goal" dialog. The form lives here until it is saved; which field drags which along and what
 * can be saved is decided by ./goalForm. Enter saves and Escape cancels (<Dialog> provides that). A new goal starts in
 * the user's main currency, which is also the one of its "≈" line as long as no other is chosen; the labels of
 * the amounts carry the code of the chosen currency.
 */
export function GoalDialog({ goal, onClose }: GoalDialogProps) {
  const { state, today, main, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [form, setForm] = useState(() => (goal ? goalToForm(goal, today, main) : newGoalForm(today, main)));
  // The "this is missing" warnings wait for the first attempt to save: a freshly opened dialog does not start with errors.
  const [tried, setTried] = useState(false);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);

  const errors = goalFormErrors(form, state.goals, goal?.id ?? null);
  // A repeated name or months in the wrong order are flagged as soon as they happen: they are something the user has just typed.
  const nameError = errors.includes('nameTaken') ? s('errorNameTaken') : tried && errors.includes('name') ? s('errorName') : null;
  const planError = errors.includes('months') ? s('errorMonths') : tried && errors.includes('amount') ? s('errorAmount') : null;
  const summary = planSummary(form);
  const contribCount = goal ? state.contribs.filter((c) => c.goalId === goal.id).length : 0;

  const save = () => {
    if (errors.length > 0) {
      setTried(true);
      if (errors.includes('name') || errors.includes('nameTaken')) nameRef.current?.focus();
      else if (errors.includes('amount')) targetRef.current?.focus();
      return;
    }
    const input = formToInput(form, main);
    if (goal ? actions.patchGoal(goal.id, input) : actions.addGoal(input)) onClose();
    else setTried(true);
  };

  const confirmRemove = useConfirmDelete(() => {
    if (goal && actions.removeGoal(goal.id)) onClose();
  });

  return (
    <Dialog
      title={goal ? s('editGoal') : s('newGoal')}
      onCancel={onClose}
      onSubmit={save}
      maxWidth={480}
      footer={
        <>
          {goal && (
            <div className={styles.remove}>
              {/* A goal with contributions cannot be deleted (the server would answer 409): the button says so instead of failing. */}
              <DialogButton variant="danger" onClick={() => confirmRemove.request(goal.name)} disabled={contribCount > 0} aria-describedby={contribCount > 0 ? `${id}-blocked` : undefined}>
                {s('deleteGoal')}
              </DialogButton>
              {contribCount > 0 && (
                <span id={`${id}-blocked`} className={styles.removeHint}>
                  {s('deleteGoalBlocked', { count: contribCount })}
                </span>
              )}
            </div>
          )}
          {confirmRemove.dialog('kindGoal')}
          {/* Together, so that on a narrow screen both wrap at once and "Save" is not left alone on another line. */}
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
        <Field label={s('name')} htmlFor={`${id}-name`}>
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

        {/* The goal's currency and, next to it, the one in which what is saved is also shown (the card's "≈" line). */}
        <div className={styles.pair}>
          <Field label={t('currency')} htmlFor={`${id}-cur`}>
            <Select id={`${id}-cur`} value={form.cur} options={CURRENCIES} onChange={(cur) => setForm((f) => setCur(f, cur))} mono />
          </Field>
          <Field label={s('approxCurrency')} htmlFor={`${id}-approx`}>
            <Select
              id={`${id}-approx`}
              value={form.approxCur}
              options={CURRENCIES}
              onChange={(approxCur) => setForm((f) => ({ ...f, approxCur }))}
              mono
            />
          </Field>
        </div>

        <CheckField checked={form.planned} onChange={(planned) => setForm((f) => ({ ...f, planned }))}>
          {s('hasTarget')}
        </CheckField>

        {form.planned && (
          <>
            <Field label={s('targetAmount', { currency: form.cur })} htmlFor={`${id}-target`}>
              <Input
                ref={targetRef}
                id={`${id}-target`}
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                mono
                placeholder="0.00"
                value={form.target}
                onChange={(e) => setForm((f) => setTarget(f, e.target.value))}
                aria-invalid={planError && errors.includes('amount') ? true : undefined}
                aria-describedby={`${id}-plan`}
              />
            </Field>
            <div className={styles.pair}>
              <Field label={s('startMonth')} htmlFor={`${id}-start`}>
                <MonthPicker id={`${id}-start`} label={s('startMonth')} value={form.start} onChange={(start) => setForm((f) => setStart(f, start))} />
              </Field>
              <Field label={s('targetMonth')} htmlFor={`${id}-end`}>
                <MonthPicker id={`${id}-end`} label={s('targetMonth')} value={form.end} onChange={(end) => setForm((f) => setEnd(f, end))} />
              </Field>
            </div>
            <Field label={s('monthlySaving', { currency: form.cur })} htmlFor={`${id}-monthly`}>
              <Input
                id={`${id}-monthly`}
                type="number"
                step="any"
                min={0}
                inputMode="decimal"
                mono
                placeholder="0.00"
                value={form.monthly}
                onChange={(e) => setForm((f) => setMonthly(f, e.target.value))}
                aria-describedby={`${id}-plan`}
              />
            </Field>
            {/* A single line for the plan: its summary or, if it cannot be saved, why. */}
            <div id={`${id}-plan`} className={planError ? styles.error : styles.summary} role="status">
              {planError ?? (summary ? s('planSummary', { count: summary.months, amount: wholeAmount(summary.monthly), currency: summary.cur }) : '')}
            </div>
          </>
        )}
      </DialogFields>
    </Dialog>
  );
}
