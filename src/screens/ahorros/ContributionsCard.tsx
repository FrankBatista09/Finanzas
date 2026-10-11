import { Fragment, useState } from 'react';
import { totalSaved } from '../../../shared/calc';
import { CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AddRowControl } from '../../ui';
import { AddButton, AddRow, AddRowButton, cx, ExpandableCard, CardHeader, CellDate, CellNumber, CellSelect, DeleteButton, Num, SheetTable, Td, Th, useAddRow } from '../../ui';
import styles from './AhorrosScreen.module.css';
import { Converted, FallbackNote } from './Converted';
import { RateCell } from './RateCell';
import {
  afterAdd,
  autoRate,
  contributionIncomeHint,
  contributionIncomeOptions,
  contributionRows,
  draftInput,
  EMPTY_DRAFT,
  goalOptions,
  goalOptionsFor,
  resolveDraft,
  withAccount,
} from './model';
import type { ContributionIncomeHint } from './model';
import { AHORROS } from './strings';

/**
 * The "From income" line under a contribution that has a source account. It is a row of its own, not a column or a
 * second select in the account cell: that column is about 80px wide at 1440px, too narrow for an income label and
 * its help text. `value` '' = not from a specific income.
 * `onEscape` is the add row's Esc, which the row above handles itself.
 */
function IncomeLine({
  accountId,
  value,
  hint,
  onCommit,
  adding,
  onEscape,
}: {
  accountId: string;
  value: string;
  hint: ContributionIncomeHint | null;
  onCommit: (incomeId: string) => void;
  adding?: boolean;
  onEscape?: () => void;
}) {
  const { state } = useFinanzas();
  const s = useStrings(AHORROS);
  const none = { value: '', label: s('incomeNone') };
  const options = [none, ...contributionIncomeOptions(state, accountId, value)];
  return (
    <tr
      className={cx(styles.incomeRow, adding && styles.incomeRowAdd)}
      onKeyDown={(e) => {
        if (onEscape && e.key === 'Escape') {
          e.preventDefault();
          onEscape();
        }
      }}
    >
      <Td colSpan={9}>
        <div className={styles.incomeLine}>
          <span className={styles.incomeLabel}>{s('fromIncome')}</span>
          <div className={styles.incomeSelect}>
            <CellSelect
              value={value}
              options={options}
              onCommit={onCommit}
              label={s('fromIncome')}
            />
          </div>
          {hint && <span className={styles.incomeHint}>{s('incomeLeft', { amount: f2(hint.left), cur: hint.currency })}</span>}
          {hint?.over && <span className={styles.incomeWarn}>{s('incomeOnly', { amount: f2(hint.before), cur: hint.currency })}</span>}
        </div>
      </Td>
    </tr>
  );
}

/**
 * "Contributions": la fila de agregar arriba (la abre el botón de la cabecera) y debajo el historial, del más reciente al más antiguo.
 * Los aportes no pertenecen a un mes: se agregan, editan y eliminan aunque el mes seleccionado esté cerrado.
 * Cada uno se ve además en la moneda de su meta y en la principal, con la tasa del mes de su fecha.
 */
export function ContributionsCard() {
  const { state, main, accountOptions, actions } = useFinanzas();
  const { t, lang } = useI18n();
  const s = useStrings(AHORROS);
  const rows = contributionRows(state, lang);
  const fromOptions = (current: string) => [{ value: '', label: s('noAccount') }, ...accountOptions(current || undefined)];
  const adding = useAddRow();

  return (
    <ExpandableCard title={s('contribsTitle')} className={styles.contribs}>
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
        action={<AddRowButton control={adding}>{s('addContribution')}</AddRowButton>}
      />
      <SheetTable label={s('contribsTitle')}>
        <thead>
          <tr>
            <Th width={116}>{t('date')}</Th>
            <Th>{t('goal')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th width={60}>{t('currencyShort')}</Th>
            <Th>{t('rate')}</Th>
            <Th>{s('fromAccount')}</Th>
            <Th align="right">{s('inGoal')}</Th>
            <Th align="right">{main}</Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {/* Cerrada se desmonta: su borrador se descarta con ella. */}
          {adding.open && <ContributionAddRow adding={adding} />}
          {rows.map((r) => (
            <Fragment key={r.id}>
              <tr className={r.accountId !== '' ? styles.joined : undefined}>
                <Td kind="edit">
                  <CellDate value={r.date} onCommit={(date) => actions.patchContribution(r.id, { date })} label={s('contribDate')} />
                </Td>
                <Td kind="edit">
                  <CellSelect
                    value={r.goalId}
                    options={goalOptionsFor(state.goals, r.goalId)}
                    onCommit={(goalId) => actions.patchContribution(r.id, { goalId })}
                    minWidth={96}
                    label={t('goal')}
                  />
                </Td>
                <Td kind="edit">
                  <CellNumber value={r.amount} onCommit={(amount) => actions.patchContribution(r.id, { amount })} minWidth={70} label={t('amount')} />
                </Td>
                <Td kind="edit">
                  <CellSelect value={r.cur} options={CURRENCIES} onCommit={(cur) => actions.patchContribution(r.id, { cur })} mono dense label={t('currency')} />
                </Td>
                <RateCell cur={r.cur} main={main} rate={r.rate} auto={r.rateAuto} onCommit={(rate) => actions.patchContribution(r.id, { rate })} />
                <Td kind="edit">
                  <CellSelect
                    value={r.accountId}
                    options={fromOptions(r.accountId)}
                    // An income belongs to one account: changing the account drops the income link.
                    onCommit={(accountId) => actions.patchContribution(r.id, { accountId: accountId || null, incomeId: null })}
                    label={s('fromAccount')}
                  />
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
              {r.accountId !== '' && (
                <IncomeLine
                  accountId={r.accountId}
                  value={r.incomeId}
                  hint={r.incomeId === '' ? null : contributionIncomeHint(state, r.incomeId, r, r.id)}
                  onCommit={(incomeId) => actions.patchContribution(r.id, { incomeId: incomeId || null })}
                />
              )}
            </Fragment>
          ))}
        </tbody>
      </SheetTable>
      <FallbackNote show={rows.some((r) => r.goalNote.fallback || r.mainNote.fallback)} />
    </ExpandableCard>
  );
}

/** Fila de agregar. El borrador vive aquí para que escribir en ella no repinte el historial. */
function ContributionAddRow({ adding }: { adding: AddRowControl }) {
  const { state, today, main, accountOptions, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(AHORROS);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const shown = resolveDraft(draft, state.goals, today, main);
  const goals = goalOptions(state.goals);

  const add = () => {
    const input = draftInput(draft, state.goals, today, main);
    if (!input || !actions.addContribution(input)) return false;
    setDraft(afterAdd);
  };

  // Sin metas no hay a qué aportar: en vez de unos campos que no se podrían usar, la fila dice qué hace falta.
  if (goals.length === 0) {
    return (
      <AddRow control={adding} onAdd={() => false}>
        <Td colSpan={4} tone="muted">
          {s('noGoals')}
        </Td>
        <Td kind="add" colSpan={5}>
          <AddButton disabled className={styles.addOff} />
        </Td>
      </AddRow>
    );
  }

  return (
    <>
      <AddRow control={adding} onAdd={add} className={shown.accountId ? styles.joined : undefined}>
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
        <RateCell
          cur={shown.cur}
          main={main}
          rate={shown.rate ?? null}
          auto={autoRate(state, shown.date, shown.cur)}
          onCommit={(rate) => setDraft((d) => ({ ...d, rate }))}
        />
        <Td kind="edit">
          <CellSelect
            value={shown.accountId ?? ''}
            options={[{ value: '', label: s('noAccount') }, ...accountOptions(shown.accountId ?? undefined)]}
            onCommit={(accountId) => setDraft((d) => withAccount(d, accountId || null))}
            label={s('fromAccount')}
          />
        </Td>
        <Td kind="add" colSpan={3}>
          <AddButton />
        </Td>
      </AddRow>
      {shown.accountId && (
        <IncomeLine
          accountId={shown.accountId}
          value={draft.incomeId ?? ''}
          adding
          hint={draft.incomeId ? contributionIncomeHint(state, draft.incomeId, shown) : null}
          onCommit={(incomeId) => setDraft((d) => ({ ...d, incomeId }))}
          onEscape={adding.hide}
        />
      )}

    </>
  );
}
