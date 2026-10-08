import { describe, expect, it } from 'vitest';
import { parseUsers } from '../../shared/users';
import { deviceMemory, resolveUser } from './session';

const USERS = parseUsers('frank:Frank,eda:Eda');
const [frank, eda] = USERS as [(typeof USERS)[number], (typeof USERS)[number]];

/** Un localStorage de mentira. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('resolveUser', () => {
  it('manda ?user= si nombra a un usuario configurado', () => {
    expect(resolveUser(USERS, 'eda', null)).toBe(eda);
    expect(resolveUser(USERS, 'eda', 'frank')).toBe(eda);
    expect(resolveUser(USERS, 'frank', 'eda')).toBe(frank);
  });

  it('sin ?user=, el último usado en este dispositivo', () => {
    expect(resolveUser(USERS, null, 'eda')).toBe(eda);
  });

  it('sin nada, el primero de la lista', () => {
    expect(resolveUser(USERS, null, null)).toBe(frank);
  });

  it('un id que no está configurado se ignora, venga de donde venga', () => {
    expect(resolveUser(USERS, 'pedro', null)).toBe(frank);
    expect(resolveUser(USERS, 'pedro', 'eda')).toBe(eda);
    expect(resolveUser(USERS, null, 'pedro')).toBe(frank);
    expect(resolveUser(USERS, 'pedro', 'juan')).toBe(frank);
    // El id distingue mayúsculas: 'Eda' no es 'eda'.
    expect(resolveUser(USERS, 'Eda', null)).toBe(frank);
  });

  it('con un solo usuario es siempre ese', () => {
    const [me] = parseUsers('');
    expect(resolveUser([me!], 'eda', 'frank')).toBe(me);
  });

  it('sin usuarios, null', () => {
    expect(resolveUser([], 'eda', 'eda')).toBeNull();
  });
});

describe('deviceMemory', () => {
  it('recuerda el último usuario y el último idioma', () => {
    const storage = fakeStorage();
    const device = deviceMemory(storage);
    expect(device.user()).toBeNull();
    expect(device.language()).toBeNull();

    device.rememberUser('eda');
    device.rememberLanguage('tr');
    expect(device.user()).toBe('eda');
    expect(device.language()).toBe('tr');

    // Otra visita, mismo dispositivo.
    const later = deviceMemory(storage);
    expect(later.user()).toBe('eda');
    expect(later.language()).toBe('tr');
    expect([...storage.data.keys()].sort()).toEqual(['fe-finance:language', 'fe-finance:user']);
  });

  it('lo guardado que no vale se ignora', () => {
    const device = deviceMemory(fakeStorage({ 'fe-finance:language': 'fr', 'fe-finance:user': 'No Válido' }));
    expect(device.language()).toBeNull();
    expect(device.user()).toBeNull();
  });

  it('sin almacenamiento no falla: simplemente no recuerda', () => {
    const device = deviceMemory(null);
    expect(() => device.rememberUser('eda')).not.toThrow();
    expect(() => device.rememberLanguage('es')).not.toThrow();
    expect(device.user()).toBeNull();
    expect(device.language()).toBeNull();
  });

  it('un almacenamiento que lanza (modo privado, cuota llena) tampoco rompe nada', () => {
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
