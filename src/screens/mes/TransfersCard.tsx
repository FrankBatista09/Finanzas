import { memo, useMemo, useState } from 'react';
import { transferReceived } from '../../../shared/calc';
import { f2 } from '../../../shared/format';
import type { Currency, Transfer } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import { AddButton, AddRow, Card, CardHeader, CellDate, CellNumber, CellSelect, CellText, DeleteButton, SheetTable, Td, Th } from '../../ui';
import {
  afterTransferAdded,
  DEFAULT_VIA,
  newTransferDraft,
  pickTransferAccount,
  swapSides,
  transferInput,
  transferRate,
  transferSides,
  typeTransferRate,
} from './drafts';
import type { TransferContext } from './drafts';
import { RateCell } from './RateCell';
import { MAX_LEN, rowAccountOptions, shortDate, transferName, viaSuggestions } from './rows';
import { MES } from './strings';
import styles from './TransfersCard.module.css';

/**
 * "Envíos": el dinero que pasa de una cuenta a otra en el mes. Sale de la cuenta de origen en su moneda y entra a
 * la de destino multiplicado por la tasa del envío. Las filas se editan como las de las demás tablas.
 */
export function TransfersCard() {
  const { state, monthKey, month, accounts, visibleAccounts, defaultAccount, accountOptions, rateOf, readOnly, draftDate, actions } = useFinanzas();
  const { t } = useI18n();
  const s = useStrings(MES);
  const [draft, setDraft] = useState(newTransferDraft);
  const vias = useMemo(() => viaSuggestions(state.months, monthKey), [state.months, monthKey]);
  // La misma lista de cuentas visibles mientras no cambien las cuentas (ver FixedCard).
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const currencies = useMemo(() => new Map(state.accounts.map((a) => [a.id, a.currency])), [state.accounts]);

  // Las cuentas y la tasa del borrador se resuelven con lo que hay ahora: sin tocar, siguen a la cuenta por
  // defecto y a la tasa vigente en la fecha del borrador (la que le pondría el servidor a un envío sin tasa).
  const date = draft.date ?? draftDate;
  const ctx: TransferContext = { accounts, visible: visibleAccounts, defaultAccount, rateOf: (from, to) => rateOf(from, to, undefined, date).rate };
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
    <Card>
      <CardHeader title={s('transfersTitle')} />
      <SheetTable minWidth={640} label={s('transfersTitle')}>
        <thead>
          <tr>
            <Th>{t('date')}</Th>
            <Th>{s('via')}</Th>
            <Th>{t('from')}</Th>
            <Th align="right">{t('amount')}</Th>
            <Th>{t('to')}</Th>
            <Th align="right">{t('rate')}</Th>
            <Th align="right">{t('received')}</Th>
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
            <AddRow onAdd={add}>
              <Td kind="edit">
                <CellDate
                  value={draft.date ?? draftDate}
                  onCommit={(date) => setDraft((d) => ({ ...d, date }))}
                  minWidth={118}
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
                  minWidth={84}
                  maxLength={MAX_LEN.label}
                  label={s('newTransferVia')}
                />
              </Td>
              <Td kind="edit">
                {/* Elegir la cuenta del otro lado invierte el envío: las dos nunca son la misma. */}
                <CellSelect
                  value={fromId}
                  options={accountOptions(fromId)}
                  onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'from', id))}
                  dense
                  label={s('newTransferFrom')}
                />
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
              </Td>
              <Td kind="edit">
                <CellSelect
                  value={toId}
                  options={accountOptions(toId)}
                  onCommit={(id) => setDraft((d) => pickTransferAccount(d, ctx, 'to', id))}
                  dense
                  label={s('newTransferTo')}
                />
              </Td>
              <Td kind="edit">
                {/* La tasa del mes para las monedas de las dos cuentas, hasta que el usuario escriba la suya. */}
                <RateCell
                  value={rate.rate}
                  onCommit={(value) => setDraft((d) => typeTransferRate(d, value))}
                  readOnly={rate.locked}
                  minWidth={64}
                  label={s('newTransferRate')}
                />
              </Td>
              <Td kind="add" colSpan={2}>
                <AddButton />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </Card>
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
          minWidth={118}
          label={s('dateOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellText
          value={tr.via}
          onCommit={(via) => actions.patchTransfer(tr.id, { via })}
          readOnly={readOnly}
          suggestions={vias}
          minWidth={84}
          maxLength={MAX_LEN.label}
          label={s('viaOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellSelect value={tr.fromAccountId} options={fromOptions} onCommit={(id) => pick('from', id)} disabled={readOnly} dense label={s('fromOf', named)} />
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
      </Td>
      <Td kind="edit">
        <CellSelect value={tr.toAccountId} options={toOptions} onCommit={(id) => pick('to', id)} disabled={readOnly} dense label={s('toOf', named)} />
      </Td>
      <Td kind="edit">
        <RateCell
          value={tr.rate}
          onCommit={(rate) => actions.patchTransfer(tr.id, { rate })}
          readOnly={readOnly || sameCurrency}
          minWidth={64}
          label={s('rateOf', named)}
        />
      </Td>
      <Td kind="num" nowrap>
        {f2(transferReceived(tr))} <span className={styles.unit}>{toCur}</span>
      </Td>
      <Td kind="action">
        {!readOnly && <DeleteButton compact onClick={() => actions.removeTransfer(tr.id)} label={s('deleteTransfer', { date: shortDate(tr.date) })} />}
      </Td>
    </tr>
  );
});
