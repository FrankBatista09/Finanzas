import { memo, useMemo, useState } from 'react';
import { isMoneyAccount, transferReceived } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import type { Currency, Transfer } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import type { CommitOn } from '../../ui';
import {
  AddButton,
  AddRow,
  AddRowButton,
  Card,
  CardHeader,
  CardNote,
  CellCheckbox,
  CellDate,
  CellNumber,
  CellSelect,
  CellText,
  DeleteButton,
  SheetTable,
  Td,
  Th,
  useAddRow,
} from '../../ui';
import {
  afterTransferAdded,
  DEFAULT_VIA,
  newTransferDraft,
  pickTransferAccount,
  swapSides,
  transferFee,
  transferInput,
  transferRate,
  transferSides,
  typeTransferRate,
} from './drafts';
import type { TransferContext } from './drafts';
import { RateCell } from './RateCell';
import { lastFee, MAX_LEN, rowAccountOptions, shortDate, transferName, viaSuggestions } from './rows';
import { MES } from './strings';
import styles from './TransfersCard.module.css';

/**
 * "Envíos": el dinero que pasa de una cuenta a otra en el mes. Sale de la cuenta de origen en su moneda y entra a
 * la de destino multiplicado por la tasa del envío. Con la casilla "Moves budget", el presupuesto del mes se mueve
 * con él: baja en la parte de la cuenta de origen y sube en la de destino. La comisión (lo que cobra el servicio,
 * de la cuenta de origen y en su moneda) va bajo la tasa. Las filas se editan como las de las demás tablas.
 */
export function TransfersCard() {
  const { state, monthKey, month, accounts, visibleAccounts, defaultAccount, accountOptions, rateOf, readOnly, draftDate, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTransferDraft);
  const adding = useAddRow(() => setDraft(newTransferDraft()));
  const vias = useMemo(() => viaSuggestions(state.months, monthKey), [state.months, monthKey]);
  // La misma lista de cuentas visibles mientras no cambien las cuentas (ver FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const currencies = useMemo(() => new Map(state.accounts.filter(isMoneyAccount).map((a) => [a.id, a.currency])), [state.accounts]);

  // Las cuentas y la tasa del borrador se resuelven con lo que hay ahora: sin tocar, siguen a la cuenta por
  // defecto y a la tasa vigente en la fecha del borrador (la que le pondría el servidor a un envío sin tasa).
  const date = draft.date ?? draftDate;
  const ctx: TransferContext = {
    accounts,
    visible: visibleAccounts,
    defaultAccount,
    rateOf: (from, to) => rateOf(from, to, undefined, date).rate,
    lastFee: (via) => lastFee(state.months, monthKey, via),
  };
  const sides = transferSides(draft, ctx);
  const rate = transferRate(draft, ctx);
  const fromId = sides.from?.id ?? '';
  const toId = sides.to?.id ?? '';

  const add = () => {
    const input = transferInput(draft, draftDate, ctx);
    if (!input || !actions.addTransfer(input)) return false;
    setDraft(afterTransferAdded);
    return true;
  };

  return (
    <Card className={styles.fit}>
      <CardHeader title={s('transfersTitle')} action={!readOnly && <AddRowButton control={adding}>{s('addTransfer')}</AddRowButton>} />
      <CardNote>{s('transfersNote')}</CardNote>
      {/* Media tarjeta: origen y destino comparten columna, lo recibido va bajo el monto y la comisión bajo la tasa, para caber sin scroll. */}
      <SheetTable minWidth={520} label={s('transfersTitle')}>
        <thead>
          <tr>
            <Th>{t('date')}</Th>
            <Th>{s('via')}</Th>
            <Th>
              {t('from')} → {t('to')}
            </Th>
            <Th align="right">{t('amount')}</Th>
            <Th align="right">{t('rate')}</Th>
            <Th align="center" className={styles.budgetTh} title={t('movesBudget')} aria-label={t('movesBudget')}>
              {t('budgetShort')}
            </Th>
            <Th blank width={28} />
          </tr>
        </thead>
        <tbody>
          {month.transfers.map((tr) => (
            <TransferRow
              key={tr.id}
              row={tr}
              fromCur={currencies.get(tr.fromAccountId)}
              toCur={currencies.get(tr.toAccountId)}
              fromOptions={rowAccountOptions(visible, accounts, tr.fromAccountId)}
              toOptions={rowAccountOptions(visible, accounts, tr.toAccountId)}
              vias={vias}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
          {!readOnly && (
            <AddRow control={adding} onAdd={add}>
              <Td kind="edit">
                <CellDate
                  value={draft.date ?? draftDate}
                  onCommit={(date) => setDraft((d) => ({ ...d, date }))}
                  minWidth={112}
                  label={s('newTransferDate')}
                />
              </Td>
              <Td kind="edit">
                {/* Texto libre con sugerencias. Vacío no se queda: el placeholder avisa de la vía que se usará. */}
                <CellText
                  value={draft.via}
                  onCommit={(via) => setDraft((d) => ({ ...d, via }))}
                  suggestions={vias}
                  placeholder={DEFAULT_VIA}
                  minWidth={80}
                  maxLength={MAX_LEN.label}
                  label={s('newTransferVia')}
                />
              </Td>
              <Td kind="edit">
                {/* Elegir la cuenta del otro lado invierte el envío: las dos nunca son la misma. */}
                <div className={styles.route}>
                  <span className={styles.origin}>
                    <CellSelect
                      value={fromId}
                      options={accountOptions(fromId)}
                      onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'from', id))}
                      dense
                      className={styles.account}
                      label={s('newTransferFrom')}
                    />
                    <span className={styles.arrow} aria-hidden="true">
                      →
                    </span>
                  </span>
                  <CellSelect
                    value={toId}
                    options={accountOptions(toId)}
                    onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'to', id))}
                    dense
                    className={styles.account}
                    label={s('newTransferTo')}
                  />
                </div>
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  dense
                  minWidth={64}
                  placeholder="500"
                  label={s('newTransferAmount')}
                />
                {draft.amount > 0 && sides.to && <Received amount={transferReceived({ amount: draft.amount, rate: rate.rate })} cur={sides.to.currency} />}
              </Td>
              <Td kind="edit">
                {/* La tasa del mes para las monedas de las dos cuentas, hasta que el usuario escriba la suya. */}
                <RateCell
                  value={rate.rate}
                  onCommit={(value) => setDraft((d) => typeTransferRate(d, value))}
                  readOnly={rate.locked}
                  minWidth={68}
                  label={s('newTransferRate')}
                />
                {/* Sin tocar, la comisión del último envío por esa vía: cada servicio suele cobrar lo mismo. */}
                <Fee value={transferFee(draft, ctx)} onCommit={(fee) => setDraft((d) => ({ ...d, fee }))} commitOn="change" label={s('newTransferFee')} />
              </Td>
              <Td kind="center">
                <CellCheckbox checked={draft.budget} onCommit={(budget) => setDraft((d) => ({ ...d, budget }))} label={s('newTransferBudget')} />
              </Td>
              <Td kind="add" className={styles.addCell}>
                <AddButton className={styles.addButton} />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </Card>
  );
}

/** Lo que entra a la cuenta de destino (monto × tasa), como segunda línea atenuada bajo el monto: "= 9,600.00 TRY". */
function Received({ amount, cur }: { amount: number; cur: Currency | undefined }) {
  const { t } = useI18n();
  return (
    <div className={styles.received} title={t('received')}>
      = {f2(amount)} {cur}
    </div>
  );
}

/**
 * La comisión del envío, como segunda línea bajo la tasa: un rótulo atenuado y su campo, en la moneda de la cuenta
 * de origen (la misma del monto). Vacío es "sin comisión".
 */
function Fee({ value, onCommit, readOnly, commitOn, label }: { value: number; onCommit: (fee: number) => void; readOnly?: boolean; commitOn: CommitOn; label: string }) {
  const { t } = useI18n();
  return (
    <label className={styles.fee}>
      <span className={styles.feeLabel}>{t('fee')}</span>
      <CellNumber value={value} onCommit={onCommit} readOnly={readOnly} blankZero commitOn={commitOn} dense minWidth={58} placeholder={readOnly ? undefined : '0.00'} label={label} className={styles.feeInput} />
    </label>
  );
}

interface TransferRowProps {
  row: Transfer;
  /** Monedas de las cuentas de origen y de destino; undefined si la cuenta ya no existe. */
  fromCur: Currency | undefined;
  toCur: Currency | undefined;
  fromOptions: readonly AccountOption[];
  toOptions: readonly AccountOption[];
  vias: readonly string[];
  readOnly: boolean;
  actions: Actions;
}

/** memo: al editar una celda solo se vuelve a pintar su fila. */
const TransferRow = memo(function TransferRow({ row: tr, fromCur, toCur, fromOptions, toOptions, vias, readOnly, actions }: TransferRowProps) {
  const s = useStrings(MES);
  // Vía y fecha del envío, para las etiquetas de sus celdas ("Rate of Remitly 02/10").
  const named = { name: transferName(tr) };
  // Entre cuentas de la misma moneda la tasa es 1 y no se escribe.
  const sameCurrency = fromCur !== undefined && fromCur === toCur;
  const pick = (side: 'from' | 'to', id: string) => actions.patchTransfer(tr.id, swapSides(tr, side, id));
  return (
    <tr>
      <Td kind="edit">
        <CellDate
          value={tr.date}
          onCommit={(date) => actions.patchTransfer(tr.id, { date })}
          readOnly={readOnly}
          minWidth={112}
          label={s('dateOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellText
          value={tr.via}
          onCommit={(via) => actions.patchTransfer(tr.id, { via })}
          readOnly={readOnly}
          suggestions={vias}
          minWidth={80}
          maxLength={MAX_LEN.label}
          label={s('viaOf', named)}
        />
      </Td>
      <Td kind="edit">
        <div className={styles.route}>
          <span className={styles.origin}>
            <CellSelect
              value={tr.fromAccountId}
              options={fromOptions}
              onCommit={(id) => pick('from', id)}
              disabled={readOnly}
              dense
              className={styles.account}
              label={s('fromOf', named)}
            />
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          </span>
          <CellSelect
            value={tr.toAccountId}
            options={toOptions}
            onCommit={(id) => pick('to', id)}
            disabled={readOnly}
            dense
            className={styles.account}
            label={s('toOf', named)}
          />
        </div>
      </Td>
      <Td kind="edit">
        {/* El monto sale en la moneda de la cuenta de origen: su código va al lado, dentro de la celda. */}
        <div className={styles.withCode}>
          <CellNumber
            value={tr.amount}
            onCommit={(amount) => actions.patchTransfer(tr.id, { amount })}
            readOnly={readOnly}
            dense
            minWidth={64}
            label={s('amountOf', named)}
          />
          <span className={styles.code}>{fromCur}</span>
        </div>
        <Received amount={transferReceived(tr)} cur={toCur} />
      </Td>
      <Td kind="edit">
        <RateCell
          value={tr.rate}
          onCommit={(rate) => actions.patchTransfer(tr.id, { rate })}
          readOnly={readOnly || sameCurrency}
          minWidth={68}
          label={s('rateOf', named)}
        />
        <Fee value={tr.fee} onCommit={(fee) => actions.patchTransfer(tr.id, { fee })} readOnly={readOnly} commitOn="blur" label={s('feeOf', named)} />
      </Td>
      <Td kind="center">
        <CellCheckbox
          checked={tr.budget}
          onCommit={(budget) => actions.patchTransfer(tr.id, { budget })}
          disabled={readOnly}
          label={s('transferBudgetOf', named)}
        />
      </Td>
      <Td kind="action">
        {!readOnly && <DeleteButton compact onClick={() => actions.removeTransfer(tr.id)} label={s('deleteTransfer', { date: shortDate(tr.date) })} />}
      </Td>
    </tr>
  );
});
