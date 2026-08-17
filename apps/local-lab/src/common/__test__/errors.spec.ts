import { getErrorMessage } from '../errors';

describe('getErrorMessage', () => {
  it('returns the message of an Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns a string value as-is', () => {
    expect(getErrorMessage('plain failure')).toBe('plain failure');
  });

  it('reads .message off a non-Error object with a string message', () => {
    expect(getErrorMessage({ message: 'object failure' })).toBe('object failure');
  });

  it('falls back for undefined, null and other unknown shapes', () => {
    expect(getErrorMessage(undefined)).toBe('An unknown error occurred');
    expect(getErrorMessage(null)).toBe('An unknown error occurred'); // throw null is legal JS
    expect(getErrorMessage({ code: 42 })).toBe('An unknown error occurred');
  });
});
