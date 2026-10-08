import { useState } from 'react';
import { totalSaved } from '../../../shared/calc';
import { CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import { AddButton, AddRow, Card, CardHeader, CellDate, CellNumber, CellSelect, DeleteButton, Num, SheetTable, Td, Th } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { Converted, FallbackNote } from './Converted';
import { afterAdd, contributionRows, draftInput, EMPTY_DRAFT, goalOptions, goalOptionsFor, resolveDraft } from './model';
import { AHORROS } from './strings';

/**
 * "Contributions": la fila de agregar arriba y debajo el historial, del más reciente al más antiguo.
 * Los aportes no pertenecen a un mes: se agregan, editan y eliminan aunque el mes seleccionado esté cerrado.
 * Cada uno se ve además en la moneda de su meta y en la principal, con la tasa del mes de su fecha.
 */
export function ContributionsCard() {
  const { state, main, actions } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(AHORROS);
  const rows = contributionRows(state, lang);

  return (
    <Card className={styles.contribs}>
      <CardHeader
        className={styles.head}
        title={s('contribsTitle')}
        meta={
          <>
            {t('total')}{' '}
            <Num tone="ink">
              {f2(totalSaved(state))} {main}
            </Num>
          </>
        }
      />
      <SheetTable label={s('contribsTitle')}>
        <thead>
          <tr>
            <Th width={128}>{t('date')}</Th>
            <Th>{t('goal')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th align="right">{s('inGoal')}</Th>
            <Th align="right">{main}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          <ContributionAddRow />
          {rows.map((r) => (
            <tr key={r.id}>
              <Td kind="edit">
                <CellDate value={r.date} onCommit={(date) => actions.patchContribution(r.id, { date })} label={s('contribDate')} />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={r.goalId}
                  options={goalOptionsFor(state.goals, r.goalId)}
                  onCommit={(goalId) => actions.patchContribution(r.id, { goalId })}
                  label={t('goal')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber value={r.amount} onCommit={(amount) => actions.patchContribution(r.id, { amount })} minWidth={70} label={t('amount')} />
              </Td>
              <Td kind="edit">
                <CellSelect value={r.cur} options={CURRENCIES} onCommit={(cur) => actions.patchContribution(r.id, { cur })} mono dense label={t('currency')} />
              </Td>
              <Converted value={r.inGoal} note={r.goalNote} />
              <Converted value={r.main} note={r.mainNote} tone="muted" />
              <Td kind="action">
                <DeleteButton
                  compact
                  onClick={() => actions.removeContribution(r.id)}
                  label={s('deleteContrib', { date: r.date, goal: r.goal, amount: r.amountText, cur: r.cur })}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </SheetTable>
      <FallbackNote show={rows.some((r) => r.goalNote.fallback || r.mainNote.fallback)} />
    </Card>
  );
}

/** Fila de agregar. El borrador vive aquí para que escribir en ella no repinte el historial. */
function ContributionAddRow() {
  const { state, today, main, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const shown = resolveDraft(draft, state.goals, today, main);
  const goals = goalOptions(state.goals);

  const add = () => {
    const input = draftInput(draft, state.goals, today);
    if (!input || !actions.addContribution(input)) return false;
    setDraft(afterAdd);
  };

  // Sin metas no hay a qué aportar: en vez de unos campos que no se podrían usar, la fila dice qué hace falta.
  if (goals.length === 0) {
    return (
      <AddRow onAdd={() => false}>
        <Td colSpan={4} tone="muted">
          {s('noGoals')}
        </Td>
        <Td kind="add" colSpan={3}>
          <AddButton disabled className={styles.addOff} />
        </Td>
      </AddRow>
    );
  }

  return (
    <AddRow onAdd={add}>
      <Td kind="edit">
        <CellDate value={shown.date} onCommit={(date) => setDraft((d) => ({ ...d, date }))} label={s('contribDate')} />
      </Td>
      <Td kind="edit">
        <CellSelect value={shown.goalId} options={goals} onCommit={(goalId) => setDraft((d) => ({ ...d, goalId }))} label={t('goal')} />
      </Td>
      <Td kind="edit">
        <CellNumber
          value={shown.amount}
          onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
          blankZero
          placeholder="0.00"
          minWidth={70}
          label={t('amount')}
        />
      </Td>
      <Td kind="edit">
        <CellSelect value={shown.cur} options={CURRENCIES} onCommit={(cur) => setDraft((d) => ({ ...d, cur }))} mono dense label={t('currency')} />
      </Td>
      <Td kind="add" colSpan={3}>
        <AddButton />
      </Td>
    </AddRow>
  );
}
