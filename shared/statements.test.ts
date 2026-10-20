// Credit card statements: which cutoff date a purchase or a fixed expense falls in, and the period a statement covers.

import { describe, expect, it } from 'vitest';
import { addDays, cutoffIn, fixedStatement, nextStatement, previousStatement, statementList, statementOf, statementPeriod } from './statements';

describe('cutoffIn', () => {
  it('is the cutoff day, or the last day of a shorter month', () => {
    expect(cutoffIn('2026-10', 13)).toBe('2026-10-13');
    expect(cutoffIn('2026-11', 31)).toBe('2026-11-30');
    expect(cutoffIn('2026-02', 31)).toBe('2026-02-28');
    expect(cutoffIn('2026-02', 30)).toBe('2026-02-28');
    expect(cutoffIn('2028-02', 30)).toBe('2028-02-29');
    expect(cutoffIn('2026-12', 31)).toBe('2026-12-31');
  });
});

describe('addDays', () => {
  it('crosses months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('statementOf with cutoff day 13', () => {
  it('puts the cutoff day itself in the statement that closes that day', () => {
    expect(statementOf('2026-10-13', 13)).toBe('2026-10-13');
    expect(statementOf('2026-10-12', 13)).toBe('2026-10-13');
    expect(statementOf('2026-10-01', 13)).toBe('2026-10-13');
  });

  it('puts the day after the cutoff in the next statement', () => {
    expect(statementOf('2026-10-14', 13)).toBe('2026-11-13');
    expect(statementOf('2026-10-31', 13)).toBe('2026-11-13');
  });

  it('rolls into the next year', () => {
    expect(statementOf('2026-12-14', 13)).toBe('2027-01-13');
    expect(statementOf('2026-12-31', 13)).toBe('2027-01-13');
    expect(statementOf('2027-01-01', 13)).toBe('2027-01-13');
  });
});

describe('statementOf with cutoff day 31', () => {
  it('clamps to the length of the month', () => {
    expect(statementOf('2026-01-31', 31)).toBe('2026-01-31');
    expect(statementOf('2026-02-01', 31)).toBe('2026-02-28');
    expect(statementOf('2026-02-28', 31)).toBe('2026-02-28');
    expect(statementOf('2026-03-01', 31)).toBe('2026-03-31');
    expect(statementOf('2026-04-30', 31)).toBe('2026-04-30');
    expect(statementOf('2026-05-01', 31)).toBe('2026-05-31');
  });

  it('knows leap years', () => {
    expect(statementOf('2028-02-29', 31)).toBe('2028-02-29');
    expect(statementOf('2028-03-01', 31)).toBe('2028-03-31');
    expect(statementOf('2028-02-15', 30)).toBe('2028-02-29');
  });
});

describe('statementPeriod', () => {
  it('runs from the day after the previous cutoff to the cutoff, both included', () => {
    expect(statementPeriod('2026-11-13', 13)).toEqual({ from: '2026-10-14', to: '2026-11-13' });
    expect(statementPeriod('2027-01-13', 13)).toEqual({ from: '2026-12-14', to: '2027-01-13' });
  });

  it('follows the clamped cutoffs of a day 31', () => {
    expect(statementPeriod('2026-03-31', 31)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(statementPeriod('2026-02-28', 31)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(statementPeriod('2026-05-31', 31)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(statementPeriod('2028-03-31', 31)).toEqual({ from: '2028-03-01', to: '2028-03-31' });
    expect(statementPeriod('2026-04-30', 31)).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('every day belongs to exactly the statement whose period holds it', () => {
    for (const day of ['2026-10-13', '2026-10-14', '2026-11-13', '2026-12-31', '2027-01-01']) {
      const cutoff = statementOf(day, 13);
      const { from, to } = statementPeriod(cutoff, 13);
      expect(day >= from && day <= to).toBe(true);
    }
  });
});

describe('previousStatement / nextStatement', () => {
  it('step one cutoff at a time', () => {
    expect(previousStatement('2026-03-31', 31)).toBe('2026-02-28');
    expect(nextStatement('2026-02-28', 31)).toBe('2026-03-31');
    expect(nextStatement('2026-12-13', 13)).toBe('2027-01-13');
  });
});

describe('fixedStatement', () => {
  it('a day up to the cutoff, no day, or a day that is not a number belongs to the statement closing that month', () => {
    expect(fixedStatement('2026-10', '13', 13)).toBe('2026-10-13');
    expect(fixedStatement('2026-10', '5', 13)).toBe('2026-10-13');
    expect(fixedStatement('2026-10', ' 5 ', 13)).toBe('2026-10-13');
    expect(fixedStatement('2026-10', '', 13)).toBe('2026-10-13');
    expect(fixedStatement('2026-10', 'end', 13)).toBe('2026-10-13');
    expect(fixedStatement('2026-10', '15th', 13)).toBe('2026-10-13');
  });

  it('a day after the cutoff belongs to the next statement', () => {
    expect(fixedStatement('2026-10', '14', 13)).toBe('2026-11-13');
    expect(fixedStatement('2026-10', '31', 13)).toBe('2026-11-13');
    expect(fixedStatement('2026-12', '20', 13)).toBe('2027-01-13');
  });

  it('compares with the cutoff of that month when the cutoff day does not exist in it', () => {
    expect(fixedStatement('2026-02', '28', 31)).toBe('2026-02-28');
    expect(fixedStatement('2026-02', '30', 31)).toBe('2026-03-31');
    expect(fixedStatement('2026-03', '30', 31)).toBe('2026-03-31');
  });
});

describe('statementList', () => {
  it('has each statement once, oldest first, and always the one containing today', () => {
    expect(statementList(['2026-11-13', '2026-09-13', '2026-11-13'], '2026-10-20', 13)).toEqual(['2026-09-13', '2026-11-13']);
    expect(statementList([], '2026-10-20', 13)).toEqual(['2026-11-13']);
    expect(statementList(['2026-10-13'], '2026-10-20', 13)).toEqual(['2026-10-13', '2026-11-13']);
  });
});
