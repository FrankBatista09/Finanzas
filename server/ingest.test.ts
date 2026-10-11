import { afterEach, describe, expect, it } from 'vitest';
import type { IngestResponse, IngestTransaction } from '../shared/api';
import { currentMonthKey, monthOf, todayISO } from '../shared/month';
import { balances } from '../shared/calc';
import { DEFAULT_ACCOUNTS, DEFAULT_GOALS } from '../shared/constants';
import { seedState } from '../shared/seed';
import type { Account, AppState } from '../shared/types';
import { createAccount, createCard, createFixed, getMonth, listAccounts, listGoals, loadState, patchAccount, replaceAll, updateSettings } from './db';
import type { Env } from './env';
import { ingestTransaction, matchAccount } from './ingest';
import { client, count, EDA, FRANK, makeEnv, TOKEN } from './test-util';

const AUTH = { Authorization: `Bearer ${TOKEN}` };
const PATH = '/api/ingest/transaction';
const F = FRANK.id;
const E = EDA.id;
const BOTH = [FRANK, EDA];

let bystander: { db: D1Database; before: AppState } | null = null;

/** Both users with the sample data; at the end it checks that Eda's data is still intact. The client sends no X-User. */
async function seeded(extra: Partial<Env> = {}) {
  const t = makeEnv(extra);
  await replaceAll(t.db, F, seedState());
  await replaceAll(t.db, E, seedState());
  bystander = { db: t.db, before: await loadState(t.db, E) };
  return { ...t, api: client(t.env, null) };
}

/** An empty database with a client without X-User: what Claude records carries the user in the body. */
function fresh(extra: Partial<Env> = {}) {
  const t = makeEnv(extra);
  return { ...t, api: client(t.env, null) };
}

afterEach(async () => {
  const watched = bystander;
  bystander = null;
  if (watched) expect(await loadState(watched.db, E)).toEqual(watched.before);
});

describe('POST /api/ingest/transaction: authentication', () => {
  const body = { user: 'frank', description: 'Uber', amount: 850 };

  it('401 with no token, with a wrong token or with another scheme', async () => {
    const { api, sqlite } = fresh();
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer otro-token' },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { Authorization: 'Bearer ' },
      { Authorization: TOKEN },
      { Authorization: `Basic ${TOKEN}` },
      { Authorization: `Bearer ${TOKEN} extra` },
      // Saying who you are does not replace the token.
      { 'X-User': 'frank' },
    ];
    for (const headers of attempts) {
      const r = await api.post(PATH, body, headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid or missing token.' } });
      expect(r.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(count(sqlite, 'transactions')).toBe(0);
    expect(count(sqlite, 'months')).toBe(0);
    // With no token nobody gets set up.
    expect(count(sqlite, 'accounts')).toBe(0);
  });

  it('401 always if API_TOKEN is not configured', async () => {
    for (const token of [undefined, '']) {
      const { sqlite, db } = makeEnv();
      const env: Env = token === undefined ? { DB: db } : { DB: db, API_TOKEN: token };
      const api = client(env, null);
      const attempts: Record<string, string>[] = [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }, AUTH];
      for (const headers of attempts) {
        const r = await api.post(PATH, body, headers);
        expect(r.status).toBe(401);
        expect(r.headers.get('WWW-Authenticate')).toBe('Bearer');
      }
      expect(count(sqlite, 'transactions')).toBe(0);
    }
  });

  it('the token is required on all of /api/ingest/*, whether or not the route exists, and before looking at the user', async () => {
    const { api } = fresh();
    expect((await api.post('/api/ingest/otra-cosa', body)).status).toBe(401);
    expect((await api.get('/api/ingest/transaction')).status).toBe(401);
    expect((await api.post(PATH, { description: 'sin usuario', amount: 1 })).status).toBe(401);
    expect((await api.post('/api/ingest/otra-cosa', body, AUTH)).status).toBe(404);
    expect((await api.post('/api/ingest', body, AUTH)).status).toBe(404);
  });

  it('the Bearer scheme is case-insensitive', async () => {
    const { api } = fresh();
    expect((await api.post(PATH, body, { Authorization: `bearer ${TOKEN}` })).status).toBe(201);
  });

  it('with Bearer there is no need to come from a same-site browser', async () => {
    const { api } = fresh();
    expect((await api.post(PATH, body, { ...AUTH, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(201);
  });
});

describe('POST /api/ingest/transaction: whose expense it is', () => {
  it('with several users, `user` is required: 400 with the valid ids if it is missing or does not exist', async () => {
    const { api, sqlite } = fresh();
    const required = {
      code: 'validation',
      message: 'Invalid data: user: is required when there are several users (valid ids: frank, eda)',
    };
    for (const body of [{ description: 'Uber', amount: 850 }, { description: 'Uber', amount: 850, user: null }, { description: 'Uber', amount: 850, user: '  ' }]) {
      const r = await api.post(PATH, body, AUTH);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error).toEqual(required);
    }
    // The X-User header belongs to the web app: it does not count here.
    expect((await api.post(PATH, { description: 'Uber', amount: 850 }, { ...AUTH, 'X-User': 'frank' })).error).toEqual(required);

    const unknown = await api.post(PATH, { description: 'Uber', amount: 850, user: 'pedro' }, AUTH);
    expect(unknown.status).toBe(400);
    expect(unknown.error).toEqual({ code: 'validation', message: 'Invalid data: user: unknown user "pedro" (valid ids: frank, eda)' });
    // The name is not the id.
    expect((await api.post(PATH, { description: 'Uber', amount: 850, user: 'Frank Reyes' }, AUTH)).status).toBe(400);
    expect((await api.post(PATH, { description: 'Uber', amount: 850, user: 7 }, AUTH)).status).toBe(400);
    expect(count(sqlite, 'months')).toBe(0);
    expect(count(sqlite, 'transactions')).toBe(0);
    expect(count(sqlite, 'accounts')).toBe(0);
  });

  it('the expense goes to the finances of that user and of nobody else', async () => {
    const { api, db, sqlite } = fresh();
    const eda = await api.post<IngestResponse>(PATH, { user: 'eda', description: 'Market', amount: 400, date: '2026-10-05' }, AUTH);
    expect(eda.status).toBe(201);
    expect(eda.body.monthCreated).toBe(true);
    expect((await getMonth(db, E, '2026-10'))!.tx).toEqual([eda.body.transaction]);
    expect(await getMonth(db, F, '2026-10')).toBeNull();

    // Same month for Frank: it is another month, which also has to be created. The id is accepted in a different case.
    const frank = await api.post<IngestResponse>(PATH, { user: ' Frank ', description: 'Uber', amount: 850, date: '2026-10-06' }, AUTH);
    expect(frank.status).toBe(201);
    expect(frank.body.monthCreated).toBe(true);
    expect((await getMonth(db, F, '2026-10'))!.tx.map((t) => t.desc)).toEqual(['Uber']);
    expect((await getMonth(db, E, '2026-10'))!.tx.map((t) => t.desc)).toEqual(['Market']);
    expect(count(sqlite, 'months')).toBe(2);
    // If the header of another user comes along too, the body wins.
    await api.post(PATH, { user: 'eda', description: 'Simit', amount: 50, date: '2026-10-07' }, { ...AUTH, 'X-User': 'frank' });
    expect((await getMonth(db, E, '2026-10'))!.tx.map((t) => t.desc)).toEqual(['Market', 'Simit']);
  });

  it('with a single configured user, `user` can be omitted (and if it is sent, it has to be that one)', async () => {
    for (const [users, id] of [
      ['frank:Frank', 'frank'],
      [undefined, 'me'],
    ] as const) {
      const { sqlite, db } = makeEnv();
      const env: Env = users === undefined ? { DB: db, API_TOKEN: TOKEN } : { DB: db, API_TOKEN: TOKEN, USERS: users };
      const api = client(env, null);
      expect((await api.post(PATH, { description: 'Uber', amount: 850 }, AUTH)).status).toBe(201);
      expect((await api.post(PATH, { description: 'Uber', amount: 850, user: id }, AUTH)).status).toBe(201);
      expect(count(sqlite, 'transactions', id)).toBe(2);
      const other = await api.post(PATH, { description: 'Uber', amount: 850, user: 'eda' }, AUTH);
      expect(other.status).toBe(400);
      expect(other.error?.message).toBe(`Invalid data: user: unknown user "eda" (valid ids: ${id})`);
      expect(count(sqlite, 'transactions')).toBe(2);
    }
  });
});

describe('POST /api/ingest/transaction', () => {
  it('201 with the default values (canonical); creates the month of today if it does not exist and, for someone who never opened the web app, their accounts', async () => {
    const { api, db, sqlite } = fresh();
    const today = todayISO();
    const r = await api.post<IngestResponse>(PATH, { user: 'frank', description: ' Uber ', amount: 850 }, AUTH);
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      monthCreated: true,
      transaction: {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        monthKey: monthOf(today),
        date: today,
        desc: 'Uber',
        place: '',
        cat: 'Food',
        method: 'Debit card',
        amount: 850,
        // A new user's default account is the one in their main currency (DOP), and the expense goes in its currency.
        cur: 'DOP',
        accountId: 'dr',
        notes: '',
        source: 'claude',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    expect((await getMonth(db, F, currentMonthKey()))!.tx).toEqual([r.body.transaction]);
    // Claude recorded before Frank opened the web app: he already has his initial accounts and goals. Eda, nothing.
    expect(await listAccounts(db, F)).toEqual([...DEFAULT_ACCOUNTS]);
    expect(await listGoals(db, F)).toEqual([...DEFAULT_GOALS]);
    expect(count(sqlite, 'accounts', E)).toBe(0);

    const second = await api.post<IngestResponse>(PATH, { user: 'frank', description: 'Café', amount: 200 }, AUTH);
    expect(second.body.monthCreated).toBe(false);
  });

  it('respects every field that is sent', async () => {
    const { api, db } = await seeded();
    const input: IngestTransaction = {
      user: 'frank',
      date: '2026-10-06',
      description: 'Vuelo',
      place: 'JetBlue',
      category: 'Travel',
      method: 'Transfer',
      amount: 320.45,
      currency: 'USD',
      account: 'us',
      notes: 'ida',
    };
    const r = await api.post<IngestResponse>(PATH, input, AUTH);
    expect(r.status).toBe(201);
    expect(r.body.monthCreated).toBe(false);
    expect(r.body.transaction).toMatchObject({
      monthKey: '2026-10',
      date: '2026-10-06',
      // What the user writes (description, place, notes) is not translated.
      desc: 'Vuelo',
      place: 'JetBlue',
      cat: 'Travel',
      method: 'Transfer',
      amount: 320.45,
      cur: 'USD',
      accountId: 'us',
      notes: 'ida',
      source: 'claude',
    });
    expect((await getMonth(db, F, '2026-10'))!.tx).toHaveLength(8);
  });

  it('a category or a method said in Spanish or in Turkish is saved under its canonical name', async () => {
    const { api, db } = fresh();
    // Paying by credit card needs a credit card to charge it to.
    await createCard(db, E, { name: 'Visa' });
    const stored = async (category: string, method: string) => {
      const r = await api.post<IngestResponse>(PATH, { user: 'eda', description: 'x', amount: 1, date: '2026-10-07', category, method }, AUTH);
      expect(r.status, `${category} / ${method}`).toBe(201);
      return [r.body.transaction.cat, r.body.transaction.method];
    };
    expect(await stored('Comida', 'Tarjeta')).toEqual(['Food', 'Debit card']);
    expect(await stored('Supermercado', 'Transferencia')).toEqual(['Groceries', 'Transfer']);
    expect(await stored('Yemek', 'Kart')).toEqual(['Food', 'Debit card']);
    expect(await stored('Ulaşım', 'Banka uygulaması')).toEqual(['Transport', 'Bank app']);
    // Case and spaces do not matter either, in any language.
    expect(await stored(' viajes ', 'APP DEL BANCO')).toEqual(['Travel', 'Bank app']);
    expect(await stored('food', 'card')).toEqual(['Food', 'Debit card']);
    expect(await stored('Subscriptions', 'Bank app')).toEqual(['Subscriptions', 'Bank app']);
    // Whatever is not on the lists is saved as is (trimmed).
    expect(await stored(' Mascotas ', ' Cheque ')).toEqual(['Mascotas', 'Cheque']);
    // A bare "Tarjeta", "Kart" or "card" is the debit card; the credit card and cash, by their name.
    expect(await stored('Comida', 'Tarjeta de débito')).toEqual(['Food', 'Debit card']);
    expect(await stored('Ropa', 'Tarjeta de crédito')).toEqual(['Clothing', 'Credit card']);
    expect(await stored('Giyim', 'Kredi kartı')).toEqual(['Clothing', 'Credit card']);
    expect(await stored('Clothing', 'credit card')).toEqual(['Clothing', 'Credit card']);
    expect(await stored('Comida', 'Efectivo')).toEqual(['Food', 'Cash']);
    expect(await stored('Yemek', 'Nakit')).toEqual(['Food', 'Cash']);
    expect(await stored('Food', 'cash')).toEqual(['Food', 'Cash']);
  });

  it('null or empty text in an optional field counts as "not sent"', async () => {
    const { api } = fresh({ USERS: 'frank:Frank' });
    const r = await api.post<IngestResponse>(
      PATH,
      { description: 'Pan', amount: 90, user: null, date: null, place: null, category: '  ', method: '', currency: null, account: ' ', notes: null },
      AUTH,
    );
    expect(r.status).toBe(201);
    expect(r.body.transaction).toMatchObject({ date: todayISO(), place: '', cat: 'Food', method: 'Debit card', cur: 'DOP', accountId: 'dr', notes: '' });
  });

  it('creates the month of the date by copying the fixed expenses from the nearest earlier month of that user', async () => {
    const { api, db } = await seeded();
    await createFixed(db, F, { monthKey: '2026-10', name: 'Solo de Frank', amount: 1, cur: 'DOP' });
    const r = await api.post<IngestResponse>(PATH, { user: 'frank', description: 'Regalo', amount: 1500, date: '2026-11-24' }, AUTH);
    expect(r.status).toBe(201);
    expect(r.body.monthCreated).toBe(true);
    expect(r.body.transaction.monthKey).toBe('2026-11');

    const december = (await getMonth(db, F, '2026-11'))!;
    expect(december).toMatchObject({ closed: false, budgets: { dr: 70000 }, rates: [] });
    expect(december.fixed).toHaveLength(12);
    expect(december.fixed.every((f) => !f.paid)).toBe(true);
    expect(december.tx).toEqual([r.body.transaction]);
    expect(Object.keys((await loadState(db, F)).months)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
  });

  it('409 month_closed if the month of the date is closed for that user, and saves nothing', async () => {
    const { api, sqlite, db } = await seeded();
    const r = await api.post(PATH, { user: 'frank', description: 'Tarde', amount: 100, date: '2026-08-15' }, AUTH);
    expect(r.status).toBe(409);
    expect(r.error).toEqual({ code: 'month_closed', message: 'August 2026 is closed: it is read-only. Reopen it to make changes.' });
    expect(count(sqlite, 'transactions', F)).toBe(27);

    // Eda having it closed does not prevent recording in Frank's open August.
    await db.prepare("UPDATE months SET closed = 0, closed_at = NULL WHERE user_id = 'frank' AND key = '2026-08'").run();
    expect((await api.post(PATH, { user: 'frank', description: 'Tarde', amount: 100, date: '2026-08-15' }, AUTH)).status).toBe(201);
    expect((await api.post(PATH, { user: 'eda', description: 'Tarde', amount: 100, date: '2026-08-15' }, AUTH)).status).toBe(409);
  });

  it('400 if the input is invalid', async () => {
    const { api, sqlite } = await seeded();
    const bad: unknown[] = [
      {},
      { description: 'x' },
      { amount: 10 },
      { description: '', amount: 10 },
      { description: 'x', amount: 0 },
      { description: 'x', amount: -3 },
      { description: 'x', amount: '850' },
      { description: 'x', amount: 10, currency: 'EUR' },
      { description: 'x', amount: 10, currency: 'try' },
      { description: 'x', amount: 10, account: 7 },
      { description: 'x', amount: 10, account: 'no-such-account' },
      { description: 'x', amount: 10, accountId: 'dr' },
      { description: 'x', amount: 10, date: '2026-02-30' },
      { description: 'x', amount: 10, date: 'hoy' },
      { description: 'x', amount: 10, monthKey: '2026-10' },
      { desc: 'x', amount: 10 },
      [],
      null,
    ];
    for (const body of bad) {
      const withUser = body && typeof body === 'object' && !Array.isArray(body) ? { user: 'frank', ...body } : body;
      const r = await api.post(PATH, withUser, AUTH);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.error?.code).toBe('validation');
    }
    const malformed = await api.raw(PATH, { method: 'POST', headers: AUTH, body: '{"description":' });
    expect(malformed.status).toBe(400);
    expect(count(sqlite, 'transactions', F)).toBe(27);
    expect(count(sqlite, 'months', F)).toBe(3);
  });
});

describe('POST /api/ingest/transaction: which account it comes out of', () => {
  const body = { user: 'frank', description: 'Uber', amount: 10, date: '2026-10-07' };

  /** Frank with three more accounts: one in TRY, another whose name starts like the DOP one and a hidden one. */
  async function accounts() {
    const t = await seeded();
    await createAccount(t.db, F, { id: 'tr', name: 'İş Bankası', currency: 'TRY' });
    await createAccount(t.db, F, { id: 'drs', name: 'DR savings', currency: 'DOP' });
    await createAccount(t.db, F, { id: 'old', name: 'Old PayPal', currency: 'USD' });
    await patchAccount(t.db, F, 'old', { hidden: true });
    const send = (extra: Partial<IngestTransaction>) => t.api.post<IngestResponse>(PATH, { ...body, ...extra }, AUTH);
    return { ...t, send };
  }

  it('without `account`: the default account of the user, and the expense in the currency of that account', async () => {
    const { send, db } = await accounts();
    // The sample data picks 'dr' (DOP).
    expect((await send({})).body.transaction).toMatchObject({ accountId: 'dr', cur: 'DOP' });
    await updateSettings(db, F, { defaultAccountId: 'us' });
    expect((await send({})).body.transaction).toMatchObject({ accountId: 'us', cur: 'USD' });
    await updateSettings(db, F, { defaultAccountId: 'tr' });
    expect((await send({})).body.transaction).toMatchObject({ accountId: 'tr', cur: 'TRY' });
    // Whatever currency is sent wins over the account's.
    expect((await send({ currency: 'DOP' })).body.transaction).toMatchObject({ accountId: 'tr', cur: 'DOP' });
    // Once hidden it stops being the default one: the first visible one in the main currency.
    await patchAccount(db, F, 'tr', { hidden: true });
    expect((await send({})).body.transaction).toMatchObject({ accountId: 'dr', cur: 'DOP' });
  });

  it('`account` is the id of the account or its name, ignoring case and accents; a unique prefix works', async () => {
    const { send } = await accounts();
    const used = async (account: string) => {
      const r = await send({ account });
      expect(r.status, account).toBe(201);
      return [r.body.transaction.accountId, r.body.transaction.cur];
    };
    // By id.
    expect(await used('us')).toEqual(['us', 'USD']);
    expect(await used('tr')).toEqual(['tr', 'TRY']);
    // By full name, however it is said.
    expect(await used('US account')).toEqual(['us', 'USD']);
    expect(await used('  dr ACCOUNT ')).toEqual(['dr', 'DOP']);
    expect(await used('is bankasi')).toEqual(['tr', 'TRY']);
    expect(await used('İŞ BANKASI')).toEqual(['tr', 'TRY']);
    // By a prefix that only one account has.
    expect(await used('US')).toEqual(['us', 'USD']);
    expect(await used('dr sav')).toEqual(['drs', 'DOP']);
    expect(await used('iş')).toEqual(['tr', 'TRY']);
    // A hidden one only when no visible one matches.
    expect(await used('old paypal')).toEqual(['old', 'USD']);
    expect(await used('old')).toEqual(['old', 'USD']);
  });

  it('an account that is not recognized or a prefix that several have: 400 with the names of their accounts, and saves nothing', async () => {
    const { send, sqlite, db } = await accounts();
    const names = 'US account, DR account, İş Bankası, DR savings';
    const unknown = await send({ account: 'Banreservas' });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toEqual({ code: 'validation', message: `Invalid data: account: unknown account "Banreservas" (accounts: ${names})` });
    // "DR" is the prefix of two accounts ("DR account" and "DR savings") and is not the full name of either.
    const ambiguous = await send({ account: 'DR' });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.error).toEqual({
      code: 'validation',
      message: `Invalid data: account: "DR" matches several accounts; use the full name of one of: ${names}`,
    });
    // The name is not returned in full if it is extremely long, and an account of another user does not exist.
    expect((await send({ account: 'x'.repeat(120) })).error?.message).toContain(`"${'x'.repeat(60)}"`);
    await createAccount(db, E, { id: 'solo-eda', name: 'Garanti', currency: 'TRY' });
    bystander = null;
    expect((await send({ account: 'solo-eda' })).status).toBe(400);
    expect((await send({ account: 'Garanti' })).status).toBe(400);
    expect((await send({ account: 'Garanti', user: 'eda' })).body.transaction).toMatchObject({ accountId: 'solo-eda', cur: 'TRY' });
    expect(count(sqlite, 'transactions', F)).toBe(27);
    // It never gets to create the month of the date either.
    expect((await send({ account: 'Banreservas', date: '2027-03-01' })).status).toBe(400);
    expect(await getMonth(db, F, '2027-03')).toBeNull();
  });

  it('the expense is subtracted from the balance of that account, converted to its currency with the month rate', async () => {
    const { send, db } = await accounts();
    const before = balances(await loadState(db, F), '2026-10').accounts;
    const of = (list: typeof before, id: string) => list.find((a) => a.account.id === id)!.balance;
    // 10 USD paid from the DOP account: at 58.76, they take 587.60 off it.
    expect((await send({ account: 'DR account', currency: 'USD' })).body.transaction).toMatchObject({ accountId: 'dr', cur: 'USD', amount: 10 });
    expect((await send({ account: 'US account' })).body.transaction).toMatchObject({ accountId: 'us', cur: 'USD', amount: 10 });
    const after = balances(await loadState(db, F), '2026-10').accounts;
    expect(of(after, 'dr')).toBeCloseTo(of(before, 'dr') - 587.6, 6);
    expect(of(after, 'us')).toBeCloseTo(of(before, 'us') - 10, 8);
  });
});

describe('matchAccount()', () => {
  const account = (id: string, name: string, hidden = false, sort = 0): Account => ({ id, name, currency: 'DOP', opening: 0, hidden, sort });
  const list = [account('a1', 'Banco Popular', false, 0), account('a2', 'Banco BHD', false, 1), account('a3', 'Popular dólares', false, 2), account('a4', 'Banco viejo', true, 3)];

  it('id, full name or unique prefix; visible ones first', () => {
    expect(matchAccount(list, 'a2').id).toBe('a2');
    expect(matchAccount(list, ' banco popular ').id).toBe('a1');
    expect(matchAccount(list, 'POPULAR DOLARES').id).toBe('a3');
    expect(matchAccount(list, 'banco b').id).toBe('a2');
    expect(matchAccount(list, 'pop').id).toBe('a3');
    // "banco v" only matches the hidden one.
    expect(matchAccount(list, 'Banco v').id).toBe('a4');
    // If a visible one and a hidden one match, it is the visible one: by prefix…
    const withOld = [...list, account('a5', 'Popular viejo', true, 4)];
    expect(matchAccount(withOld, 'pop').id).toBe('a3');
    expect(matchAccount(withOld, 'popular v').id).toBe('a5');
    // …and by name (two accounts can have the same name except for an accent).
    const twins = [account('h', 'Dólares', true, 0), account('v', 'Dolares', false, 1)];
    expect(matchAccount(twins, 'DOLARES').id).toBe('v');
    expect(matchAccount(twins, 'dól').id).toBe('v');
    // Being the full name beats also being the prefix of another one.
    const nested = [account('x', 'Cash'), account('y', 'Cash USD')];
    expect(matchAccount(nested, 'cash').id).toBe('x');
    // An id beats a name.
    expect(matchAccount([account('cash', 'Wallet'), account('z', 'Cash')], 'cash').id).toBe('cash');
  });

  it('throws 400 validation with the field and the names of the visible accounts (or of all of them, if none is visible)', () => {
    const names = 'Banco Popular, Banco BHD, Popular dólares';
    expect(() => matchAccount(list, 'banco')).toThrow(`Invalid data: account: "banco" matches several accounts; use the full name of one of: ${names}`);
    expect(() => matchAccount(list, 'Scotia', 'from')).toThrow(`Invalid data: from: unknown account "Scotia" (accounts: ${names})`);
    expect(() => matchAccount(list, '   ')).toThrow(/unknown account ""/);
    expect(() => matchAccount([], 'x')).toThrow('Invalid data: account: unknown account "x" (accounts: )');
    expect(() => matchAccount([account('h', 'Oculta', true)], 'x')).toThrow('(accounts: Oculta)');
    // Two visible ones that differ only by an accent: the id has to be given.
    const twins = [account('a', 'Dólares'), account('b', 'Dolares', false, 1)];
    expect(() => matchAccount(twins, 'dolares')).toThrow(/matches several accounts/);
    expect(matchAccount(twins, 'b').id).toBe('b');
    try {
      matchAccount(list, 'Scotia');
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: 'validation' });
    }
  });
});

describe('ingestTransaction()', () => {
  it('"today" is the date in the Dominican Republic, not in UTC', async () => {
    const { db } = makeEnv();
    // 02:30 UTC on November 1 is 22:30 on October 31 in Santo Domingo.
    const r = await ingestTransaction(db, BOTH, { user: 'frank', description: 'Cena', amount: 1200 }, new Date('2026-11-01T02:30:00Z'));
    expect(r.transaction.date).toBe('2026-10-31');
    expect(r.transaction.monthKey).toBe('2026-10');
    expect(r.transaction.createdAt).toBe('2026-11-01T02:30:00.000Z');
    expect(r.monthCreated).toBe(true);
  });

  it('receives the list of users from its caller (the API or the MCP) and resolves `user` against it', async () => {
    const { db, sqlite } = makeEnv();
    // With the list of a single user, it is that one, whether or not `user` is sent.
    await ingestTransaction(db, [EDA], { description: 'a', amount: 1 });
    await ingestTransaction(db, [EDA], { user: 'eda', description: 'b', amount: 1 });
    expect(count(sqlite, 'transactions', E)).toBe(2);
    await expect(ingestTransaction(db, [EDA], { user: 'frank', description: 'c', amount: 1 })).rejects.toMatchObject({
      status: 400,
      code: 'validation',
      message: 'Invalid data: user: unknown user "frank" (valid ids: eda)',
    });
    await expect(ingestTransaction(db, BOTH, { description: 'd', amount: 1 })).rejects.toMatchObject({ status: 400, code: 'validation' });
    await ingestTransaction(db, BOTH, { user: 'frank', description: 'e', amount: 1 });
    expect(count(sqlite, 'transactions', F)).toBe(1);
    expect(count(sqlite, 'transactions')).toBe(3);
  });

  it('validates its own input (the MCP server uses it too)', async () => {
    const { db, sqlite } = makeEnv();
    const bad = { user: 'frank', description: 'x', amount: Number.NaN } as IngestTransaction;
    await expect(ingestTransaction(db, BOTH, bad)).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(ingestTransaction(db, BOTH, { user: 'frank', description: 'x', amount: 1, extra: 1 } as IngestTransaction)).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(ingestTransaction(db, BOTH, undefined as unknown as IngestTransaction)).rejects.toMatchObject({ code: 'validation' });
    // An invalid input (or one with no user) never gets to create the month.
    await expect(ingestTransaction(db, BOTH, { description: 'x', amount: 1 })).rejects.toMatchObject({ code: 'validation' });
    expect(count(sqlite, 'months')).toBe(0);
  });

  it('only reads the accounts and the settings of the user to decide the account: it does not load their history', async () => {
    const { db } = makeEnv();
    await replaceAll(db, F, seedState());
    const read: string[] = [];
    const spy = {
      prepare: (query: string) => {
        if (/^\s*SELECT/i.test(query)) read.push(/FROM (\w+)/i.exec(query)?.[1] ?? query);
        return db.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    } as unknown as D1Database;
    const r = await ingestTransaction(spy, BOTH, { user: 'frank', description: 'x', amount: 1, date: '2026-10-07', account: 'us' });
    expect(r.transaction.accountId).toBe('us');
    // The accounts and the settings, and then the month it is saved in (to know if it exists and if it is closed):
    // nothing that does not belong to that month, and the transactions, only once (those of that month).
    expect(read.slice(0, 2)).toEqual(['accounts', 'settings']);
    for (const table of ['incomes', 'goals', 'contributions']) expect(read, table).not.toContain(table);
    expect(read.filter((table) => table === 'transactions')).toHaveLength(1);
  });

  it('throws month_closed without creating anything', async () => {
    const { db, sqlite } = makeEnv();
    await replaceAll(db, F, seedState());
    await expect(ingestTransaction(db, BOTH, { user: 'frank', description: 'x', amount: 1, date: '2026-09-30' })).rejects.toMatchObject({
      status: 409,
      code: 'month_closed',
    });
    expect(count(sqlite, 'transactions')).toBe(27);
  });
});
