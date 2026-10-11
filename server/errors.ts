// Typed API error. Thrown by the repository (server/db.ts), validation and authentication;
// server/app.ts turns it into an HTTP response and the MCP server into a tool error.

import { ZodError } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '../shared/api';
import { label } from '../shared/month';
import type { MonthKey } from '../shared/types';

/** HTTP statuses the API responds with when something fails. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500;

/**
 * `message` is always in English and never carries internal details (SQL, stack traces, configuration values). The web
 * app does not show it as is: it translates by `code` and keeps the message as detail. Claude (ingest, MCP) does read it.
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

/** Write rule: a closed month is read-only. */
export function monthClosedError(key: MonthKey): ApiError {
  return new ApiError(409, 'month_closed', `${label(key)} is closed: it is read-only. Reopen it to make changes.`);
}

export function conflictError(message: string): ApiError {
  return new ApiError(409, 'conflict', message);
}

/**
 * A row names an account the user does not have (or one that belongs to someone else, which is the same thing).
 * It is invalid data in the request body: 400, not 404.
 */
export function unknownAccountError(id: string): ApiError {
  return validationError(`Unknown account "${id.slice(0, 64)}".`);
}

/** A row names a credit card the user does not have. Invalid data in the body: 400. */
export function unknownCardError(id: string): ApiError {
  return validationError(`Unknown credit card "${id.slice(0, 64)}".`);
}

/**
 * A money row (budget part, fixed expense, transaction, transfer, default account) names a gold account,
 * which holds grams and not money. Like an unknown account, it is invalid data: 400.
 */
export function goldAccountError(name: string): ApiError {
  return validationError(
    `"${name.slice(0, 64)}" is a gold account (grams): it cannot be used for budget parts, monthly expenses, transactions or transfers, or as the default account.`,
  );
}

/**
 * The user has no account to record in. This cannot be reached through the API (there is always at least one left:
 * deleting the last one is forbidden); it is the notice for whoever ended up without accounts some other way.
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

/** Prefix of every data validation message: "Invalid data: amount: must be greater than 0". */
export function invalidData(detail: string): string {
  return `Invalid data: ${detail}`;
}

const MAX_ISSUES = 5;

/** Summarizes the zod issues in one readable sentence: "Invalid data: amount: must be greater than 0; desc: cannot be empty". */
export function zodMessage(err: ZodError): string {
  const parts = err.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = err.issues.length - parts.length;
  return invalidData(`${parts.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}`);
}

/**
 * Any exception → ApiError. Whatever is not recognized becomes a 500 with a generic message:
 * the caller decides whether to log the original error (nothing from it leaks here).
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return validationError(zodMessage(err));
  return new ApiError(500, 'internal', INTERNAL_MESSAGE);
}
