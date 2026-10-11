// Whose data is shown, and what this device remembers between visits (last user and language).
// Local storage is only a convenience: if it does not exist or fails (private mode, quota), everything keeps working.

import { isLanguage } from '../../shared/i18n';
import type { AppUser, Language } from '../../shared/types';
import { isUserId } from '../../shared/users';

/**
 * Current user: the one in ?user= if it is one of the configured users; otherwise, the last one used on this device;
 * failing that, the first one in the list. null only if the list is empty.
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
    // With storage blocked, accessing `localStorage` itself throws.
    return null;
  }
}

/** What the device remembers. `store` is only passed in tests. */
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
      // No room or no permission: the next visit will start with the default values.
    }
  };
  return {
    /** Last user chosen here; null if there is none or the stored value is not shaped like an id. */
    user(): string | null {
      const id = read(USER_KEY);
      return isUserId(id) ? id : null;
    },
    rememberUser: (id: string) => write(USER_KEY, id),
    /** Last language used here: the one for the loading screen, before the user's language is known. */
    language(): Language | null {
      const lang = read(LANGUAGE_KEY);
      return isLanguage(lang) ? lang : null;
    },
    rememberLanguage: (lang: Language) => write(LANGUAGE_KEY, lang),
  };
}

export type DeviceMemory = ReturnType<typeof deviceMemory>;
