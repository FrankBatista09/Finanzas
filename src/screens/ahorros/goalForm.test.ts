import { describe, expect, it } from 'vitest';
import { monthSpan } from '../../../shared/month';
import { SEED_PLANNED_GOAL, seedState } from '../../../shared/seed';
import type { Currency, Goal } from '../../../shared/types';
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

/** Form of a new goal with the target checkbox checked. */
const planned = (over: Partial<GoalForm> = {}): GoalForm => ({ ...newGoalForm(TODAY, 'USD'), name: 'Car', planned: true, ...over });

/** What ends up saved when the form is accepted (the data layer sets the id and the order). */
const saved = (form: GoalForm, main: Currency = 'USD'): Goal => ({ id: 'g', sort: 0, ...formToInput(form, main) });

describe('months', () => {
  it('addMonths adds months across year boundaries', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-10', 2)).toBe('2026-12');
    expect(addMonths('2026-10', 3)).toBe('2027-01');
    expect(addMonths('2026-10', 12)).toBe('2027-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', 35)).toBe('2028-12');
  });

  it('planMonths counts both ends; 0 if the target month falls before the start month', () => {
    expect(planMonths({ start: '2026-08', end: '2027-10' })).toBe(15);
    expect(planMonths({ start: '2026-10', end: '2026-10' })).toBe(1);
    expect(planMonths({ start: '2026-10', end: '2026-09' })).toBe(0);
    expect(planMonths({ start: '2027-01', end: '2026-12' })).toBe(0);
    expect(planMonths({ start: '', end: '2026-12' })).toBe(0);
  });
});

describe('from the goal to the form', () => {
  it('new goal: no target; the proposed plan starts this month and ends twelve months later', () => {
    expect(newGoalForm(TODAY, 'USD')).toEqual({ name: '', cur: 'USD', approxCur: 'USD', planned: false, start: '2026-10', end: '2027-10', target: '', monthly: '', exact: null });
    // The currency is whichever one is passed in: the user's main one.
    expect(newGoalForm(TODAY, 'TRY').cur).toBe('TRY');
    expect(newGoalForm('2026-12-31', 'USD')).toMatchObject({ start: '2026-12', end: '2027-12' });
  });

  it('goal with variable contributions: only the name; if the checkbox is checked, the proposed plan is that of a new goal', () => {
    const goal = seedState().goals[0]!;
    expect(goalToForm(goal, TODAY)).toEqual({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund' });
  });

  it('goal with a plan: the target is monthly × months', () => {
    expect(goalToForm(SEED_PLANNED_GOAL, TODAY)).toEqual({
      name: 'Trip to Turkey',
      cur: 'USD',
      approxCur: 'USD',
      planned: true,
      start: '2026-08',
      end: '2027-10',
      target: '45000',
      monthly: '3000',
      exact: 3000,
    });
  });

  it('the goal opens in its own currency, with or without a plan', () => {
    expect(goalToForm({ ...SEED_PLANNED_GOAL, cur: 'TRY' }, TODAY)).toMatchObject({ cur: 'TRY', target: '45000', monthly: '3000', exact: 3000 });
    expect(goalToForm({ ...seedState().goals[0]!, cur: 'DOP' }, TODAY)).toEqual({ ...newGoalForm(TODAY, 'DOP'), name: 'Emergency fund' });
  });

  it('a half-filled plan (damaged data) opens as a goal with no target', () => {
    const broken: Goal = { ...SEED_PLANNED_GOAL, end: null };
    expect(goalToForm(broken, TODAY)).toEqual({ ...newGoalForm(TODAY, 'USD'), name: 'Trip to Turkey' });
    expect(goalToForm({ ...SEED_PLANNED_GOAL, monthly: 0 }, TODAY).planned).toBe(false);
    expect(goalToForm({ ...SEED_PLANNED_GOAL, start: '2027-11' }, TODAY).planned).toBe(false);
  });

  it('amounts are rounded to cents and have no thousands separator (they are the value of a numeric input)', () => {
    expect(amountText(45000)).toBe('45000');
    expect(amountText(833.3333333333334)).toBe('833.33');
    expect(amountText(10000.000000000002)).toBe('10000');
    expect(amountText(9999.9999999)).toBe('10000');
    expect(amountText(2812.5)).toBe('2812.5');
    expect(amountText(0.005)).toBe('0.01');
  });
});

describe('linked fields', () => {
  it('typing the target recalculates the monthly amount: target / months', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(form).toMatchObject({ target: '45000', monthly: '3000', exact: 3000 });
    // The text stays as the user typed it; only the other field changes.
    expect(setTarget(form, '45000.0')).toMatchObject({ target: '45000.0', monthly: '3000', exact: 3000 });
    expect(setTarget(form, '10000')).toMatchObject({ target: '10000', monthly: '666.67', exact: 10000 / 15 });
  });

  it('typing the monthly amount recalculates the target: monthly × months', () => {
    const form = setMonthly(planned({ start: '2026-08', end: '2027-10' }), '3000');
    expect(form).toMatchObject({ target: '45000', monthly: '3000', exact: 3000 });
    expect(setMonthly(form, '833.33')).toMatchObject({ target: '12499.95', monthly: '833.33', exact: 833.33 });
    expect(setMonthly(form, '2500.5')).toMatchObject({ target: '37507.5', exact: 2500.5 });
  });

  it('changing a month keeps the target and recalculates the monthly amount', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    // 16 months.
    expect(setEnd(form, '2027-11')).toMatchObject({ end: '2027-11', target: '45000', monthly: '2812.5', exact: 2812.5 });
    // 10 months.
    expect(setStart(form, '2027-01')).toMatchObject({ start: '2027-01', target: '45000', monthly: '4500', exact: 4500 });
    // Also when the last thing typed was the monthly amount: the target on screen is the one that stays.
    const typedMonthly = setMonthly(form, '1000');
    expect(typedMonthly.target).toBe('15000');
    expect(setEnd(typedMonthly, '2026-12')).toMatchObject({ target: '15000', monthly: '3000', exact: 3000 });
  });

  it('with the target month before the start month there is no monthly amount; fixing it calculates it again', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    const wrong = setEnd(form, '2026-07');
    expect(wrong).toMatchObject({ target: '45000', monthly: '', exact: null });
    expect(setEnd(wrong, '2026-10')).toMatchObject({ target: '45000', monthly: '15000', exact: 15000 });
    // Typing the target with the months reversed does not calculate anything yet either.
    expect(setTarget(wrong, '9000')).toMatchObject({ target: '9000', monthly: '', exact: null });
    expect(setStart(setTarget(wrong, '9000'), '2026-05')).toMatchObject({ target: '9000', monthly: '3000', exact: 3000 });
  });

  it('the monthly amount typed with the months reversed is kept and yields the target once they are fixed', () => {
    const wrong = setEnd(planned({ start: '2026-08', end: '2027-10' }), '2026-07');
    const typed = setMonthly(wrong, '500');
    expect(typed).toMatchObject({ target: '', monthly: '500', exact: 500 });
    expect(setEnd(typed, '2026-11')).toMatchObject({ target: '2000', monthly: '500', exact: 500 });
  });

  it('an empty, zero, negative or non-numeric amount leaves the other field empty', () => {
    const form = setTarget(planned(), '13000');
    expect(form.exact).toBe(1000);
    for (const text of ['', '0', '-5', 'abc', '   ']) {
      expect(setTarget(form, text)).toMatchObject({ target: text, monthly: '', exact: null });
      expect(setMonthly(form, text)).toMatchObject({ target: '', monthly: text, exact: null });
    }
    // With no amount at all, changing the months makes nothing up.
    expect(setEnd(planned(), '2028-01')).toMatchObject({ target: '', monthly: '', exact: null });
  });

  it('the summary: plan months and exact monthly amount; nothing if something is missing or the checkbox is unchecked', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(planSummary(form)).toEqual({ months: 15, monthly: 3000, cur: 'USD' });
    expect(planSummary(setCur(form, 'TRY'))).toEqual({ months: 15, monthly: 3000, cur: 'TRY' });
    expect(planSummary({ ...form, planned: false })).toBeNull();
    expect(planSummary(setTarget(form, ''))).toBeNull();
    expect(planSummary(setEnd(form, '2026-07'))).toBeNull();
    expect(planSummary(newGoalForm(TODAY, 'USD'))).toBeNull();
  });
});

describe('goal currency', () => {
  it('changing it does not touch the amounts or the plan: they are now in the new currency', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(setCur(form, 'TRY')).toEqual({ ...form, cur: 'TRY' });
    // The "≈" currency does not move either: it is still the one it had (here, the main one the goal was created with).
    expect(setCur(newGoalForm(TODAY, 'DOP'), 'USD')).toEqual(newGoalForm(TODAY, 'USD', 'DOP'));
  });

  it('it is saved with the goal, with or without a plan', () => {
    const form = setCur(setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000'), 'TRY');
    expect(formToInput(form, 'USD')).toEqual({ name: 'Car', cur: 'TRY', approxCur: null, monthly: 3000, start: '2026-08', end: '2027-10' });
    expect(formToInput({ ...form, planned: false }, 'USD')).toEqual({ name: 'Car', cur: 'TRY', approxCur: null, monthly: null, start: null, end: null });
    // Editing only the currency of a saved goal leaves the plan as it was.
    const edited = setCur(goalToForm(SEED_PLANNED_GOAL, TODAY), 'DOP');
    expect(saved(edited)).toEqual({ ...SEED_PLANNED_GOAL, id: 'g', sort: 0, name: 'Trip to Turkey', cur: 'DOP' });
  });

  it('it does not change what is needed to save', () => {
    const goals = seedState().goals;
    for (const cur of ['DOP', 'USD', 'TRY'] as const) {
      expect(goalFormErrors(setCur(planned(), cur), goals, null)).toEqual(['amount']);
      expect(goalFormErrors(setCur(setTarget(planned(), '100'), cur), goals, null)).toEqual([]);
    }
  });
});

describe('currency of the "≈" line', () => {
  it("new goal: it starts on the goal's currency, which is the user's main one, unless another one is passed in", () => {
    expect(newGoalForm(TODAY, 'DOP').approxCur).toBe('DOP');
    expect(newGoalForm(TODAY, 'USD', 'TRY')).toEqual({ ...newGoalForm(TODAY, 'USD'), approxCur: 'TRY' });
  });

  it("when editing: the one the goal chose or, if it chose none, the user's main one", () => {
    const variable = seedState().goals[0]!;
    // Not chosen (null): the main one, which is passed in; when it is not passed, the goal's own.
    expect(goalToForm(variable, TODAY, 'DOP')).toEqual({ ...newGoalForm(TODAY, 'USD', 'DOP'), name: 'Emergency fund' });
    expect(goalToForm(variable, TODAY).approxCur).toBe('USD');
    expect(goalToForm(SEED_PLANNED_GOAL, TODAY, 'DOP')).toMatchObject({ cur: 'USD', approxCur: 'DOP', planned: true, exact: 3000 });
    // Chosen: the goal's choice wins, whatever the main one is (also when it is the goal's own currency).
    expect(goalToForm({ ...variable, approxCur: 'TRY' }, TODAY, 'DOP').approxCur).toBe('TRY');
    expect(goalToForm({ ...variable, approxCur: 'TRY' }, TODAY).approxCur).toBe('TRY');
    expect(goalToForm({ ...SEED_PLANNED_GOAL, approxCur: 'USD' }, TODAY, 'DOP')).toMatchObject({ cur: 'USD', approxCur: 'USD', planned: true });
  });

  it('null is saved if it is the main one (so it follows it if it changes) and the currency if it is another one', () => {
    const form = { ...newGoalForm(TODAY, 'USD', 'DOP'), name: 'Car' };
    expect(formToInput(form, 'DOP')).toEqual({ name: 'Car', cur: 'USD', approxCur: null, monthly: null, start: null, end: null });
    expect(formToInput(form, 'USD').approxCur).toBe('DOP');
    expect(formToInput({ ...form, approxCur: 'TRY' }, 'DOP').approxCur).toBe('TRY');
    // The goal's own currency is also saved when it is not the main one: the card then does not draw the line.
    expect(formToInput({ ...form, approxCur: 'USD' }, 'DOP').approxCur).toBe('USD');
    // With a plan it goes the same way, alongside its three values.
    const withPlan = setTarget(planned({ start: '2026-08', end: '2027-10', approxCur: 'TRY' }), '45000');
    expect(formToInput(withPlan, 'DOP')).toEqual({ name: 'Car', cur: 'USD', approxCur: 'TRY', monthly: 3000, start: '2026-08', end: '2027-10' });
    expect(formToInput(withPlan, 'TRY').approxCur).toBeNull();
  });

  it('changing the goal currency or the plan fields does not touch it', () => {
    const form = planned({ approxCur: 'TRY' });
    expect(setCur(form, 'DOP').approxCur).toBe('TRY');
    expect(setEnd(setStart(setMonthly(setTarget(form, '1000'), '50'), '2026-11'), '2027-01').approxCur).toBe('TRY');
    expect(planSummary(setTarget(form, '13000'))).toEqual({ months: 13, monthly: 1000, cur: 'USD' });
    for (const approxCur of ['DOP', 'USD', 'TRY'] as const) expect(goalFormErrors({ ...setTarget(form, '100'), approxCur }, [], null)).toEqual([]);
  });

  it('saving without touching anything leaves the goal as it was, whether or not it chose a "≈" currency', () => {
    for (const main of ['DOP', 'USD', 'TRY'] as const) {
      for (const approxCur of [null, 'DOP', 'USD', 'TRY'] as const) {
        const goal: Goal = { ...SEED_PLANNED_GOAL, approxCur };
        const again = saved(goalToForm(goal, TODAY, main), main);
        // The only thing that can change is the way of saying "the main one": chosen by hand, it is saved as null.
        expect(again).toEqual({ ...goal, id: 'g', sort: 0, approxCur: approxCur === main ? null : approxCur });
        expect(goalToForm(again, TODAY, main)).toEqual(goalToForm(goal, TODAY, main));
      }
    }
  });
});

describe('rounding: what is saved shows up the same again', () => {
  it('10,000 over 12 months is saved as 833.33… a month and is 10,000 again on reopening', () => {
    const form = setTarget(planned({ start: '2026-10', end: '2027-09' }), '10000');
    expect(planMonths(form)).toBe(12);
    expect(form.monthly).toBe('833.33');

    const goal = saved(form);
    // Not 833.33 (which would give 9,999.96): the exact monthly amount.
    expect(goal.monthly).toBe(10000 / 12);

    const again = goalToForm(goal, TODAY);
    expect(again.target).toBe('10000');
    expect(again.monthly).toBe('833.33');
    // Saving without touching anything leaves the goal exactly as it was.
    expect(saved(again)).toEqual(goal);
    // And editing only the name does not move the plan either.
    expect(saved({ ...again, name: 'New car' })).toEqual({ ...goal, name: 'New car' });
  });

  it('any target with cents survives the round trip, whatever the term', () => {
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

  it('a monthly amount typed by hand is saved as is, and its target is the product', () => {
    const form = setMonthly(planned({ start: '2026-10', end: '2027-09' }), '833.33');
    expect(form.target).toBe('9999.96');
    const goal = saved(form);
    expect(goal.monthly).toBe(833.33);
    expect(goalToForm(goal, TODAY)).toMatchObject({ target: '9999.96', monthly: '833.33', exact: 833.33 });
  });

  it('the calculated target is the one from shared/calc: monthly × months, both included', () => {
    const goal = saved(setTarget(planned({ start: '2026-10', end: '2027-09' }), '10000'));
    expect(goal.monthly! * monthSpan(goal.start!, goal.end!)).toBeCloseTo(10000, 9);
  });
});

describe('validation', () => {
  const goals = seedState().goals;
  const errors = (form: GoalForm, editingId: string | null = null) => goalFormErrors(form, goals, editingId);

  it('the name is required', () => {
    expect(errors(newGoalForm(TODAY, 'USD'))).toEqual(['name']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: '   ' })).toEqual(['name']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Car' })).toEqual([]);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'x'.repeat(120) })).toEqual([]);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'x'.repeat(121) })).toEqual(['name']);
  });

  it('it cannot have the name of another goal, ignoring case and extra spaces', () => {
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund' })).toEqual(['nameTaken']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: '  EMERGENCY Fund ' })).toEqual(['nameTaken']);
    expect(errors({ ...newGoalForm(TODAY, 'USD'), name: 'Emergency fund 2' })).toEqual([]);
  });

  it('when editing, its own name does not count as a duplicate', () => {
    const form = goalToForm(goals[0]!, TODAY);
    expect(errors(form, 'emergency')).toEqual([]);
    expect(errors({ ...form, name: 'emergency FUND' }, 'emergency')).toEqual([]);
    expect(errors({ ...form, name: 'Personal savings' }, 'emergency')).toEqual(['nameTaken']);
  });

  it('with a target, an amount greater than 0 is needed', () => {
    expect(errors(planned())).toEqual(['amount']);
    expect(errors(setTarget(planned(), '0'))).toEqual(['amount']);
    expect(errors(setTarget(planned(), '-100'))).toEqual(['amount']);
    expect(errors(setMonthly(planned(), '0'))).toEqual(['amount']);
    expect(errors(setTarget(planned(), '0.01'))).toEqual([]);
    expect(errors(setMonthly(planned(), '250'))).toEqual([]);
  });

  it('with a target, the target month cannot fall before the start month (the same month is fine)', () => {
    const form = setTarget(planned(), '1000');
    expect(errors(setEnd(form, '2026-09'))).toEqual(['months']);
    expect(errors(setStart(form, '2027-11'))).toEqual(['months']);
    expect(errors(setEnd(form, '2026-10'))).toEqual([]);
    // With no amount and the months reversed, both show up.
    expect(errors(setEnd(planned(), '2026-09'))).toEqual(['amount', 'months']);
    expect(errors({ ...setEnd(planned(), '2026-09'), name: '' })).toEqual(['name', 'amount', 'months']);
  });

  it('with no target, whatever is in the plan fields does not matter', () => {
    const form = { ...setEnd(planned(), '2026-09'), planned: false };
    expect(errors(form)).toEqual([]);
  });

  it('a valid form is a goal that the data layer accepts', () => {
    const forms = [
      { ...newGoalForm(TODAY, 'USD'), name: 'Car' },
      setTarget(planned(), '10000'),
      setMonthly(planned({ start: '2026-10', end: '2026-10' }), '0.5'),
      goalToForm(SEED_PLANNED_GOAL, TODAY),
    ];
    for (const form of forms) {
      expect(goalFormErrors(form, [], null)).toEqual([]);
      const input = formToInput(form, 'USD');
      expect(normalizeGoalPlan(input)).toEqual({ monthly: input.monthly, start: input.start, end: input.end });
    }
  });
});

describe('what gets saved', () => {
  it('with no target: the name without extra spaces and the plan as null, even if the fields held something', () => {
    expect(formToInput({ ...newGoalForm(TODAY, 'USD'), name: '  Car  ' }, 'USD')).toEqual({ name: 'Car', cur: 'USD', approxCur: null, monthly: null, start: null, end: null });
    expect(formToInput({ ...setTarget(planned(), '5000'), planned: false }, 'USD')).toEqual({ name: 'Car', cur: 'USD', approxCur: null, monthly: null, start: null, end: null });
  });

  it('with a target: monthly, start and end; the target amount is not stored', () => {
    const form = setTarget(planned({ start: '2026-08', end: '2027-10' }), '45000');
    expect(formToInput(form, 'USD')).toEqual({ name: 'Car', cur: 'USD', approxCur: null, monthly: 3000, start: '2026-08', end: '2027-10' });
  });

  it('removing the target from a goal that had one sends the three fields as null', () => {
    const form = { ...goalToForm(SEED_PLANNED_GOAL, TODAY), planned: false };
    expect(formToInput(form, 'USD')).toEqual({ name: 'Trip to Turkey', cur: 'USD', approxCur: null, monthly: null, start: null, end: null });
    // And on checking the checkbox again, the plan it had is still in the form.
    expect(formToInput({ ...form, planned: true }, 'USD')).toEqual({ name: 'Trip to Turkey', cur: 'USD', approxCur: null, monthly: 3000, start: '2026-08', end: '2027-10' });
  });
});
