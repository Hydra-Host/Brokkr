import { describe, expect, it } from 'vitest';
import { ensureError, getErrorMessage, isError, unwrapErrorMessage } from '../error';

describe('isError', () => {
  it('returns true for Error instances and subclasses', () => {
    expect(isError(new Error('boom'))).toBe(true);
    expect(isError(new TypeError('bad'))).toBe(true);
  });

  it('returns false for non-error values', () => {
    expect(isError('boom')).toBe(false);
    expect(isError({ message: 'boom' })).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the outer message from an Error with a nested cause', () => {
    expect(getErrorMessage(new Error('outer', { cause: new Error('inner') }))).toBe('outer');
  });

  it('returns a string error as-is', () => {
    expect(getErrorMessage('raw failure')).toBe('raw failure');
  });

  it('returns the message from an object with a string message', () => {
    expect(getErrorMessage({ message: 'object failure' })).toBe('object failure');
  });

  it('falls back for values without a usable message', () => {
    expect(getErrorMessage({ message: 42 })).toBe('An unknown error occurred');
    expect(getErrorMessage(null)).toBe('An unknown error occurred');
    expect(getErrorMessage(undefined)).toBe('An unknown error occurred');
    expect(getErrorMessage(7)).toBe('An unknown error occurred');
  });
});

describe('ensureError', () => {
  it('returns the same Error instance unchanged', () => {
    const error = new Error('boom', { cause: new Error('inner') });
    expect(ensureError(error)).toBe(error);
  });

  it('wraps a string in an Error', () => {
    const error = ensureError('raw failure');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('raw failure');
  });

  it('wraps an object and preserves it as the cause', () => {
    const cause = { message: 'object failure', code: 'ECONNREFUSED' };
    const error = ensureError(cause);

    expect(error.message).toBe('object failure');
    expect(error.cause).toBe(cause);
  });

  it('wraps unusable values in a fallback Error', () => {
    expect(ensureError(null).message).toBe('An unknown error occurred');
    expect(ensureError({ message: 42 }).message).toBe('An unknown error occurred');
  });
});

describe('unwrapErrorMessage', () => {
  it('extracts the message from a ts-rest error envelope ({ body: { message } })', () => {
    expect(unwrapErrorMessage({ status: 500, body: { message: 'Server exploded' } })).toBe('Server exploded');
  });

  it('extracts the message from a plain Error instance', () => {
    expect(unwrapErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('extracts a top-level error string ({ error })', () => {
    expect(unwrapErrorMessage({ error: 'not allowed' })).toBe('not allowed');
  });

  it('extracts the message from an axios-style envelope ({ response: { data: { message } } })', () => {
    expect(unwrapErrorMessage({ response: { data: { message: 'nested failure' } } })).toBe('nested failure');
  });

  it('prefers body.message over top-level message, error, and response.data.message', () => {
    const error = {
      body: { message: 'from body' },
      message: 'from message',
      error: 'from error',
      response: { data: { message: 'from response' } },
    };
    expect(unwrapErrorMessage(error)).toBe('from body');
  });

  it('falls through an empty-string candidate to the next shape', () => {
    expect(unwrapErrorMessage({ body: { message: '' }, message: 'fallback message' })).toBe('fallback message');
  });

  it('skips non-string message values', () => {
    expect(unwrapErrorMessage({ message: 42 }, 'default')).toBe('default');
  });

  it('returns the default for a bare string (strings are not unwrapped)', () => {
    expect(unwrapErrorMessage('raw string error', 'default')).toBe('default');
  });

  it('returns the default for an object without any message-bearing field', () => {
    expect(unwrapErrorMessage({ status: 404 }, 'Thing not found')).toBe('Thing not found');
  });

  it('returns the default for null and undefined', () => {
    expect(unwrapErrorMessage(null, 'custom default')).toBe('custom default');
    expect(unwrapErrorMessage(undefined, 'custom default')).toBe('custom default');
  });

  it('falls back to the built-in message when no default is provided', () => {
    expect(unwrapErrorMessage(null)).toBe('An unknown error occurred');
    expect(unwrapErrorMessage({})).toBe('An unknown error occurred');
  });

  it('ignores a body that is not an object (JSON-ish string body)', () => {
    expect(unwrapErrorMessage({ body: '{"message":"still json"}' }, 'default')).toBe('default');
  });
});
