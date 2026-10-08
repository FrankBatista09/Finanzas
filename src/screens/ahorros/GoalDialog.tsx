import { useId, useRef, useState } from 'react';
import { CURRENCIES, MAX_LEN } from '../../../shared/constants';
import type { Goal } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { CheckField, Dialog, DialogButton, DialogFields, Field, Input, MonthPicker, Select } from '../../ui';
import styles from './GoalDialog.module.css';
import { formToInput, goalFormErrors, goalToForm, newGoalForm, planSummary, setCur, setEnd, setMonthly, setStart, setTarget } from './goalForm';
import { wholeAmount } from './model';
import { AHORROS } from './strings';

export interface GoalDialogProps {
  /** La meta que se edita; null para crear una. */
  goal: Goal | null;
  /** Se llama al guardar, al eliminar y al cancelar (Escape, clic fuera o el botón). */
  onClose: () => void;
}

/**
 * Diálogo "New goal" / "Edit goal". El formulario vive aquí hasta que se guarda; qué campo arrastra a cuál y qué
 * se puede guardar lo decide ./goalForm. Enter guarda y Escape cancela (lo pone <Dialog>). Una meta nueva nace en
 * la moneda principal del usuario; los rótulos de los montos llevan el código de la moneda elegida.
 */
export function GoalDialog({ goal, onClose }: GoalDialogProps) {
  const { state, today, main, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [form, setForm] = useState(() => (goal ? goalToForm(goal, today) : newGoalForm(today, main)));
  // Los avisos de "falta esto" esperan al primer intento de guardar: un diálogo recién abierto no nace con errores.
  const [tried, setTried] = useState(false);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);

  const errors = goalFormErrors(form, state.goals, goal?.id ?? null);
  // Un nombre repetido o unos meses al revés se avisan en cuanto ocurren: son algo que el usuario acaba de escribir.
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
    const input = formToInput(form);
    if (goal ? actions.patchGoal(goal.id, input) : actions.addGoal(input)) onClose();
    else setTried(true);
  };

  const remove = () => {
    if (goal && actions.removeGoal(goal.id)) onClose();
  };

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
              {/* Una meta con aportes no se puede eliminar (el servidor respondería 409): el botón lo dice en vez de fallar. */}
              <DialogButton variant="danger" onClick={remove} disabled={contribCount > 0} aria-describedby={contribCount > 0 ? `${id}-blocked` : undefined}>
                {s('deleteGoal')}
              </DialogButton>
              {contribCount > 0 && (
                <span id={`${id}-blocked`} className={styles.removeHint}>
                  {s('deleteGoalBlocked', { count: contribCount })}
                </span>
              )}
            </div>
          )}
          {/* Juntos, para que en una pantalla estrecha bajen los dos a la vez y no quede "Save" solo en otra línea. */}
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

        <Field label={t('currency')} htmlFor={`${id}-cur`}>
          <Select id={`${id}-cur`} value={form.cur} options={CURRENCIES} onChange={(cur) => setForm((f) => setCur(f, cur))} mono />
        </Field>

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
            <div className={styles.months}>
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
            {/* Una sola línea para el plan: su resumen o, si no se puede guardar, por qué. */}
            <div id={`${id}-plan`} className={planError ? styles.error : styles.summary} role="status">
              {planError ?? (summary ? s('planSummary', { count: summary.months, amount: wholeAmount(summary.monthly), currency: summary.cur }) : '')}
            </div>
          </>
        )}
      </DialogFields>
    </Dialog>
  );
}
