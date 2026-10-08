import { memo, useMemo, useState } from 'react';
import { CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import type { FixedExpense } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import {
  AddButton,
  AddRow,
  Card,
  CardHeader,
  CellCheckbox,
  CellNumber,
  CellSelect,
  CellText,
  DeleteButton,
  Num,
  SheetTable,
  Td,
  Th,
  Tr,
} from '../../ui';
import { canAddFixed, draftAccount, draftCurrency, EMPTY_FIXED, fixedInput } from './drafts';
import styles from './FixedCard.module.css';
import { MAX_LEN, rowAccountOptions, sortFixed, withMoney } from './rows';
import { MES } from './strings';

/**
 * "Gastos mensuales": los mismos conceptos cada mes, con su casilla de pagado y la cuenta de la que se pagan.
 * Los importes calculados van en la moneda principal y en la segunda. La fila para agregar va al final.
 */
export function FixedCard({ className }: { className?: string }) {
  const { state, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  // App monta la hoja de nuevo al cambiar de usuario o de mes (key): el borrador no pasa de uno a otro.
  const [draft, setDraft] = useState(EMPTY_FIXED);
  // Las cuentas visibles, la misma lista mientras no cambien las cuentas: accountOptions es nueva en cada cambio
  // de estado y, pasada tal cual, repintaría todas las filas memorizadas con cada tecla.
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';

  const add = () => {
    if (!canAddFixed(draft) || !actions.addFixed(fixedInput(draft, ctx))) return false;
    setDraft(EMPTY_FIXED);
    return true;
  };

  return (
    <Card className={className}>
      <CardHeader
        title={s('fixedTitle')}
        meta={
          <>
            {s('fixedMeta', { paid: calc.paidCount, total: calc.fixedCount })} <Num tone="ink">{f2(calc.fixedAll)} {main}</Num>
          </>
        }
      />
      <SheetTable label={s('fixedTitle')}>
        <thead>
          <tr>
            <Th align="center" width={44}>
              {s('paid')}
            </Th>
            <Th>{s('item')}</Th>
            <Th width={60}>{s('day')}</Th>
            <Th align="right" width={110}>
              {t('amount')}
            </Th>
            {/* En una línea: "Para birimi" (turco) son dos palabras y partiría la cabecera en dos renglones. */}
            <Th width={64} className={styles.currency}>
              {t('currency')}
            </Th>
            <Th>{t('account')}</Th>
            <Th align="right">{main}</Th>
            <Th align="right">{second}</Th>
            <Th blank width={32} />
          </tr>
        </thead>
        <tbody>
          {withMoney(sortFixed(month.fixed), inBoth).map(({ row, main: inMain, second: inSecond }) => (
            <FixedRow
              key={row.id}
              row={row}
              inMain={inMain}
              inSecond={inSecond}
              accounts={rowAccountOptions(visible, accounts, row.accountId)}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
          {!readOnly && (
            <AddRow onAdd={add}>
              <Td kind="center" tone="faint">
                +
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.name}
                  onCommit={(name) => setDraft((d) => ({ ...d, name }))}
                  placeholder={s('newFixed')}
                  minWidth={120}
                  maxLength={MAX_LEN.name}
                  label={s('newFixed')}
                />
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.day}
                  onCommit={(day) => setDraft((d) => ({ ...d, day }))}
                  mono
                  placeholder={s('day')}
                  maxLength={MAX_LEN.day}
                  label={s('newFixedDay')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  placeholder="0.00"
                  label={s('newFixedAmount')}
                />
              </Td>
              <Td kind="edit">
                {/* Mientras no se toque, la moneda es la de la cuenta elegida. */}
                <CellSelect
                  value={draftCurrency(draft, ctx)}
                  options={CURRENCIES}
                  onCommit={(cur) => setDraft((d) => ({ ...d, cur }))}
                  mono
                  label={s('newFixedCurrency')}
                />
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={draftAccountId}
                  options={accountOptions(draftAccountId)}
                  minWidth={130}
                  onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
                  label={s('newFixedAccount')}
                />
              </Td>
              <Td kind="add" colSpan={3}>
                <AddButton />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </Card>
  );
}

interface FixedRowProps {
  row: FixedExpense;
  /** El importe en la moneda principal y en la segunda, con las tasas del mes. */
  inMain: number;
  inSecond: number;
  /** Opciones del selector de cuenta (rows.ts rowAccountOptions). */
  accounts: readonly AccountOption[];
  readOnly: boolean;
  actions: Actions;
}

/** memo: al editar una celda solo se vuelve a pintar su fila; las demás conservan su identidad en la caché. */
const FixedRow = memo(function FixedRow({ row: f, inMain, inSecond, accounts, readOnly, actions }: FixedRowProps) {
  const { t } = useI18n();
  const s = useStrings(MES);
  // El nombre del gasto, para las etiquetas de sus celdas ("Amount of Netflix").
  const named = { name: f.name };
  return (
    <Tr unpaid={!f.paid}>
      <Td kind="center">
        <CellCheckbox checked={f.paid} onCommit={(paid) => actions.patchFixed(f.id, { paid })} disabled={readOnly} label={s('paidNamed', named)} />
      </Td>
      <Td kind="edit">
        <CellText
          value={f.name}
          onCommit={(name) => actions.patchFixed(f.id, { name })}
          commitOn="blur"
          readOnly={readOnly}
          minWidth={120}
          maxLength={MAX_LEN.name}
          label={s('item')}
        />
      </Td>
      <Td kind="edit">
        <CellText
          value={f.day}
          onCommit={(day) => actions.patchFixed(f.id, { day })}
          readOnly={readOnly}
          mono
          tone="soft"
          placeholder="—"
          maxLength={MAX_LEN.day}
          label={s('dayOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellNumber value={f.amount} onCommit={(amount) => actions.patchFixed(f.id, { amount })} readOnly={readOnly} label={s('amountOf', named)} />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={f.cur}
          options={CURRENCIES}
          onCommit={(cur) => actions.patchFixed(f.id, { cur })}
          disabled={readOnly}
          mono
          label={s('currencyOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellSelect
          value={f.accountId}
          options={accounts}
          onCommit={(accountId) => actions.patchFixed(f.id, { accountId })}
          disabled={readOnly}
          label={s('accountOf', named)}
        />
      </Td>
      <Td kind="num" nowrap>
        {f2(inMain)}
      </Td>
      <Td kind="num" nowrap tone="muted">
        {f2(inSecond)}
      </Td>
      <Td kind="action">{!readOnly && <DeleteButton onClick={() => actions.removeFixed(f.id)} label={t('deleteNamed', named)} />}</Td>
    </Tr>
  );
});
