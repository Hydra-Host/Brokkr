import { describe, expect, it } from 'vitest';

import { bodyError, errorMessage, isClientErrorResponse, thrownBodyError } from './errors';

describe('bodyError', () => {
  it('extracts a string error from a body', () => {
    expect(bodyError({ error: 'boom' })).toBe('boom');
  });

  it('returns undefined for a body without a string error', () => {
    expect(bodyError({ error: 42 })).toBeUndefined();
    expect(bodyError({ other: 'x' })).toBeUndefined();
    expect(bodyError(null)).toBeUndefined();
    expect(bodyError('nope')).toBeUndefined();
  });
});

describe('errorMessage', () => {
  it('returns null for a falsy value', () => {
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
  });

  it("returns an Error's message", () => {
    expect(errorMessage(new Error('network down'))).toBe('network down');
  });

  it('prefers the body error of a thrown response object', () => {
    expect(errorMessage({ status: 409, body: { error: 'stack busy' } })).toBe('stack busy');
  });

  it('falls back to the status when the body has no error', () => {
    expect(errorMessage({ status: 500, body: {} })).toBe('request failed (500)');
  });

  it('preserves an explicit empty-string body error rather than falling through to the status', () => {
    expect(errorMessage({ status: 500, body: { error: '' } })).toBe('');
  });

  it('stringifies anything else', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });
});

describe('isClientErrorResponse', () => {
  it('is true for a thrown response carrying a 4xx status', () => {
    expect(isClientErrorResponse({ status: 400, body: { error: 'bad' } })).toBe(true);
    expect(isClientErrorResponse({ status: 409, body: { error: 'stack busy' } })).toBe(true);
    expect(isClientErrorResponse({ status: 499, body: {} })).toBe(true);
  });

  it('is false for 2xx, 5xx, a network Error, and non-response values', () => {
    expect(isClientErrorResponse({ status: 200, body: {} })).toBe(false);
    expect(isClientErrorResponse({ status: 500, body: {} })).toBe(false);
    expect(isClientErrorResponse(new Error('offline'))).toBe(false);
    expect(isClientErrorResponse({ status: '404' })).toBe(false);
    expect(isClientErrorResponse({ body: { error: 'no status' } })).toBe(false);
    expect(isClientErrorResponse(null)).toBe(false);
    expect(isClientErrorResponse('404')).toBe(false);
  });
});

describe('thrownBodyError', () => {
  it('extracts the body error of a thrown response object', () => {
    expect(thrownBodyError({ status: 404, body: { error: 'not found' } })).toBe('not found');
  });

  it('returns undefined for a network Error or a body without a string error', () => {
    expect(thrownBodyError(new Error('offline'))).toBeUndefined();
    expect(thrownBodyError({ status: 500, body: {} })).toBeUndefined();
    expect(thrownBodyError(null)).toBeUndefined();
  });
});
