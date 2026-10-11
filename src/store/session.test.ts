import { describe, expect, it } from 'vitest';
import { parseUsers } from '../../shared/users';
import { deviceMemory, resolveUser } from './session';

const USERS = parseUsers('frank:Frank,eda:Eda');
const [frank, eda] = USERS as [(typeof USERS)[number], (typeof USERS)[number]];

/** A fake localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('resolveUser', () => {
  it('?user= wins if it names a configured user', () => {
    expect(resolveUser(USERS, 'eda', null)).toBe(eda);
    expect(resolveUser(USERS, 'eda', 'frank')).toBe(eda);
    expect(resolveUser(USERS, 'frank', 'eda')).toBe(frank);
  });

  it('without ?user=, the last one used on this device', () => {
    expect(resolveUser(USERS, null, 'eda')).toBe(eda);
  });

  it('with nothing, the first one in the list', () => {
    expect(resolveUser(USERS, null, null)).toBe(frank);
  });

  it('an id that is not configured is ignored, wherever it comes from', () => {
    expect(resolveUser(USERS, 'pedro', null)).toBe(frank);
    expect(resolveUser(USERS, 'pedro', 'eda')).toBe(eda);
    expect(resolveUser(USERS, null, 'pedro')).toBe(frank);
    expect(resolveUser(USERS, 'pedro', 'juan')).toBe(frank);
    // The id is case-sensitive: 'Eda' is not 'eda'.
    expect(resolveUser(USERS, 'Eda', null)).toBe(frank);
  });

  it('with a single user it is always that one', () => {
    const [me] = parseUsers('');
    expect(resolveUser([me!], 'eda', 'frank')).toBe(me);
  });

  it('without users, null', () => {
    expect(resolveUser([], 'eda', 'eda')).toBeNull();
  });
});

describe('deviceMemory', () => {
  it('remembers the last user and the last language', () => {
    const storage = fakeStorage();
    const device = deviceMemory(storage);
    expect(device.user()).toBeNull();
    expect(device.language()).toBeNull();

    device.rememberUser('eda');
    device.rememberLanguage('tr');
    expect(device.user()).toBe('eda');
    expect(device.language()).toBe('tr');

    // Another visit, same device.
    const later = deviceMemory(storage);
    expect(later.user()).toBe('eda');
    expect(later.language()).toBe('tr');
    expect([...storage.data.keys()].sort()).toEqual(['fe-finance:language', 'fe-finance:user']);
  });

  it('stored values that are not valid are ignored', () => {
    const device = deviceMemory(fakeStorage({ 'fe-finance:language': 'fr', 'fe-finance:user': 'No Válido' }));
    expect(device.language()).toBeNull();
    expect(device.user()).toBeNull();
  });

  it('without storage it does not fail: it remembers nothing', () => {
    const device = deviceMemory(null);
    expect(() => device.rememberUser('eda')).not.toThrow();
    expect(() => device.rememberLanguage('es')).not.toThrow();
    expect(device.user()).toBeNull();
    expect(device.language()).toBeNull();
  });

  it('a storage that throws (private mode, quota full) does not break anything either', () => {
    const device = deviceMemory({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(() => device.rememberLanguage('es')).not.toThrow();
    expect(device.language()).toBeNull();
    expect(device.user()).toBeNull();
  });
});
