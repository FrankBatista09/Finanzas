import { describe, expect, it } from 'vitest';
import { monthSpan } from '../../../shared/month';
import { SEED_PLANNED_GOAL, seedState } from '../../../shared/seed';
import type { Goal } from '../../../shared/types';
import { normalizeGoalPlan } from '../../store';
import {
  addMonths,
  amountText,
  formToInput,
  goalFormErrors,
  goalToForm,
  newGoalForm,
  planMonths,
  planSummary,
  setCur,
  setEnd,
  setMonthly,
  setStart,
  setTarget,
} from './goalForm';
import type { GoalForm } from './goalForm';

const TODAY = '2026-10-07';

/** Formulario de una meta nueva con la casilla del objetivo marcada. */
const planned = (over: Partial<GoalForm> = {}): GoalForm => ({ ...newGoalForm(TODAY, 'USD'), name: 'Car', planned: true, ...over });

/** Lo que queda guardado al aceptar el formulario (el id y el orden los pone la capa de datos). */
const saved = (form: GoalForm): Goal => ({ id: 'g', sort: 0, ...formToInput(form) });

describe('meses', () => {
  it('addMonths suma meses pasando de año', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-10', 2)).toBe('2026-12');
    expect(addMonths('2026-10', 3)).toBe('2027-01');
    expect(addMonths('2026-10', 12)).toBe('2027-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', 35)).toBe('2028-12');
  });

  it('planMonths cuenta los dos extremos; 0 si el mes objetivo queda antes del de inicio', () => {
    expect(planMonths({ start: '2026-08', end: '2027-10' })).toBe(15);
    expect(planMonths({ start: '2026-10', end: '2026-10' })).toBe(1);
    expect(planMonths({ start: '2026-10', end: '2026-09' })).toBe(0);
    expect(planMonths({ start: '2027-01', end: '2026-12' })).toBe(0);
    expect(planMonths({ start: '', end: '2026-12' })).toBe(0);
  });
});

describe('de la meta al formulario', () => {
  it('meta nueva: sin objetivo; el plan propuesto empieza este mes y acaba doce meses después', () => {
    expect(newGoalForm(TODAY, 'USD')).toEqual({ name: '', cur: 'USD', planned: false, start: '2026-10', end: '2027-10', target: '', monthly: '', exact: null });
    // La moneda es la que se le pase: la principal del usuario.
    expect(newGoalForm(TODAY, 'TRY').cur).toBe('TRY');
    expect(newGoalForm('2026-12-31', 'USD')).toMatchObject({ start: '2026-12', end: '2027-12' });
  });

  it('meta de aportes variables: solo el nombre; si se marca la casilla, el plan propuesto es el de una nueva', () => {
    const goal = seedState().goals[0]!;
    expect(goalToForm(goal, TODAY)).toEqual({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund' });
  });

  it('meta con plan: el objetivo es mensual × meses', () => {
    expect(goalToForm(SEED_PLANNED_GOAL, TODAY)).toEqual({
      name: 'Trip to Turkey',
      cur: 'USD',
      planned: true,
      start: '2026-08',
      end: '2027-10',
      target: '45000',
      monthly: '3000',
      exact: 3000,
    });
  });

  it('la meta se abre en su moneda, tenga plan o no', () => {
    expect(goalToForm({ ...SEED_PLANNED_GOAL, cur: 'TRY' }, TODAY)).toMatchObject({ cur: 'TRY', target: '45000', monthly: '3000', exact: 3000 });
    expect(goalToForm({ ...seedState().goals[0]!, cur: 'DOP' }, TODAY)).toEqual({ ...newGoalForm(TODAY, 'DOP'), name: 'Emergency fund' });
  });

  it('un plan a medias (datos dañados) se abre como meta sin objetivo', () => {
    const broken: Goal = { ...SEED_PLANNED_GOAL, end: null };
    expect(goalToForm(broken, TODAY)).toEqual({ ...newGoalForm(TODAY, 'USD'), name: 'Trip to Turkey' });
    expect(goalToForm({ ...SEED_PLANNED_GOAL, monthly: 0 }, TODAY).planned).toBe(false);
    expect(goalToForm({ ...SEED_PLANNED_GOAL, start: '2027-11' }, TODAY).planned).toBe(false);
  });

  it('los montos van redondeados a centavos y sin separador de miles (son el valor de un input numérico)', () => {
    expect(amountText(45000)).toBe('45000');
    expect(amountText(833.3333333333334)).toBe('833.33');
    expect(amountText(10000.000000000002)).toBe('10000');
    expect(amountText(9999.9999999)).toBe('10000');
    expect(amountText(2812.5)).toBe('2812.5');
    expect(amountText(0.005)).toBe('0.01');
  });
});

describe('campos enlazados', () => {
  it('escribir el objetivo recalcula el mensual: objetivo / meses', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(form).toMatchObject({ target: '45000', monthly: '3000', exact: 3000 });
    // El texto se queda como lo escribió el usuario; solo cambia el otro campo.
    expect(setTarget(form, '45000.0')).toMatchObject({ target: '45000.0', monthly: '3000', exact: 3000 });
    expect(setTarget(form, '10000')).toMatchObject({ target: '10000', monthly: '666.67', exact: 10000 / 15 });
  });

  it('escribir el mensual recalcula el objetivo: mensual × meses', () => {
    const form = setMonthly(planned({ start: '2026-08', end: '2027-10' }), '3000');
    expect(form).toMatchObject({ target: '45000', monthly: '3000', exact: 3000 });
    expect(setMonthly(form, '833.33')).toMatchObject({ target: '12499.95', monthly: '833.33', exact: 833.33 });
    expect(setMonthly(form, '2500.5')).toMatchObject({ target: '37507.5', exact: 2500.5 });
  });

  it('cambiar un mes conserva el objetivo y recalcula el mensual', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    // 16 meses.
    expect(setEnd(form, '2027-11')).toMatchObject({ end: '2027-11', target: '45000', monthly: '2812.5', exact: 2812.5 });
    // 10 meses.
    expect(setStart(form, '2027-01')).toMatchObject({ start: '2027-01', target: '45000', monthly: '4500', exact: 4500 });
    // También cuando lo último que se escribió fue el mensual: el objetivo que se ve es el que se queda.
    const typedMonthly = setMonthly(form, '1000');
    expect(typedMonthly.target).toBe('15000');
    expect(setEnd(typedMonthly, '2026-12')).toMatchObject({ target: '15000', monthly: '3000', exact: 3000 });
  });

  it('con el mes objetivo antes del de inicio no hay mensual; al corregirlo vuelve a calcularse', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    const wrong = setEnd(form, '2026-07');
    expect(wrong).toMatchObject({ target: '45000', monthly: '', exact: null });
    expect(setEnd(wrong, '2026-10')).toMatchObject({ target: '45000', monthly: '15000', exact: 15000 });
    // Escribir el objetivo con los meses al revés tampoco calcula nada todavía.
    expect(setTarget(wrong, '9000')).toMatchObject({ target: '9000', monthly: '', exact: null });
    expect(setStart(setTarget(wrong, '9000'), '2026-05')).toMatchObject({ target: '9000', monthly: '3000', exact: 3000 });
  });

  it('el mensual escrito con los meses al revés se conserva y da el objetivo al corregirlos', () => {
    const wrong = setEnd(planned({ start: '2026-08', end: '2027-10' }), '2026-07');
    const typed = setMonthly(wrong, '500');
    expect(typed).toMatchObject({ target: '', monthly: '500', exact: 500 });
    expect(setEnd(typed, '2026-11')).toMatchObject({ target: '2000', monthly: '500', exact: 500 });
  });

  it('un monto vacío, en cero, negativo o que no es un número deja vacío el otro campo', () => {
    const form = setTarget(planned(), '13000');
    expect(form.exact).toBe(1000);
    for (const text of ['', '0', '-5', 'abc', '   ']) {
      expect(setTarget(form, text)).toMatchObject({ target: text, monthly: '', exact: null });
      expect(setMonthly(form, text)).toMatchObject({ target: '', monthly: text, exact: null });
    }
    // Sin ningún monto, cambiar los meses no inventa nada.
    expect(setEnd(planned(), '2028-01')).toMatchObject({ target: '', monthly: '', exact: null });
  });

  it('el resumen: meses del plan y mensual exacto; nada si falta algo o la casilla está desmarcada', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(planSummary(form)).toEqual({ months: 15, monthly: 3000, cur: 'USD' });
    expect(planSummary(setCur(form, 'TRY'))).toEqual({ months: 15, monthly: 3000, cur: 'TRY' });
    expect(planSummary({ ...form, planned: false })).toBeNull();
    expect(planSummary(setTarget(form, ''))).toBeNull();
    expect(planSummary(setEnd(form, '2026-07'))).toBeNull();
    expect(planSummary(newGoalForm(TODAY, 'USD'))).toBeNull();
  });
});

describe('moneda de la meta', () => {
  it('cambiarla no toca los montos ni el plan: pasan a estar en la moneda nueva', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(setCur(form, 'TRY')).toEqual({ ...form, cur: 'TRY' });
    expect(setCur(newGoalForm(TODAY, 'DOP'), 'USD')).toEqual(newGoalForm(TODAY, 'USD'));
  });

  it('se guarda con la meta, tenga plan o no', () => {
    const form = setCur(setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000'), 'TRY');
    expect(formToInput(form)).toEqual({ name: 'Car', cur: 'TRY', monthly: 3000, start: '2026-08', end: '2027-10' });
    expect(formToInput({ ...form, planned: false })).toEqual({ name: 'Car', cur: 'TRY', monthly: null, start: null, end: null });
    // Editar solo la moneda de una meta guardada deja el plan como estaba.
    const edited = setCur(goalToForm(SEED_PLANNED_GOAL, TODAY), 'DOP');
    expect(saved(edited)).toEqual({ ...SEED_PLANNED_GOAL, id: 'g', sort: 0, name: 'Trip to Turkey', cur: 'DOP' });
  });

  it('no cambia lo que hace falta para guardar', () => {
    const goals = seedState().goals;
    for (const cur of ['DOP', 'USD', 'TRY'] as const) {
      expect(goalFormErrors(setCur(planned(), cur), goals, null)).toEqual(['amount']);
      expect(goalFormErrors(setCur(setTarget(planned(), '100'), cur), goals, null)).toEqual([]);
    }
  });
});

describe('redondeo: lo que se guarda vuelve a verse igual', () => {
  it('10,000 en 12 meses se guarda como 833.33… al mes y al reabrir vuelve a ser 10,000', () => {
    const form = setTarget(planned({ start: '2026-10', end: '2027-09' }), '10000');
    expect(planMonths(form)).toBe(12);
    expect(form.monthly).toBe('833.33');

    const goal = saved(form);
    // No 833.33 (que daría 9,999.96): el mensual exacto.
    expect(goal.monthly).toBe(10000 / 12);

    const again = goalToForm(goal, TODAY);
    expect(again.target).toBe('10000');
    expect(again.monthly).toBe('833.33');
    // Guardar sin tocar nada deja la meta exactamente como estaba.
    expect(saved(again)).toEqual(goal);
    // Y editar solo el nombre tampoco mueve el plan.
    expect(saved({ ...again, name: 'New car' })).toEqual({ ...goal, name: 'New car' });
  });

  it('cualquier objetivo con centavos sobrevive al viaje de ida y vuelta, sea cual sea el plazo', () => {
    const targets = ['1', '100', '999.99', '10000', '12345.67', '45000', '250000.5', '1000000'];
    const spans = [1, 2, 3, 6, 7, 9, 11, 12, 13, 15, 24, 36, 120];
    for (const target of targets) {
      for (const span of spans) {
        const form = setTarget(planned({ start: '2026-10', end: addMonths('2026-10', span - 1) }), target);
        expect(planMonths(form)).toBe(span);
        const again = goalToForm(saved(form), TODAY);
        expect(`${again.target} en ${span} meses`).toBe(`${target} en ${span} meses`);
        expect(again.exact).toBe(form.exact);
      }
    }
  });

  it('un mensual escrito a mano se guarda tal cual, y su objetivo es el producto', () => {
    const form = setMonthly(planned({ start: '2026-10', end: '2027-09' }), '833.33');
    expect(form.target).toBe('9999.96');
    const goal = saved(form);
    expect(goal.monthly).toBe(833.33);
    expect(goalToForm(goal, TODAY)).toMatchObject({ target: '9999.96', monthly: '833.33', exact: 833.33 });
  });

  it('el objetivo que se calcula es el de shared/calc: mensual × meses, ambos incluidos', () => {
    const goal = saved(setTarget(planned({ start: '2026-10', end: '2027-09' }), '10000'));
    expect(goal.monthly! * monthSpan(goal.start!, goal.end!)).toBeCloseTo(10000, 9);
  });
});

describe('validación', () => {
  const goals = seedState().goals;
  const errors = (form: GoalForm, editingId: string | null = null) => goalFormErrors(form, goals, editingId);

  it('el nombre es obligatorio', () => {
    expect(errors(newGoalForm(TODAY, 'USD'))).toEqual(['name']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: '   ' })).toEqual(['name']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Car' })).toEqual([]);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'x'.repeat(120) })).toEqual([]);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'x'.repeat(121) })).toEqual(['name']);
  });

  it('no puede llamarse como otra meta, sin distinguir mayúsculas ni espacios sobrantes', () => {
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund' })).toEqual(['nameTaken']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: '  EMERGENCY Fund ' })).toEqual(['nameTaken']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund 2' })).toEqual([]);
  });

  it('al editar, su propio nombre no cuenta como repetido', () => {
    const form = goalToForm(goals[0]!, TODAY);
    expect(errors(form, 'emergency')).toEqual([]);
    expect(errors({ ...form, name: 'emergency FUND' }, 'emergency')).toEqual([]);
    expect(errors({ ...form, name: 'Personal savings' }, 'emergency')).toEqual(['nameTaken']);
  });

  it('con objetivo hace falta un monto mayor que 0', () => {
    expect(errors(planned())).toEqual(['amount']);
    expect(errors(setTarget(planned(), '0'))).toEqual(['amount']);
    expect(errors(setTarget(planned(), '-100'))).toEqual(['amount']);
    expect(errors(setMonthly(planned(), '0'))).toEqual(['amount']);
    expect(errors(setTarget(planned(), '0.01'))).toEqual([]);
    expect(errors(setMonthly(planned(), '250'))).toEqual([]);
  });

  it('con objetivo, el mes objetivo no puede quedar antes del de inicio (el mismo mes sí vale)', () => {
    const form = setTarget(planned(), '1000');
    expect(errors(setEnd(form, '2026-09'))).toEqual(['months']);
    expect(errors(setStart(form, '2027-11'))).toEqual(['months']);
    expect(errors(setEnd(form, '2026-10'))).toEqual([]);
    // Sin monto y con los meses al revés salen los dos.
    expect(errors(setEnd(planned(), '2026-09'))).toEqual(['amount', 'months']);
    expect(errors({ ...setEnd(planned(), '2026-09'), name: '' })).toEqual(['name', 'amount', 'months']);
  });

  it('sin objetivo, lo que haya en los campos del plan no importa', () => {
    const form = { ...setEnd(planned(), '2026-09'), planned: false };
    expect(errors(form)).toEqual([]);
  });

  it('un formulario válido es una meta que la capa de datos acepta', () => {
    const forms = [
      { ...newGoalForm(TODAY, 'USD'), name: 'Car' },
      setTarget(planned(), '10000'),
      setMonthly(planned({ start: '2026-10', end: '2026-10' }), '0.5'),
      goalToForm(SEED_PLANNED_GOAL, TODAY),
    ];
    for (const form of forms) {
      expect(goalFormErrors(form, [], null)).toEqual([]);
      const input = formToInput(form);
      expect(normalizeGoalPlan(input)).toEqual({ monthly: input.monthly, start: input.start, end: input.end });
    }
  });
});

describe('lo que se guarda', () => {
  it('sin objetivo: el nombre sin espacios sobrantes y el plan en null, aunque los campos tuvieran algo', () => {
    expect(formToInput({ ...newGoalForm(TODAY, 'USD'), name: '  Car  ' })).toEqual({ name: 'Car', cur: 'USD', monthly: null, start: null, end: null });
    expect(formToInput({ ...setTarget(planned(), '5000'), planned: false })).toEqual({ name: 'Car', cur: 'USD', monthly: null, start: null, end: null });
  });

  it('con objetivo: mensual, inicio y fin; el monto objetivo no se guarda', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(formToInput(form)).toEqual({ name: 'Car', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10' });
  });

  it('quitar el objetivo de una meta que lo tenía manda los tres campos en null', () => {
    const form = { ...goalToForm(SEED_PLANNED_GOAL, TODAY), planned: false };
    expect(formToInput(form)).toEqual({ name: 'Trip to Turkey', cur: 'USD', monthly: null, start: null, end: null });
    // Y al volver a marcar la casilla el plan que tenía sigue en el formulario.
    expect(formToInput({ ...form, planned: true })).toEqual({ name: 'Trip to Turkey', cur: 'USD', monthly: 3000, start: '2026-08', end: '2027-10' });
  });
});
