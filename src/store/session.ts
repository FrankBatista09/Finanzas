// De quién son los datos que se ven, y lo que este dispositivo recuerda entre visitas (último usuario e idioma).
// El almacenamiento local es solo una comodidad: si no existe o falla (modo privado, cuota), todo sigue funcionando.

import { isLanguage } from '../../shared/i18n';
import type { AppUser, Language } from '../../shared/types';
import { isUserId } from '../../shared/users';

/**
 * Usuario actual: el de ?user= si es uno de los configurados; si no, el último usado en este dispositivo;
 * si tampoco, el primero de la lista. null solo si la lista viene vacía.
 */
export function resolveUser(users: readonly AppUser[], fromUrl: string | null, remembered: string | null): AppUser | null {
  return users.find((u) => u.id === fromUrl) ?? users.find((u) => u.id === remembered) ?? users[0] ?? null;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const USER_KEY = 'fe-finance:user';
const LANGUAGE_KEY = 'fe-finance:language';

function localStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Con el almacenamiento bloqueado, el propio acceso a `localStorage` lanza.
    return null;
  }
}

/** Lo que recuerda el dispositivo. `store` solo se pasa en las pruebas. */
export function deviceMemory(store: Store | null = localStore()) {
  const read = (key: string): string | null => {
    try {
      return store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      store?.setItem(key, value);
    } catch {
      // Sin sitio o sin permiso: la próxima visita empezará con los valores por defecto.
    }
  };
  return {
    /** Último usuario elegido aquí; null si no hay o lo guardado no tiene forma de id. */
    user(): string | null {
      const id = read(USER_KEY);
      return isUserId(id) ? id : null;
    },
    rememberUser: (id: string) => write(USER_KEY, id),
    /** Último idioma usado aquí: el de la pantalla de carga, antes de saber el del usuario. */
    language(): Language | null {
      const lang = read(LANGUAGE_KEY);
      return isLanguage(lang) ? lang : null;
    },
    rememberLanguage: (lang: Language) => write(LANGUAGE_KEY, lang),
  };
}

export type DeviceMemory = ReturnType<typeof deviceMemory>;
