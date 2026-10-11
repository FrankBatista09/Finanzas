import type { ApiErrorCode } from '../../shared/api';
import { APP_NAME } from '../../shared/constants';
import { ImportError } from '../../shared/excel/import-error';
import type { ImportErrorCode } from '../../shared/excel/import-error';
import { ApiError, NetworkError } from '../api/client';
import type { CoreKey, CoreTranslator } from '../i18n';

/** Id for a new row; it travels in the POST, so the optimistic row and the server's row are the same one. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID only exists in secure contexts; testing from a phone over http://192.168… is not one.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The phrase for each API error code. Record: a new code in the contract does not compile until it has its own. */
const ERROR_KEYS: Record<ApiErrorCode, CoreKey> = {
  validation: 'errorValidation',
  not_found: 'errorNotFound',
  month_closed: 'errorMonthClosed',
  conflict: 'errorConflict',
  unauthorized: 'errorUnauthorized',
  forbidden: 'errorForbidden',
  internal: 'errorInternal',
};

/** The phrase for each reason the Excel reader could not handle a file (its message is always in English). */
const IMPORT_KEYS: Record<ImportErrorCode, CoreKey> = {
  not_xlsx: 'importNotXlsx',
  old_format: 'importOldFormat',
  too_large: 'importTooLarge',
  damaged: 'importDamaged',
  no_month_sheets: 'importNoMonthSheets',
  unreadable: 'importUnreadable',
};

/**
 * Phrase for the user, in their language. API errors are translated by their code; the server's message
 * (in English) is only added as a detail on validation errors, where it says which value was wrong.
 * Those from the Excel reader (the file is read in the browser) are translated the same way, by their code.
 */
export function describeError(e: unknown, t: CoreTranslator): string {
  if (e instanceof NetworkError) return t('errorNetwork');
  if (e instanceof ApiError) {
    if (e.code === 'validation' && e.message) return t('errorValidationDetail', { detail: e.message });
    return t(ERROR_KEYS[e.code] ?? 'errorUnexpected');
  }
  if (e instanceof ImportError) return t(IMPORT_KEYS[e.code] ?? 'importUnreadable', { app: APP_NAME });
  return t('errorUnexpected');
}

/** Downloads a Blob with that file name (temporary link, as in the prototype). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
