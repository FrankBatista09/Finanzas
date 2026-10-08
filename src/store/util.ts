import type { ApiErrorCode } from '../../shared/api';
import { APP_NAME } from '../../shared/constants';
import { ImportError } from '../../shared/excel/import-error';
import type { ImportErrorCode } from '../../shared/excel/import-error';
import { ApiError, NetworkError } from '../api/client';
import type { CoreKey, CoreTranslator } from '../i18n';

/** Id para una fila nueva; viaja en el POST, así la fila optimista y la del servidor son la misma. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID solo existe en contextos seguros; probando desde el móvil por http://192.168… no lo es.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** La frase de cada código de error de la API. Record: un código nuevo en el contrato no compila hasta tener la suya. */
const ERROR_KEYS: Record<ApiErrorCode, CoreKey> = {
  validation: 'errorValidation',
  not_found: 'errorNotFound',
  month_closed: 'errorMonthClosed',
  conflict: 'errorConflict',
  unauthorized: 'errorUnauthorized',
  forbidden: 'errorForbidden',
  internal: 'errorInternal',
};

/** La frase de cada motivo por el que el lector de Excel no pudo con un archivo (su mensaje va siempre en inglés). */
const IMPORT_KEYS: Record<ImportErrorCode, CoreKey> = {
  not_xlsx: 'importNotXlsx',
  old_format: 'importOldFormat',
  too_large: 'importTooLarge',
  damaged: 'importDamaged',
  no_month_sheets: 'importNoMonthSheets',
  unreadable: 'importUnreadable',
};

/**
 * Frase para el usuario, en su idioma. Los errores de la API se traducen por su código; el mensaje del servidor
 * (en inglés) solo se añade como detalle en los de validación, donde dice qué dato estaba mal.
 * Los del lector de Excel (el archivo se lee en el navegador) se traducen igual, por su código.
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

/** Descarga un Blob con ese nombre de archivo (enlace temporal, como en el prototipo). */
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
