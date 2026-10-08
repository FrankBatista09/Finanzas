// Error tipado de la API. Lo lanzan el repositorio (server/db.ts), la validación y la autenticación;
// server/app.ts lo traduce a una respuesta HTTP y el servidor MCP a un error de herramienta.

import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../shared/api';
import { label } from '../shared/month';
import type { MonthKey } from '../shared/types';

/** Estados HTTP con los que responde la API cuando algo falla. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500;

/**
 * `message` va siempre en inglés y nunca lleva detalles internos (SQL, trazas, valores de configuración).
 * La web no lo muestra tal cual: traduce por `code` y deja el mensaje como detalle. Claude (ingest, MCP) sí lo lee.
 */
export class ApiError extends Error {
  readonly status: ApiErrorStatus;
  readonly code: ApiErrorCode;

  constructor(status: ApiErrorStatus, code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const INTERNAL_MESSAGE = 'Internal server error.';

export function validationError(message: string): ApiError {
  return new ApiError(400, 'validation', message);
}

export function unauthorizedError(message = 'Unauthorized.'): ApiError {
  return new ApiError(401, 'unauthorized', message);
}

export function forbiddenError(message = 'Access denied.'): ApiError {
  return new ApiError(403, 'forbidden', message);
}

export function notFoundError(message: string): ApiError {
  return new ApiError(404, 'not_found', message);
}

export function monthNotFoundError(key: MonthKey): ApiError {
  return notFoundError(`Month ${key} does not exist.`);
}

/** Regla de escritura: un mes cerrado es de solo lectura. */
export function monthClosedError(key: MonthKey): ApiError {
  return new ApiError(409, 'month_closed', `${label(key)} is closed: it is read-only. Reopen it to make changes.`);
}

export function conflictError(message: string): ApiError {
  return new ApiError(409, 'conflict', message);
}

/**
 * Una fila nombra una cuenta que el usuario no tiene (o que es de otro, que es lo mismo). Es un dato inválido
 * del cuerpo de la petición: 400, no 404.
 */
export function unknownAccountError(id: string): ApiError {
  return validationError(`Unknown account "${id.slice(0, 64)}".`);
}

/**
 * El usuario no tiene ninguna cuenta en la que registrar. Por la API no se llega aquí (siempre queda al menos
 * una: borrar la última está prohibido); es el aviso para quien se quedó sin cuentas por otro camino.
 */
export function noAccountsError(): ApiError {
  return conflictError('There are no accounts yet: add one first.');
}

export function tooLargeError(message: string): ApiError {
  return new ApiError(413, 'validation', message);
}

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** Prefijo de todo mensaje de validación de datos: "Invalid data: amount: must be greater than 0". */
export function invalidData(detail: string): string {
  return `Invalid data: ${detail}`;
}

const MAX_ISSUES = 5;

/** Resume los problemas de zod en una frase legible: "Invalid data: amount: must be greater than 0; desc: cannot be empty". */
export function zodMessage(err: ZodError): string {
  const parts = err.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = err.issues.length - parts.length;
  return invalidData(`${parts.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}`);
}

/**
 * Cualquier excepción → ApiError. Lo que no se reconoce pasa a 500 con un mensaje genérico:
 * quien llama decide si registra el error original (aquí no se filtra nada de él).
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return validationError(zodMessage(err));
  return new ApiError(500, 'internal', INTERNAL_MESSAGE);
}
