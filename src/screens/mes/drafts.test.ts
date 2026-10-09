import { describe, expect, it } from 'vitest';
import { defaultAccount, moneyAccounts, rateFor } from '../../../shared/calc';
import { seedState } from '../../../shared/seed';
import type { Account, AppState, Currency, MonthKey } from '../../../shared/types';
import { pairRates } from '../../store';
import {
  afterTransferAdded,
  afterTxAdded,
  canAddFixed,
  canAddRate,
  canAddTransfer,
  canAddTx,
  DEFAULT_VIA,
  draftAccount,
  draftCurrency,
  EMPTY_FIXED,
  EMPTY_RATE,
  fixedInput,
  newTransferDraft,
  newTxDraft,
  pickRateCurrency,
  pickTransferAccount,
  prefillRate,
  rateDate,
  ratePair,
  swapSides,
  transferFee,
  transferInput,
  transferRate,
  transferSides,
  txInput,
  typeTransferRate,
} from './drafts';
import type { DraftContext, FixedDraft, TransferContext, TransferDraft, TxDraft } from './drafts';
import { lastFee } from './rows';

const account = (id: string, currency: Currency, sort: number, hidden = false): Account => ({ id, name: `${id} account`, currency, opening: 0, hidden, sort });

/** Los datos de ejemplo (US account en USD, DR account en DOP; por defecto, DR) más las cuentas que se pidan. */
function stateWith(...extra: Account[]): AppState {
  const state = seedState();
  state.accounts.push(...extra);
  return state;
}

const context = (state: AppState): DraftContext => ({ accounts: state.accounts, defaultAccount: defaultAccount(state), main: state.mainCurrency });

const transferContext = (state: AppState, key: MonthKey = '2026-10'): TransferContext => ({
  accounts: state.accounts,
  visible: moneyAccounts(state),
  defaultAccount: defaultAccount(state),
  rateOf: (from, to) => rateFor(state, key, from, to).rate,
  lastFee: (via) => lastFee(state.months, key, via),
});

describe('cuenta y moneda de un gasto nuevo', () => {
  const state = stateWith(account('tr', 'TRY', 2), account('old', 'USD', 3, true));
  const ctx = context(state);

  it('sin tocar: la cuenta por defecto y su moneda', () => {
    expect(draftAccount(EMPTY_FIXED, ctx)?.id).toBe('dr');
    expect(draftCurrency(EMPTY_FIXED, ctx)).toBe('DOP');
  });

  it('la moneda sigue a la cuenta elegida hasta que el usuario elige otra', () => {
    const inLira: FixedDraft = { ...EMPTY_FIXED, accountId: 'tr' };
    expect(draftAccount(inLira, ctx)?.id).toBe('tr');
    expect(draftCurrency(inLira, ctx)).toBe('TRY');
    expect(draftCurrency({ ...inLira, accountId: 'us' }, ctx)).toBe('USD');
    // Elegida a mano, ya no sigue a la cuenta.
    expect(draftCurrency({ ...inLira, cur: 'USD' }, ctx)).toBe('USD');
    expect(draftCurrency({ ...EMPTY_FIXED, cur: 'TRY' }, ctx)).toBe('TRY');
  });

  it('la cuenta por defecto es la del usuario en ese momento: si cambia, el borrador sin tocar la sigue', () => {
    const other = { ...state, defaultAccountId: 'us' };
    expect(draftAccount(EMPTY_FIXED, context(other))?.id).toBe('us');
    expect(draftCurrency(EMPTY_FIXED, context(other))).toBe('USD');
  });

  it('una cuenta elegida que se ocultó después se conserva; una que ya no existe vuelve a la de por defecto', () => {
    expect(draftAccount({ accountId: 'old' }, ctx)?.id).toBe('old');
    expect(draftAccount({ accountId: 'gone' }, ctx)?.id).toBe('dr');
  });

  it('sin cuentas: no hay cuenta y la moneda es la principal', () => {
    const empty: DraftContext = { accounts: [], defaultAccount: null, main: 'TRY' };
    expect(draftAccount(EMPTY_FIXED, empty)).toBeNull();
    expect(draftCurrency(EMPTY_FIXED, empty)).toBe('TRY');
  });
});

describe('gasto fijo', () => {
  const ctx = context(stateWith(account('tr', 'TRY', 2)));
  const named = (over: Partial<FixedDraft>): FixedDraft => ({ ...EMPTY_FIXED, name: 'Spotify', amount: 350, ...over });

  it('el borrador vacío: sin concepto, sin día, sin monto y con la moneda y la cuenta sin tocar', () => {
    expect(EMPTY_FIXED).toEqual({ name: '', day: '', amount: 0, cur: null, accountId: null, onCard: false, cardId: null });
  });

  it('«Pagar con» tarjeta: lo agregado va marcado onCard; con cuenta, igual que siempre', () => {
    expect(fixedInput(named({ onCard: true }), ctx)).toMatchObject({ onCard: true });
    expect('onCard' in fixedInput(named({}), ctx)).toBe(false);
  });

  it('necesita concepto y monto mayor que 0', () => {
    expect(canAddFixed(named({}))).toBe(true);
    expect(canAddFixed(named({ day: '12', amount: 5.99, cur: 'USD' }))).toBe(true);
    expect(canAddFixed(EMPTY_FIXED)).toBe(false);
    expect(canAddFixed(named({ name: '' }))).toBe(false);
    expect(canAddFixed(named({ name: '   ' }))).toBe(false);
    expect(canAddFixed(named({ amount: 0 }))).toBe(false);
    expect(canAddFixed(named({ amount: -5 }))).toBe(false);
    expect(canAddFixed(named({ amount: Number.NaN }))).toBe(false);
  });

  it('lo que se manda lleva la moneda y la cuenta ya resueltas', () => {
    expect(fixedInput(named({}), ctx)).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'DOP', accountId: 'dr' });
    expect(fixedInput(named({ accountId: 'tr' }), ctx)).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'TRY', accountId: 'tr' });
    expect(fixedInput(named({ accountId: 'us', cur: 'TRY', day: '5' }), ctx)).toEqual({ name: 'Spotify', day: '5', amount: 350, cur: 'TRY', accountId: 'us' });
  });

  it('sin cuentas no se manda ninguna (la capa de datos lo rechaza)', () => {
    expect(fixedInput(named({}), { accounts: [], defaultAccount: null, main: 'DOP' })).toEqual({ name: 'Spotify', day: '', amount: 350, cur: 'DOP' });
  });
});

describe('transacción', () => {
  const ctx = context(stateWith(account('tr', 'TRY', 2)));
  const filled: TxDraft = {
    date: '2026-10-05',
    desc: 'Cena',
    place: 'Lulú',
    cat: 'Travel',
    method: 'Transfer',
    amount: 3150,
    cur: 'USD',
    accountId: 'us',
    notes: 'Con propina',
    cardId: null,
  };

  it('arranca en Food / Card (los nombres canónicos, que son los que se guardan), sin fecha, moneda ni cuenta propias', () => {
    expect(newTxDraft()).toEqual({ date: null, desc: '', place: '', cat: 'Food', method: 'Debit card', amount: 0, cur: null, accountId: null, notes: '', cardId: null });
  });

  it('necesita descripción y monto mayor que 0; lugar y notas son opcionales', () => {
    expect(canAddTx(filled)).toBe(true);
    expect(canAddTx({ ...newTxDraft(), desc: 'Café', amount: 385 })).toBe(true);
    expect(canAddTx(newTxDraft())).toBe(false);
    expect(canAddTx({ ...filled, desc: '' })).toBe(false);
    expect(canAddTx({ ...filled, desc: '  ' })).toBe(false);
    expect(canAddTx({ ...filled, amount: 0 })).toBe(false);
    expect(canAddTx({ ...filled, amount: -1 })).toBe(false);
    expect(canAddTx({ ...filled, amount: Number.NaN })).toBe(false);
  });

  it('sin fecha propia usa la del shell; con fecha propia, esa', () => {
    expect(txInput({ ...filled, date: null }, '2026-10-07', ctx).date).toBe('2026-10-07');
    expect(txInput(filled, '2026-10-07', ctx).date).toBe('2026-10-05');
    // El borrador sin tarjeta (`cardId: null`) no manda ninguna; con método de crédito y tarjeta elegida, la manda.
    const { cardId: _none, ...sent } = filled;
    expect(txInput(filled, '2026-10-07', ctx)).toEqual(sent);
    expect(txInput({ ...filled, method: 'Credit card', cardId: 'b' }, '2026-10-07', ctx)).toMatchObject({ method: 'Credit card', cardId: 'b' });
    expect(txInput({ ...filled, cardId: 'b' }, '2026-10-07', ctx)).not.toHaveProperty('cardId');
  });

  it('sin tocar, sale de la cuenta por defecto y en su moneda; al elegir otra cuenta, en la de esa', () => {
    const coffee = { ...newTxDraft(), desc: 'Café', amount: 385 };
    expect(txInput(coffee, '2026-10-07', ctx)).toMatchObject({ cur: 'DOP', accountId: 'dr' });
    expect(txInput({ ...coffee, accountId: 'tr' }, '2026-10-07', ctx)).toMatchObject({ cur: 'TRY', accountId: 'tr' });
    // La moneda elegida a mano manda sobre la de la cuenta.
    expect(txInput({ ...coffee, accountId: 'tr', cur: 'USD' }, '2026-10-07', ctx)).toMatchObject({ cur: 'USD', accountId: 'tr' });
  });

  it('después de agregar se limpian descripción, lugar, monto y notas; el resto se queda', () => {
    expect(afterTxAdded(filled)).toEqual({
      date: '2026-10-05',
      desc: '',
      place: '',
      cat: 'Travel',
      method: 'Transfer',
      amount: 0,
      cur: 'USD',
      accountId: 'us',
      notes: '',
      cardId: null,
    });
    // Lo que estaba sin tocar sigue sin tocar: mañana la fecha será la de mañana, y la cuenta, la de por defecto.
    expect(afterTxAdded({ ...filled, date: null, cur: null, accountId: null })).toMatchObject({ date: null, cur: null, accountId: null });
    expect(filled.desc).toBe('Cena');
  });
});

describe('envío: las dos cuentas', () => {
  it('sin tocar: llega a la cuenta por defecto desde otra cuenta visible', () => {
    const ctx = transferContext(seedState());
    const sides = transferSides(newTransferDraft(), ctx);
    expect([sides.from?.id, sides.to?.id]).toEqual(['us', 'dr']);
  });

  it('la de origen es, si la hay, una de otra moneda que la de destino', () => {
    // La primera visible que no es el destino está en la misma moneda: se prefiere la US account.
    const state = stateWith(account('cash', 'DOP', -1));
    const sides = transferSides(newTransferDraft(), transferContext(state));
    expect([sides.from?.id, sides.to?.id]).toEqual(['us', 'dr']);
    // Si todas son de la misma moneda, la primera.
    const pesos = seedState();
    pesos.accounts = [account('a', 'DOP', 0), account('b', 'DOP', 1), account('c', 'DOP', 2)];
    pesos.defaultAccountId = 'b';
    const same = transferSides(newTransferDraft(), transferContext(pesos));
    expect([same.from?.id, same.to?.id]).toEqual(['a', 'b']);
  });

  it('nunca son la misma: si el origen elegido es la cuenta por defecto, el destino es otra', () => {
    const ctx = transferContext(seedState());
    const sides = transferSides({ fromAccountId: 'dr', toAccountId: null }, ctx);
    expect([sides.from?.id, sides.to?.id]).toEqual(['dr', 'us']);
    // Un borrador incoherente (la misma en los dos lados) se resuelve igual.
    const both = transferSides({ fromAccountId: 'dr', toAccountId: 'dr' }, ctx);
    expect([both.from?.id, both.to?.id]).toEqual(['dr', 'us']);
  });

  it('no ofrece por su cuenta una cuenta oculta, pero conserva la que se eligió', () => {
    const state = stateWith(account('old', 'TRY', -5, true));
    const ctx = transferContext(state);
    expect(transferSides(newTransferDraft(), ctx).from?.id).toBe('us');
    expect(transferSides({ fromAccountId: 'old', toAccountId: null }, ctx).from?.id).toBe('old');
  });

  it('con una sola cuenta falta un lado, y sin cuentas los dos', () => {
    const one = seedState();
    one.accounts = [account('dr', 'DOP', 0)];
    const sides = transferSides(newTransferDraft(), transferContext(one));
    expect([sides.from, sides.to?.id]).toEqual([null, 'dr']);
    expect(canAddTransfer({ ...newTransferDraft(), amount: 500, rate: 1 }, transferContext(one))).toBe(false);

    one.accounts = [];
    expect(transferSides(newTransferDraft(), transferContext(one))).toEqual({ from: null, to: null });
  });

  it('swapSides: elegir la cuenta del otro lado invierte el envío', () => {
    const row = { fromAccountId: 'us', toAccountId: 'dr' };
    expect(swapSides(row, 'from', 'dr')).toEqual({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(swapSides(row, 'to', 'us')).toEqual({ fromAccountId: 'dr', toAccountId: 'us' });
    // Otra cuenta solo cambia su lado; la misma no cambia nada.
    expect(swapSides(row, 'from', 'tr')).toEqual({ fromAccountId: 'tr', toAccountId: 'dr' });
    expect(swapSides(row, 'to', 'tr')).toEqual({ fromAccountId: 'us', toAccountId: 'tr' });
    expect(swapSides(row, 'from', 'us')).toEqual(row);
    expect(swapSides(row, 'to', 'dr')).toEqual(row);
  });
});

describe('envío: la tasa propuesta', () => {
  it('prefillRate: dos decimales; cuatro cifras significativas por debajo de 1', () => {
    expect(prefillRate(58.76)).toBe(58.76);
    // Promedio ponderado de septiembre en los datos de ejemplo.
    expect(prefillRate(134721 / 2300)).toBe(58.57);
    expect(prefillRate(58.184444)).toBe(58.18);
    expect(prefillRate(1)).toBe(1);
    expect(prefillRate(1 / 58.76)).toBe(0.01702);
    expect(prefillRate(0.714285)).toBe(0.7143);
    expect(prefillRate(0)).toBe(0);
    expect(prefillRate(-3)).toBe(0);
    expect(prefillRate(Number.NaN)).toBe(0);
  });

  it('sin tocar es la del mes para las monedas de las dos cuentas', () => {
    const state = seedState();
    expect(transferRate(newTransferDraft(), transferContext(state))).toEqual({ rate: 58.76, locked: false });
    // Septiembre no tiene tasa escrita: el promedio de sus envíos, a dos decimales.
    expect(transferRate(newTransferDraft(), transferContext(state, '2026-09'))).toEqual({ rate: 58.57, locked: false });
  });

  it('con varias tasas escritas en el mes, propone la vigente en la fecha del envío', () => {
    const state = seedState();
    state.months['2026-10']!.rates = [
      { from: 'USD', to: 'DOP', rate: 58, date: '2026-10-01' },
      { from: 'USD', to: 'DOP', rate: 60, date: '2026-10-05' },
    ];
    // Como arma la tarjeta su contexto: la tasa del par en la fecha del borrador.
    const on = (date: string): TransferContext => ({ ...transferContext(state), rateOf: (from, to) => rateFor(state, '2026-10', from, to, date).rate });
    expect(transferRate(newTransferDraft(), on('2026-10-04'))).toEqual({ rate: 58, locked: false });
    expect(transferRate(newTransferDraft(), on('2026-10-05'))).toEqual({ rate: 60, locked: false });
    expect(transferInput({ ...newTransferDraft(), amount: 100 }, '2026-10-04', on('2026-10-04'))).toMatchObject({ date: '2026-10-04', rate: 58 });
    // Sin fecha, la última del mes.
    expect(transferRate(newTransferDraft(), transferContext(state)).rate).toBe(60);
  });

  it('sigue a las cuentas mientras el usuario no escriba la suya', () => {
    const state = stateWith(account('tr', 'TRY', 2));
    state.months['2026-10']!.rates.push({ from: 'USD', to: 'TRY', rate: 41.5, date: '2026-10-01' });
    const ctx = transferContext(state);
    let draft = newTransferDraft();
    expect(transferRate(draft, ctx).rate).toBe(58.76);
    draft = pickTransferAccount(draft, ctx, 'to', 'tr');
    expect(draft).toMatchObject({ fromAccountId: 'us', toAccountId: 'tr', rate: null });
    expect(transferRate(draft, ctx)).toEqual({ rate: 41.5, locked: false });
    // Invertido: DR → US, la inversa de la escrita.
    draft = pickTransferAccount(newTransferDraft(), ctx, 'from', 'dr');
    expect(draft).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us' });
    expect(transferRate(draft, ctx)).toEqual({ rate: 0.01702, locked: false });
  });

  it('entre cuentas de la misma moneda es 1 y no se escribe', () => {
    const state = stateWith(account('paypal', 'USD', 2));
    const ctx = transferContext(state);
    const draft = pickTransferAccount(newTransferDraft(), ctx, 'to', 'paypal');
    expect(transferRate(draft, ctx)).toEqual({ rate: 1, locked: true });
    // Aunque quedara una tasa escrita en el borrador.
    expect(transferRate({ ...draft, rate: 58.9 }, ctx)).toEqual({ rate: 1, locked: true });
    expect(transferInput({ ...draft, amount: 200 }, '2026-10-07', ctx)).toMatchObject({ fromAccountId: 'us', toAccountId: 'paypal', rate: 1 });
  });

  it('la tasa escrita por el usuario se conserva, también después de agregar', () => {
    const ctx = transferContext(seedState());
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    expect(typed.rate).toBe(58.9);
    expect(transferRate(typed, ctx)).toEqual({ rate: 58.9, locked: false });
    expect(transferRate(afterTransferAdded({ ...typed, amount: 500 }), ctx).rate).toBe(58.9);
  });

  it('cambiar de cuenta sin cambiar de monedas conserva la tasa escrita', () => {
    const state = stateWith(account('paypal', 'USD', 2));
    const ctx = transferContext(state);
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    const moved = pickTransferAccount(typed, ctx, 'from', 'paypal');
    expect(moved).toMatchObject({ fromAccountId: 'paypal', toAccountId: 'dr', rate: 58.9 });
  });

  it('si cambian las monedas (o el sentido), la tasa escrita era de otro par: vuelve a seguir la del mes', () => {
    const state = stateWith(account('tr', 'TRY', 2));
    const ctx = transferContext(state);
    const typed = typeTransferRate(newTransferDraft(), 58.9);
    expect(pickTransferAccount(typed, ctx, 'to', 'tr').rate).toBeNull();
    const reversed = pickTransferAccount(typed, ctx, 'from', 'dr');
    expect(reversed).toMatchObject({ fromAccountId: 'dr', toAccountId: 'us', rate: null });
    expect(transferRate(reversed, ctx).rate).toBe(0.01702);
  });

  it('vaciar el campo de la tasa (0) la devuelve a la del mes', () => {
    const ctx = transferContext(seedState());
    const cleared = typeTransferRate(typeTransferRate(newTransferDraft(), 58.9), 0);
    expect(cleared.rate).toBeNull();
    expect(transferRate(cleared, ctx).rate).toBe(58.76);
    expect(typeTransferRate(newTransferDraft(), Number.NaN).rate).toBeNull();
  });
});

describe('envío: agregar', () => {
  const ctx = transferContext(seedState());
  const filled: TransferDraft = { date: '2026-10-02', via: 'PayPal', fromAccountId: 'us', toAccountId: 'dr', amount: 500, rate: 58.9, budget: false, fee: 0 };

  it('arranca en Remitly, sin monto, con cuentas, tasa y comisión sin tocar y con "Moves budget" marcada', () => {
    expect(DEFAULT_VIA).toBe('Remitly');
    expect(newTransferDraft()).toEqual({ date: null, via: 'Remitly', fromAccountId: null, toAccountId: null, amount: 0, rate: null, budget: true, fee: null });
  });

  it('necesita monto y tasa mayores que 0 y dos cuentas', () => {
    expect(canAddTransfer(filled, ctx)).toBe(true);
    expect(canAddTransfer({ ...newTransferDraft(), amount: 500 }, ctx)).toBe(true);
    expect(canAddTransfer(newTransferDraft(), ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: 0 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: -100 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, amount: Number.NaN }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, rate: 0 }, ctx)).toBe(false);
    expect(canAddTransfer({ ...filled, rate: Number.NaN }, ctx)).toBe(false);
    expect(transferInput({ ...filled, amount: 0 }, '2026-11-01', ctx)).toBeNull();
  });

  it('lo que se manda: fecha, vía, cuentas y tasa ya resueltas (la tasa, la que se ve en el campo), y la casilla como esté', () => {
    expect(transferInput(filled, '2026-11-01', ctx)).toEqual({
      date: '2026-10-02',
      via: 'PayPal',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 500,
      rate: 58.9,
      budget: false,
      fee: 0,
    });
    expect(transferInput({ ...newTransferDraft(), amount: 500 }, '2026-11-01', ctx)).toEqual({
      date: '2026-11-01',
      via: 'Remitly',
      fromAccountId: 'us',
      toAccountId: 'dr',
      amount: 500,
      rate: 58.76,
      budget: true,
      fee: 0,
    });
  });

  it('la vía es texto libre: va lo que se escriba, sin espacios sobrantes', () => {
    expect(transferInput({ ...filled, via: 'Western Union' }, '2026-11-01', ctx)?.via).toBe('Western Union');
    expect(transferInput({ ...filled, via: '  Banco Popular ' }, '2026-11-01', ctx)?.via).toBe('Banco Popular');
    expect(transferInput({ ...filled, via: 'paypal' }, '2026-11-01', ctx)?.via).toBe('paypal');
  });

  it('una vía vacía no frena el envío: se manda la de por defecto', () => {
    for (const via of ['', '   ']) {
      expect(canAddTransfer({ ...filled, via }, ctx)).toBe(true);
      expect(transferInput({ ...filled, via }, '2026-11-01', ctx)?.via).toBe('Remitly');
    }
  });

  it('la comisión: sin tocar, la del último envío por esa vía (y la sigue si cambia la vía); escrita, la escrita', () => {
    const state = seedState();
    // Remitly cobró 2.99 en su último envío de septiembre y 3.49 en octubre; PayPal, nada.
    state.months['2026-09']!.transfers.at(-1)!.fee = 2.99;
    state.months['2026-10']!.transfers[0]!.fee = 3.49;
    const withFees = transferContext(state);
    expect(transferFee(newTransferDraft(), withFees)).toBe(3.49);
    expect(transferFee({ ...newTransferDraft(), via: ' remitly ' }, withFees)).toBe(3.49);
    expect(transferFee({ ...newTransferDraft(), via: 'PayPal' }, withFees)).toBe(0);
    expect(transferFee({ ...newTransferDraft(), via: 'Wise' }, withFees)).toBe(0);
    // Mirando septiembre, lo de octubre todavía no existe.
    expect(transferFee(newTransferDraft(), transferContext(state, '2026-09'))).toBe(2.99);
    // Escrita (también 0) manda.
    expect(transferFee({ ...newTransferDraft(), fee: 0 }, withFees)).toBe(0);
    expect(transferFee({ ...newTransferDraft(), fee: 1.5 }, withFees)).toBe(1.5);
    expect(transferInput({ ...newTransferDraft(), amount: 500 }, '2026-10-07', withFees)?.fee).toBe(3.49);
  });

  it('después de agregar solo se limpia el monto (y la comisión vuelve a seguir a la vía)', () => {
    expect(afterTransferAdded(filled)).toEqual({ ...filled, amount: 0, fee: null });
    expect(afterTransferAdded({ ...filled, via: 'Western Union' }).via).toBe('Western Union');
    expect(afterTransferAdded({ ...newTransferDraft(), amount: 500 })).toEqual(newTransferDraft());
    expect(filled.amount).toBe(500);
  });

  it('después de agregar, la vía queda como se guardó: sin espacios, o la de por defecto si estaba vacía', () => {
    expect(afterTransferAdded({ ...filled, via: ' Wise ' }).via).toBe('Wise');
    expect(afterTransferAdded({ ...filled, via: '' }).via).toBe('Remitly');
    expect(afterTransferAdded({ ...filled, via: '  ' }).via).toBe('Remitly');
  });
});

describe('tasa del mes: la fila de agregar', () => {
  it('sin tocar propone el primer par que aún no tiene tasa escrita', () => {
    const state = seedState();
    // Octubre tiene escrita USD → DOP; las otras dos salen del valor de respaldo.
    const october = pairRates(state, '2026-10');
    expect(ratePair(EMPTY_RATE, october, 'DOP', 'USD')).toEqual(['TRY', 'DOP']);
    // Septiembre no tiene ninguna escrita: el par de la barra superior.
    expect(ratePair(EMPTY_RATE, pairRates(state, '2026-09'), 'DOP', 'USD')).toEqual(['USD', 'DOP']);
  });

  it('si todas están escritas, el primero; sin filas, segunda → principal', () => {
    const state = seedState();
    const only = pairRates(state, '2026-10').slice(0, 1);
    expect(ratePair(EMPTY_RATE, only, 'DOP', 'USD')).toEqual(['USD', 'DOP']);
    expect(ratePair(EMPTY_RATE, [], 'TRY', 'USD')).toEqual(['USD', 'TRY']);
  });

  it('el par elegido manda', () => {
    expect(ratePair({ pair: ['TRY', 'DOP'], rate: 0, date: null }, pairRates(seedState(), '2026-10'), 'DOP', 'USD')).toEqual(['TRY', 'DOP']);
  });

  it('las dos monedas son distintas: elegir la del otro lado invierte el par', () => {
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'TRY')).toEqual(['TRY', 'DOP']);
    expect(pickRateCurrency(['USD', 'DOP'], 'to', 'TRY')).toEqual(['USD', 'TRY']);
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'DOP')).toEqual(['DOP', 'USD']);
    expect(pickRateCurrency(['USD', 'DOP'], 'to', 'USD')).toEqual(['DOP', 'USD']);
    expect(pickRateCurrency(['USD', 'DOP'], 'from', 'USD')).toEqual(['USD', 'DOP']);
  });

  it('el borrador vacío no trae par, tasa ni fecha', () => {
    expect(EMPTY_RATE).toEqual({ pair: null, rate: 0, date: null });
  });

  it('la fecha sin tocar: hoy si el par ya tiene una tasa escrita vigente y el mes es el actual', () => {
    const rates = pairRates(seedState(), '2026-10');
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], rates, '2026-10', '2026-10-07')).toBe('2026-10-07');
    // El par invertido es el mismo par.
    expect(rateDate(EMPTY_RATE, ['DOP', 'USD'], rates, '2026-10', '2026-10-07')).toBe('2026-10-07');
  });

  it('la fecha sin tocar: el primer día del mes si el mes seleccionado no es el actual', () => {
    const rates = pairRates(seedState(), '2026-10');
    // draftDate ya es el día 1 cuando hoy no cae en el mes seleccionado (buildFinanzas).
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], rates, '2026-10', '2026-10-01')).toBe('2026-10-01');
  });

  it('la fecha sin tocar: el primer día del mes si el par no tiene ninguna tasa escrita, aunque hoy sea otro día', () => {
    const state = seedState();
    const rates = pairRates(state, '2026-10');
    expect(rateDate(EMPTY_RATE, ['TRY', 'DOP'], rates, '2026-10', '2026-10-07')).toBe('2026-10-01');
    expect(rateDate(EMPTY_RATE, ['USD', 'TRY'], rates, '2026-10', '2026-10-07')).toBe('2026-10-01');
    // Septiembre saca la suya de los envíos: tampoco hay escrita.
    expect(rateDate(EMPTY_RATE, ['USD', 'DOP'], pairRates(state, '2026-09'), '2026-09', '2026-09-20')).toBe('2026-09-01');
  });

  it('la fecha sigue al par mientras no se elija una; la elegida manda', () => {
    const rates = pairRates(seedState(), '2026-10');
    const pairs = [ratePair(EMPTY_RATE, rates, 'DOP', 'USD'), pickRateCurrency(['TRY', 'DOP'], 'from', 'USD')];
    expect(pairs).toEqual([
      ['TRY', 'DOP'],
      ['USD', 'DOP'],
    ]);
    expect(pairs.map((pair) => rateDate(EMPTY_RATE, pair, rates, '2026-10', '2026-10-07'))).toEqual(['2026-10-01', '2026-10-07']);
    const chosen = { ...EMPTY_RATE, date: '2026-10-03' };
    expect(pairs.map((pair) => rateDate(chosen, pair, rates, '2026-10', '2026-10-07'))).toEqual(['2026-10-03', '2026-10-03']);
  });

  it('necesita una tasa mayor que 0', () => {
    expect(canAddRate({ pair: null, rate: 58.76, date: null })).toBe(true);
    expect(canAddRate({ pair: ['USD', 'TRY'], rate: 0.024, date: '2026-10-03' })).toBe(true);
    expect(canAddRate(EMPTY_RATE)).toBe(false);
    expect(canAddRate({ pair: null, rate: -1, date: null })).toBe(false);
    expect(canAddRate({ pair: null, rate: Number.NaN, date: null })).toBe(false);
  });
});
