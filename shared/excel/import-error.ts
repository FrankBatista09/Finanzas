/**
 * Why the file could not be imported. It is stable: the web app can translate the error by this code instead
 * of showing `message`, which is always in English (like the API's messages).
 *   not_xlsx        → not an .xlsx (not even a zip, or a zip that is not an Excel workbook)
 *   old_format      → legacy .xls or password-protected .xlsx
 *   too_large       → the uncompressed content exceeds the cap
 *   damaged         → the workbook is missing a sheet's part
 *   no_month_sheets → it is a workbook, but not in the app's format (no month sheets)
 *   unreadable      → any other failure while reading it
 */
export type ImportErrorCode = 'not_xlsx' | 'old_format' | 'too_large' | 'damaged' | 'no_month_sheets' | 'unreadable';

export interface ImportErrorOptions extends ErrorOptions {
  /** Defaults to 'unreadable'. */
  code?: ImportErrorCode;
}

/** The file is not a readable .xlsx or is not in the app's format (e.g. no month sheets). */
export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(message: string, options?: ImportErrorOptions) {
    super(message, options);
    this.name = 'ImportError';
    this.code = options?.code ?? 'unreadable';
  }
}
