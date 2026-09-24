import { describe, expect, it } from 'vitest';

import { httpStatusOf, isForbiddenError, isNotFoundError } from '../api-errors';

describe('api-errors', () => {
  it('reads the status from a ts-rest error', () => {
    expect(httpStatusOf({ status: 403, body: {} })).toBe(403);
    expect(httpStatusOf(new Error('x'))).toBeUndefined();
  });

  it('recognizes 403', () => {
    expect(isForbiddenError({ status: 403 })).toBe(true);
    expect(isForbiddenError({ status: 404 })).toBe(false);
  });

  it('recognizes 404', () => {
    expect(isNotFoundError({ status: 404 })).toBe(true);
    expect(isNotFoundError(null)).toBe(false);
  });
});
