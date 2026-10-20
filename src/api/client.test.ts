import { describe, expect, it } from 'vitest';
import { seedState } from '../../shared/seed';
import { USER_HEADER } from '../../shared/users';
import { ApiError, createApiClient, isAbortError, NetworkError, XLSX_MIME } from './client';
import type { FetchLike, UserApi } from './client';

interface Seen {
  url: string;
  init: RequestInit;
}

function clientWith(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const call = { url, init };
    seen.push(call);
    return respond(call);
  };
  const root = createApiClient(fetchImpl);
  return { root, api: root.forUser('frank'), seen };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('HTTP client', () => {
  it('GET /api/session carries no user and returns the body as is', async () => {
    const body = { users: [{ id: 'frank', name: 'Frank' }, { id: 'eda', name: 'Eda' }], devTools: true };
    const { root, seen } = clientWith(() => json(200, body));
    await expect(root.getSession()).resolves.toEqual(body);
    expect(seen[0]!.url).toBe('/api/session');
    expect(seen[0]!.init.method).toBe('GET');
    expect(header(seen[0]!.init, USER_HEADER)).toBeNull();
  });

  it('GET /api/state returns the body as is', async () => {
    const body = { user: { id: 'frank', name: 'Frank' }, state: seedState() };
    const { api, seen } = clientWith(() => json(200, body));
    await expect(api.getState()).resolves.toEqual(body);
    expect(seen[0]!.url).toBe('/api/state');
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.body).toBeUndefined();
    expect(header(seen[0]!.init, USER_HEADER)).toBe('frank');
  });

  it('writes send JSON and encode the id in the route', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    await api.patchTransaction('a/b c', { amount: 12.5 });
    await api.createFixed({ id: 'x', monthKey: '2026-10', name: 'Gym', amount: 10, cur: 'DOP' });
    await api.deleteTransfer('t1');
    await api.closeMonth('2026-10');
    await api.patchSettings({ language: 'tr' });
    await api.createGoal({ id: 'g1', name: 'Car', cur: 'TRY', monthly: 500, start: '2026-10', end: '2027-09', approxCur: 'USD' });
    await api.patchGoal('g1', { name: 'New car' });
    await api.deleteGoal('g1');

    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      'PATCH /api/transactions/a%2Fb%20c',
      'POST /api/fixed',
      'DELETE /api/transfers/t1',
      'POST /api/months/2026-10/close',
      'PATCH /api/settings',
      'POST /api/goals',
      'PATCH /api/goals/g1',
      'DELETE /api/goals/g1',
    ]);
    expect(seen[0]!.init.body).toBe('{"amount":12.5}');
    expect(header(seen[0]!.init, 'Content-Type')).toBe('application/json');
    expect(header(seen[2]!.init, 'Content-Type')).toBeNull();
    expect(seen[4]!.init.body).toBe('{"language":"tr"}');
    expect(JSON.parse(seen[5]!.init.body as string)).toEqual({ id: 'g1', name: 'Car', cur: 'TRY', monthly: 500, start: '2026-10', end: '2027-09', approxCur: 'USD' });
  });

  it('accounts, month rates, income and deleting a month: each route of the contract with its method and body', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    await api.listAccounts();
    await api.createAccount({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 1500 });
    await api.patchAccount('a/1', { hidden: true });
    await api.deleteAccount('tr');
    await api.patchMonth('2026-10', { budgets: { dr: 60000, us: 200 } });
    await api.putMonthRate('2026-10', { from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' });
    await api.deleteMonthRate('2026-10', 'USD', 'TRY', '2026-10-07');
    await api.deleteMonth('2026-09');
    await api.listIncomes();
    await api.createIncome({ id: 'i1', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD', budget: true });
    await api.patchIncome('i1', { amount: 6000 });
    await api.deleteIncome('i1');
    await api.createTransfer({ id: 't1', monthKey: '2026-10', date: '2026-10-02', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1500 });
    await api.patchTransfer('t1', { toAccountId: 'tr', rate: 40 });
    await api.patchContribution('c1', { goalId: 'personal' });

    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      'GET /api/accounts',
      'POST /api/accounts',
      'PATCH /api/accounts/a%2F1',
      'DELETE /api/accounts/tr',
      'PATCH /api/months/2026-10',
      'PUT /api/months/2026-10/rates',
      // The rate's date goes in the query: the route asks for it that way.
      'DELETE /api/months/2026-10/rates/USD/TRY?date=2026-10-07',
      'DELETE /api/months/2026-09',
      'GET /api/incomes',
      'POST /api/incomes',
      'PATCH /api/incomes/i1',
      'DELETE /api/incomes/i1',
      'POST /api/transfers',
      'PATCH /api/transfers/t1',
      'PATCH /api/contributions/c1',
    ]);
    const body = (i: number) => JSON.parse(seen[i]!.init.body as string) as unknown;
    expect(body(1)).toEqual({ id: 'tr', name: 'TR account', currency: 'TRY', opening: 1500 });
    expect(body(2)).toEqual({ hidden: true });
    expect(body(4)).toEqual({ budgets: { dr: 60000, us: 200 } });
    expect(body(5)).toEqual({ from: 'USD', to: 'DOP', rate: 59.1, date: '2026-10-07' });
    expect(body(9)).toEqual({ id: 'i1', date: '2026-10-01', desc: 'Salary', accountId: 'us', amount: 5800, cur: 'USD', budget: true });
    // No rate: the server sets it (the month rate for that pair).
    expect(body(12)).toEqual({ id: 't1', monthKey: '2026-10', date: '2026-10-02', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1500 });
    // Deletes carry no body.
    for (const i of [3, 6, 7, 11]) expect(seen[i]!.init.body, String(i)).toBeUndefined();
  });

  it('budget log and leftover: adding and removing a movement, and adding what was left over from the previous month', async () => {
    const { api, seen } = clientWith(() => json(201, {}));
    const entry = { id: 'b1', date: '2026-10-09', accountId: 'dr', amount: -2500, kind: 'adjust', note: 'Less eating out' } as const;
    await api.addBudgetEntry('2026-10', entry);
    await api.deleteBudgetEntry('2026-10', 'b/1 x');
    await api.addLeftover('2026-10');

    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      'POST /api/months/2026-10/budget-log',
      'DELETE /api/months/2026-10/budget-log/b%2F1%20x',
      'POST /api/months/2026-10/leftover',
    ]);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual(entry);
    expect(header(seen[0]!.init, 'Content-Type')).toBe('application/json');
    // Neither the delete nor the leftover carries a body: the server computes the leftover figure.
    for (const i of [1, 2]) {
      expect(seen[i]!.init.body, String(i)).toBeUndefined();
      expect(header(seen[i]!.init, 'Content-Type'), String(i)).toBeNull();
    }
  });

  it('closing a month: without a request there is no body; with one it travels as JSON', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    const controller = new AbortController();
    await api.closeMonth('2026-10');
    await api.closeMonth('2026-10', { budgets: { dr: 65000, us: 0 }, addLeftover: true });
    await api.closeMonth('2026-10', {});
    // The request options go after it: without a body they are not mistaken for it.
    await api.closeMonth('2026-10', undefined, { signal: controller.signal });

    for (const s of seen) expect(`${s.init.method} ${s.url}`).toBe('POST /api/months/2026-10/close');
    expect(seen[0]!.init.body).toBeUndefined();
    expect(header(seen[0]!.init, 'Content-Type')).toBeNull();
    expect(JSON.parse(seen[1]!.init.body as string)).toEqual({ budgets: { dr: 65000, us: 0 }, addLeftover: true });
    expect(header(seen[1]!.init, 'Content-Type')).toBe('application/json');
    expect(seen[2]!.init.body).toBe('{}');
    expect(seen[3]!.init.body).toBeUndefined();
    expect(seen[3]!.init.signal).toBe(controller.signal);
  });

  it('the date of the rate being removed is encoded in the query, and the options go after it', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    const controller = new AbortController();
    await api.deleteMonthRate('2026-10', 'DOP', 'USD', '2026-10-01', { signal: controller.signal, keepalive: true });
    expect(seen[0]!.url).toBe('/api/months/2026-10/rates/DOP/USD?date=2026-10-01');
    expect(seen[0]!.init.method).toBe('DELETE');
    expect(seen[0]!.init.body).toBeUndefined();
    expect(seen[0]!.init.signal).toBe(controller.signal);
    expect(seen[0]!.init.keepalive).toBe(true);
    // Anything that is not a date does not break the route.
    await api.deleteMonthRate('2026-10', 'DOP', 'USD', '2026-10-01&x=1');
    expect(seen[1]!.url).toBe('/api/months/2026-10/rates/DOP/USD?date=2026-10-01%26x%3D1');
  });

  it('passes signal and keepalive', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    const controller = new AbortController();
    await api.patchMonth('2026-10', { budgets: { dr: 1 } }, { signal: controller.signal, keepalive: true });
    expect(seen[0]!.init.signal).toBe(controller.signal);
    expect(seen[0]!.init.keepalive).toBe(true);
  });

  it('a non-2xx with an API body becomes an ApiError with its code, status and message', async () => {
    const { api } = clientWith(() => json(409, { error: { code: 'month_closed', message: 'October 2026 is closed.' } }));
    const error = await api.patchFixed('f1', { paid: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'ApiError', status: 409, code: 'month_closed', message: 'October 2026 is closed.' });
  });

  it('a non-2xx without the API body (a proxy page) is also an ApiError', async () => {
    const { api } = clientWith(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api.getState()).rejects.toMatchObject({ name: 'ApiError', status: 502, code: 'internal' });
    const { api: api404 } = clientWith(() => new Response('', { status: 404 }));
    await expect(api404.getMonth('2020-01')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('a 2xx that is not JSON is an ApiError, not a syntax error', async () => {
    const { api } = clientWith(() => new Response('<html>login</html>', { status: 200 }));
    await expect(api.getState()).rejects.toMatchObject({ name: 'ApiError', code: 'internal' });
  });

  it('if fetch fails, the error is a NetworkError (distinct from ApiError)', async () => {
    const cause = new TypeError('Failed to fetch');
    const { api, root } = clientWith(() => {
      throw cause;
    });
    const error = await api.getState().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as NetworkError).cause).toBe(cause);
    await expect(root.getSession()).rejects.toBeInstanceOf(NetworkError);
  });

  it('a cancellation is let through as is', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const { api } = clientWith(() => {
      throw abort;
    });
    const error = await api.getState().catch((e: unknown) => e);
    expect(error).toBe(abort);
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new TypeError('x'))).toBe(false);
  });

  it('export returns a Blob', async () => {
    const { api, seen } = clientWith(() => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'Content-Type': XLSX_MIME } }));
    const blob = await api.exportExcel();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(4);
    expect(seen[0]!.url).toBe('/api/export.xlsx');
    expect(header(seen[0]!.init, 'Accept')).toBe(XLSX_MIME);
  });

  it('import sends the raw file with its content type', async () => {
    const { api, seen } = clientWith(() => json(200, { months: ['2026-10'], contributions: 0 }));
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: XLSX_MIME });
    await expect(api.importExcel(file)).resolves.toEqual({ months: ['2026-10'], contributions: 0 });
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.body).toBe(file);
    expect(header(seen[0]!.init, 'Content-Type')).toBe(XLSX_MIME);

    // Some systems do not report the file's type: .xlsx is assumed.
    await api.importExcel(new Blob([new Uint8Array([1])]));
    expect(header(seen[1]!.init, 'Content-Type')).toBe(XLSX_MIME);
  });

  it('ingest carries the Bearer, and the user in the body, not in the header', async () => {
    const { root, seen } = clientWith(() => json(201, {}));
    await root.ingestTransaction({ user: 'eda', description: 'Uber', amount: 850 }, 'secreto');
    expect(header(seen[0]!.init, 'Authorization')).toBe('Bearer secreto');
    expect(header(seen[0]!.init, USER_HEADER)).toBeNull();
    expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({ user: 'eda' });
  });
});

describe('X-User header', () => {
  const file = new Blob([new Uint8Array([1])], { type: XLSX_MIME });
  const fixed = { id: 'x', monthKey: '2026-10', name: 'Gym', amount: 10, cur: 'DOP' } as const;
  const tx = { id: 'x', monthKey: '2026-10', date: '2026-10-07', desc: 'Uber', cat: 'Transport', method: 'Card', amount: 1, cur: 'DOP' } as const;
  const transfer = { id: 'x', monthKey: '2026-10', date: '2026-10-07', via: 'Remitly', fromAccountId: 'us', toAccountId: 'dr', amount: 1, rate: 58 };
  const income = { id: 'x', date: '2026-10-07', accountId: 'us', amount: 1, cur: 'USD' } as const;
  const contribution = { id: 'x', goalId: 'personal', date: '2026-10-07', amount: 1, cur: 'USD' } as const;

  /** One call per data route. Record: a new route in the client does not compile until it is here. */
  const CALLS: Record<Exclude<keyof UserApi, 'userId'>, (api: UserApi) => Promise<unknown>> = {
    getState: (api) => api.getState(),
    patchSettings: (api) => api.patchSettings({ theme: null }),
    listAccounts: (api) => api.listAccounts(),
    createAccount: (api) => api.createAccount({ name: 'PayPal', currency: 'USD' }),
    patchAccount: (api) => api.patchAccount('x', { name: 'PayPal' }),
    deleteAccount: (api) => api.deleteAccount('x'),
    listMonths: (api) => api.listMonths(),
    getMonth: (api) => api.getMonth('2026-10'),
    patchMonth: (api) => api.patchMonth('2026-10', { budgets: { dr: 1 } }),
    addBudgetEntry: (api) => api.addBudgetEntry('2026-10', { accountId: 'dr', amount: 500 }),
    deleteBudgetEntry: (api) => api.deleteBudgetEntry('2026-10', 'x'),
    addLeftover: (api) => api.addLeftover('2026-10'),
    setCardOther: (api) => api.setCardOther('2026-10', 'card', { other: 100 }),
    setCardCashback: (api) => api.setCardCashback('2026-10', 'card', { cashback: 5 }),
    payCard: (api) => api.payCard('2026-10', 'card', { amount: 50, accountId: 'dr' }),
    includeCardPurchases: (api) => api.includeCardPurchases('2026-10', 'card', { transactionIds: ['x'], destination: 'history' }),
    unpayCard: (api) => api.unpayCard('2026-10', 'card'),
    removeCardPayment: (api) => api.removeCardPayment('2026-10', 'card', 'x'),
    listCreditCards: (api) => api.listCreditCards(),
    createCreditCard: (api) => api.createCreditCard({ name: 'Visa' }),
    patchCreditCard: (api) => api.patchCreditCard('card', { name: 'Visa' }),
    deleteCreditCard: (api) => api.deleteCreditCard('card'),
    putMonthRate: (api) => api.putMonthRate('2026-10', { from: 'USD', to: 'DOP', rate: 59, date: '2026-10-07' }),
    deleteMonthRate: (api) => api.deleteMonthRate('2026-10', 'USD', 'DOP', '2026-10-07'),
    closeMonth: (api) => api.closeMonth('2026-10'),
    reopenMonth: (api) => api.reopenMonth('2026-10'),
    deleteMonth: (api) => api.deleteMonth('2026-10'),
    createFixed: (api) => api.createFixed(fixed),
    patchFixed: (api) => api.patchFixed('x', { paid: true }),
    deleteFixed: (api) => api.deleteFixed('x'),
    createTransaction: (api) => api.createTransaction(tx),
    patchTransaction: (api) => api.patchTransaction('x', { amount: 2 }),
    deleteTransaction: (api) => api.deleteTransaction('x'),
    moveTransactionOutside: (api) => api.moveTransactionOutside('x', { id: 'y' }),
    createOutside: (api) => api.createOutside({ id: 'x', monthKey: '2026-10', date: '2026-10-07', name: 'Repair', amount: 1 }),
    patchOutside: (api) => api.patchOutside('x', { amount: 2 }),
    deleteOutside: (api) => api.deleteOutside('x'),
    moveOutsideToBudget: (api) => api.moveOutsideToBudget('x', { id: 'y' }),
    createTransfer: (api) => api.createTransfer(transfer),
    patchTransfer: (api) => api.patchTransfer('x', { via: 'Wise' }),
    deleteTransfer: (api) => api.deleteTransfer('x'),
    listIncomes: (api) => api.listIncomes(),
    createIncome: (api) => api.createIncome(income),
    patchIncome: (api) => api.patchIncome('x', { amount: 2 }),
    deleteIncome: (api) => api.deleteIncome('x'),
    listGoals: (api) => api.listGoals(),
    createGoal: (api) => api.createGoal({ name: 'Car' }),
    patchGoal: (api) => api.patchGoal('x', { name: 'Car' }),
    deleteGoal: (api) => api.deleteGoal('x'),
    listContributions: (api) => api.listContributions(),
    createContribution: (api) => api.createContribution(contribution),
    patchContribution: (api) => api.patchContribution('x', { amount: 2 }),
    deleteContribution: (api) => api.deleteContribution('x'),
    exportExcel: (api) => api.exportExcel(),
    importExcel: (api) => api.importExcel(file),
    importPayload: (api) => api.importPayload({ months: [], contribs: null, goals: null }),
    devSeed: (api) => api.devSeed(),
    devReset: (api) => api.devReset(),
  };

  it('goes in each and every forUser() call, with the id of that user', async () => {
    const { root, seen } = clientWith(() => json(200, {}));
    const eda = root.forUser('eda');
    expect(eda.userId).toBe('eda');
    // The table covers the whole object: no route is left unchecked.
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(eda).filter((k) => k !== 'userId').sort());

    for (const [name, call] of Object.entries(CALLS)) {
      const before = seen.length;
      await call(eda);
      expect(seen.length, name).toBe(before + 1);
      expect(header(seen[before]!.init, USER_HEADER), name).toBe('eda');
    }
  });

  it('each forUser() sends its own even when they are used at the same time', async () => {
    const { root, seen } = clientWith(() => json(200, {}));
    const frank = root.forUser('frank');
    const eda = root.forUser('eda');
    await Promise.all([frank.patchMonth('2026-10', { budgets: { dr: 1 } }), eda.patchMonth('2026-10', { budgets: { dr: 2 } }), frank.getState()]);
    expect(seen.map((s) => [header(s.init, USER_HEADER), s.init.body ?? null])).toEqual([
      ['frank', '{"budgets":{"dr":1}}'],
      ['eda', '{"budgets":{"dr":2}}'],
      ['frank', null],
    ]);
  });

  it('headers set by a call itself do not overwrite it', async () => {
    const { api, seen } = clientWith(() => json(200, {}));
    await api.importExcel(file);
    expect(header(seen[0]!.init, USER_HEADER)).toBe('frank');
    expect(header(seen[0]!.init, 'Content-Type')).toBe(XLSX_MIME);
  });
});
