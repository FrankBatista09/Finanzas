// The Excel file is generated and read in the browser, as in the prototype. The generator and the reader are the same
// pure functions the API uses (shared/excel), but here they do not spend a Worker's CPU time
// (10 ms per request on the free plan: a workbook with many months does not fit).

import type { ImportPayload } from '../../shared/api';
import { buildExportData } from '../../shared/excel/data';
import { buildFinanzasXlsx, excelLocale, XLSX_MIME, xlsxFilename } from '../../shared/excel/export';
import { parseFinanzasXlsx } from '../../shared/excel/import';
import type { AppState, AppUser, MonthKey } from '../../shared/types';

/**
 * The workbook (one sheet per month, savings and configuration) ready to download, in the user's language.
 * `months`, if given, keeps only those month sheets. The data is computed from the whole history (balances, rates)
 * and filtered afterwards: removing a month from the workbook does not change the figures of the others.
 */
export function excelBlob(state: AppState, months?: readonly MonthKey[]): Blob {
  const data = buildExportData(state);
  if (months) data.months = data.months.filter((m) => months.includes(m.key));
  return new Blob([buildFinanzasXlsx(data, { locale: excelLocale(state.language) })], { type: XLSX_MIME });
}

/** Name of the file that user downloads. */
export function excelFilename(user: AppUser): string {
  return xlsxFilename(user.name);
}

/** Reads an .xlsx in the app's format. Throws ImportError if it cannot be read. */
export async function readExcel(file: Blob): Promise<ImportPayload> {
  return parseFinanzasXlsx(new Uint8Array(await file.arrayBuffer()));
}
