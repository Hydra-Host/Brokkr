import { isRecord } from '@repo/utils';

export const httpStatusOf = (error: unknown): number | undefined =>
  isRecord(error) && typeof error.status === 'number' ? error.status : undefined;

export const isForbiddenError = (error: unknown): boolean => httpStatusOf(error) === 403;

export const isNotFoundError = (error: unknown): boolean => httpStatusOf(error) === 404;
