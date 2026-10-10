import { memo, useMemo, useState } from 'react';
import { CURRENCIES } from '../../../shared/constants';
import { f2 } from '../../../shared/format';
import { defaultCardId } from '../../../shared/calc';
import type { CardCalc } from '../../../shared/calc';
import type { CreditCard, FixedExpense } from '../../../shared/types';
import { useI18n, useStrings } from '../../i18n';
import { useFinanzas } from '../../store';
import type { AccountOption, Actions } from '../../store';
import {
  AddButton,
  AddRow,
  AddRowButton,
  ExpandableCard,
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
  useAddRow,
} from '../../ui';
import { CardDetailsDialog } from './CardDetailsDialog';
import { isFullyPaid } from './cardPay';
import { PayCardDialog } from './PayCardDialog';
import { canAddFixed, draftAccount, draftCurrency, EMPTY_FIXED, fixedInput } from './drafts';
import styles from './FixedCard.module.css';
import { MAX_LEN, parsePayWith, payWithOptions, payWithValue, rowAccountOptions, sortFixed, withMoney } from './rows';
import { MES } from './strings';

/**
 * "Gastos mensuales": los mismos conceptos cada mes, con su casilla de pagado y la cuenta de la que se pagan.
 * Los importes calculados van en la moneda principal y en la segunda. Las filas de las tarjetas van primero; la fila para
 * agregar va tras los gastos (ahí cae el gasto nuevo) y la abre el botón de la cabecera.
 */
export function FixedCard({ className, cardClassName }: { className?: string; cardClassName?: string }) {
  const { state, month, calc, main, second, inBoth, accounts, defaultAccount, accountOptions, readOnly, actions } = useFinanzas();
  // La tarjeta cuyo diálogo de pago está abierto, y la de la que se ve el detalle. Los diálogos se pintan fuera de la
  // tarjeta expandible, para no montarlos dos veces.
  const [paying, setPaying] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const { t } = useI18n();
  const s = useStrings(MES);
  // App monta la hoja de nuevo al cambiar de usuario o de mes (key): el borrador no pasa de uno a otro.
  const [draft, setDraft] = useState(EMPTY_FIXED);
  const adding = useAddRow(() => setDraft(EMPTY_FIXED));
  // Las cuentas visibles, la misma lista mientras no cambien las cuentas: accountOptions es nueva en cada cambio
  // de estado y, pasada tal cual, repintaría todas las filas memorizadas con cada tecla.
  const visible = useMemo(() => accountOptions(), [state.accounts]);
  const ctx = { accounts, defaultAccount, main };
  const draftAccountId = draftAccount(draft, ctx)?.id ?? '';
  const firstCard = defaultCardId(state);

  const add = () => {
    if (!canAddFixed(draft) || !actions.addFixed(fixedInput(draft, ctx))) return false;
    setDraft(EMPTY_FIXED);
    return true;
  };

  return (
    <ExpandableCard
      title={s('fixedTitle')}
      className={className}
      cardClassName={cardClassName}
      outside={
        <>
          {viewing && <CardDetailsDialog cardId={viewing} onClose={() => setViewing(null)} onPay={() => setPaying(viewing)} />}
          {paying && <PayCardDialog cardId={paying} onClose={() => setPaying(null)} />}
        </>
      }
    >
      <CardHeader
        title={s('fixedTitle')}
        meta={
          <>
            {s('fixedMeta', { paid: calc.paidCount, total: calc.fixedCount })} <Num tone="ink">{f2(calc.fixedAll)} {main}</Num>
          </>
        }
        action={!readOnly && <AddRowButton control={adding}>{s('addFixed')}</AddRowButton>}
      />
      <SheetTable label={s('fixedTitle')} className={styles.table} scrollClassName={styles.body}>
        <thead>
          <tr>
            <Th align="center" width={PAID_W} className={styles.paid}>
              {s('paid')}
            </Th>
            <Th elastic>{s('item')}</Th>
            <Th width={DAY_W}>{s('day')}</Th>
            <Th align="right" width={AMOUNT_W}>
              {t('amount')}
            </Th>
            {/* En una línea: "Para birimi" (turco) son dos palabras y partiría la cabecera en dos renglones. */}
            <Th width={64} className={styles.currency}>
              {t('currency')}
            </Th>
            <Th width={96}>{s('payWith')}</Th>
            <Th>{t('account')}</Th>
            <Th align="right">{main}</Th>
            {second && <Th align="right">{second}</Th>}
            <Th blank width={32} />
          </tr>
        </thead>
        <tbody>
          {/* Derived card rows come first, in the cards' sort order, so adding a card pushes every regular expense down one row. */}
          {calc.cards.map((card) => (
            <CardRow
              key={card.card.id}
              card={card}
              readOnly={readOnly}
              accountName={[...new Set(card.payments.map((p) => accounts.find((a) => a.id === p.accountId)?.name ?? '—'))].join(', ') || undefined}
              onPay={() => setPaying(card.card.id)}
              onDetails={() => setViewing(card.card.id)}
            />
          ))}
          {withMoney(sortFixed(month.fixed), inBoth).map(({ row, main: inMain, second: inSecond }) => (
            <FixedRow
              key={row.id}
              row={row}
              inMain={inMain}
              inSecond={inSecond}
              accounts={rowAccountOptions(visible, accounts, row.accountId)}
              cards={state.cards}
              firstCard={firstCard}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
          {!readOnly && (
            <AddRow control={adding} onAdd={add}>
              <Td kind="center" tone="faint">
                +
              </Td>
              <Td kind="edit">
                <CellText
                  value={draft.name}
                  onCommit={(name) => setDraft((d) => ({ ...d, name }))}
                  placeholder={s('newFixed')}
                  minWidth={ITEM_W}
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
                  minWidth={DAY_W}
                  maxLength={MAX_LEN.day}
                  label={s('newFixedDay')}
                />
              </Td>
              <Td kind="edit">
                <CellNumber
                  value={draft.amount}
                  onCommit={(amount) => setDraft((d) => ({ ...d, amount }))}
                  blankZero
                  minWidth={AMOUNT_W}
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
                  value={payWithValue(draft.onCard, draft.cardId, firstCard)}
                  options={payWithOptions(s('payWithAccount'), state.cards, draft.cardId)}
                  minWidth={PAY_WITH_WIDTH}
                  onCommit={(way) => setDraft((d) => ({ ...d, onCard: parsePayWith(way).onCard, cardId: parsePayWith(way).cardId ?? null }))}
                  label={s('newFixedPayWith')}
                />
              </Td>
              {draft.onCard ? (
                <Td kind="center" tone="faint">
                  —
                </Td>
              ) : (
                <Td kind="edit">
                  <CellSelect
                    value={draftAccountId}
                    options={accountOptions(draftAccountId)}
                    minWidth={100}
                    onCommit={(accountId) => setDraft((d) => ({ ...d, accountId }))}
                    label={s('newFixedAccount')}
                  />
                </Td>
              )}
              <Td kind="add" colSpan={second ? 3 : 2}>
                <AddButton />
              </Td>
            </AddRow>
          )}
        </tbody>
      </SheetTable>
    </ExpandableCard>
  );
}

/** Ancho mínimo del selector «Pagar con»: lo justo para que se lea «Account» sin ensanchar la tabla en pantallas de 1440px. */
const PAY_WITH_WIDTH = 70;

/** Width hint for the checkbox column; the column is never narrower than its header word. */
const PAID_W = 24;

/** Wide enough for 12321321.00 plus the number spinner; as a min-width on the input it also keeps the column from being squeezed. */
const AMOUNT_W = 108;

/** Header word plus a little air: the cell holds a day number, a longer text only scrolls inside its input. As the input's min-width it also keeps the column from shrinking now that Item takes the leftover. */
const DAY_W = 44;

/** Small on purpose: Item is the column that gives up space, long names truncate with an ellipsis. */
const ITEM_W = 60;

interface CardRowProps {
  card: CardCalc;
  readOnly: boolean;
  /** Nombres de las cuentas de las que salieron los pagos, si ya se pagó algo. */
  accountName: string | undefined;
  onPay: () => void;
  onDetails: () => void;
}

/**
 * La fila de la tarjeta de crédito, al pie de «Gastos mensuales» en todos los meses. Su total (saldo anterior + otros
 * cargos + lo cargado este mes) va en las columnas de importes; el monto es ese mismo total (los «otros cargos» se editan en el desglose).
 * Su casilla está marcada solo con todo pagado; con un pago parcial queda a medias y la fila dice cuánto falta. Pulsarla
 * siempre abre el diálogo: allí se paga lo que falta o se quita algún pago. El nombre abre el desglose del mes.
 */
function CardRow({ card, readOnly, accountName, onPay, onDetails }: CardRowProps) {
  const { inBoth } = useFinanzas();
  const s = useStrings(MES);
  const started = card.payments.length > 0;
  const paid = started && isFullyPaid(card.remainder);
  const partial = started && !paid;
  // Con la tarjeta en cero y sin pagos no hay nada que pagar (el servidor lo rechazaría): la casilla no sirve.
  const canTick = readOnly ? false : started || card.total > 0;
  const named = { name: card.card.name };
  const cur = card.cur;
  const money = inBoth(card.total, cur);
  return (
    <Tr unpaid={!paid && card.total > 0} title={s('cardTitle')}>
      <Td kind="center">
        <CellCheckbox
          checked={paid}
          indeterminate={partial}
          onCommit={onPay}
          disabled={!canTick}
          label={s('paidNamed', named)}
        />
      </Td>
      <Td>
        <div className={styles.cardName}>
          <button type="button" className={styles.cardLink} title={s('cardDetails')} aria-label={s('cardDetailsOf', named)} onClick={onDetails}>
            {named.name}
          </button>
          <span className={styles.cardTag}>{s('cardTag')}</span>
        </div>
      </Td>
      <Td kind="center" tone="faint">
        —
      </Td>
      {/* What is owed in total; the "other charges" part is edited in the details dialog. */}
      <Td kind="num">{f2(card.total)}</Td>
      <Td kind="mono">{cur}</Td>
      <Td kind="center" tone="faint">
        —
      </Td>
      <Td tone="soft" className={styles.cardAccount} title={accountName}>
        {accountName ?? '—'}
      </Td>
      <Td kind="num" nowrap>
        {f2(money.main)}
      </Td>
      {money.second !== null && (
        <Td kind="num" nowrap tone="muted">
          {f2(money.second)}
        </Td>
      )}
      <Td kind="action" />
    </Tr>
  );
}

interface FixedRowProps {
  row: FixedExpense;
  /** El importe en la moneda principal y en la segunda, con las tasas del mes. */
  inMain: number;
  inSecond: number | null;
  /** Opciones del selector de cuenta (rows.ts rowAccountOptions). */
  accounts: readonly AccountOption[];
  /** Todas las tarjetas (también las apagadas: la de la fila se queda en su selector) y la primera activa, a la que va un gasto que no dice cuál. */
  cards: readonly CreditCard[];
  firstCard: string | null;
  readOnly: boolean;
  actions: Actions;
}

/** memo: al editar una celda solo se vuelve a pintar su fila; las demás conservan su identidad en la caché. */
const FixedRow = memo(function FixedRow({ row: f, inMain, inSecond, accounts, cards, firstCard, readOnly, actions }: FixedRowProps) {
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
          minWidth={ITEM_W}
          className={styles.item}
          title={f.name}
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
          minWidth={DAY_W}
          maxLength={MAX_LEN.day}
          label={s('dayOf', named)}
        />
      </Td>
      <Td kind="edit">
        <CellNumber value={f.amount} onCommit={(amount) => actions.patchFixed(f.id, { amount })} readOnly={readOnly} minWidth={AMOUNT_W} label={s('amountOf', named)} />
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
          value={payWithValue(f.onCard === true, f.cardId, firstCard)}
          options={payWithOptions(s('payWithAccount'), cards, f.cardId ?? firstCard)}
          minWidth={PAY_WITH_WIDTH}
          onCommit={(way) => actions.patchFixed(f.id, parsePayWith(way))}
          disabled={readOnly}
          label={s('payWithOf', named)}
        />
      </Td>
      {/* Un gasto en tarjeta no sale de ninguna cuenta: se paga con la tarjeta. */}
      {f.onCard ? (
        <Td kind="center" tone="faint">
          —
        </Td>
      ) : (
        <Td kind="edit">
          <CellSelect
            value={f.accountId}
            options={accounts}
            onCommit={(accountId) => actions.patchFixed(f.id, { accountId })}
            disabled={readOnly}
            label={s('accountOf', named)}
          />
        </Td>
      )}
      <Td kind="num" nowrap>
        {f2(inMain)}
      </Td>
      {inSecond !== null && (
        <Td kind="num" nowrap tone="muted">
          {f2(inSecond)}
        </Td>
      )}
      <Td kind="action">{!readOnly && <DeleteButton onClick={() => actions.removeFixed(f.id)} label={t('deleteNamed', named)} />}</Td>
    </Tr>
  );
});
