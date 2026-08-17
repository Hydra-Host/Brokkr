import { isRecord } from './type-guards';

export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return 'An unknown error occurred';
}

export function ensureError(error: unknown): Error {
  if (isError(error)) {
    return error;
  }

  const message = getErrorMessage(error);
  if (typeof error === 'string') {
    return new Error(message);
  }

  const normalizedError = new Error(message);
  Object.defineProperty(normalizedError, 'cause', {
    configurable: true,
    value: error,
    writable: true,
  });
  return normalizedError;
}

export const unwrapErrorMessage = (error: unknown, defaultMessage?: string): string => {
  const pick = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  const record = isRecord(error) ? error : undefined;
  const body = record && isRecord(record.body) ? record.body : undefined;
  const response = record && isRecord(record.response) ? record.response : undefined;
  const responseData = response && isRecord(response.data) ? response.data : undefined;
  return (
    pick(body?.message) ??
    pick(record?.message) ??
    pick(record?.error) ??
    pick(responseData?.message) ??
    defaultMessage ??
    'An unknown error occurred'
  );
};
