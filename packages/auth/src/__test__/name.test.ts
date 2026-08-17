import { APIError } from 'better-auth/api';

import { deriveUserName } from '../name';

describe('deriveUserName', () => {
  it('preserves explicitly provided firstName/lastName over name-splitting', () => {
    expect(deriveUserName({ name: 'Mary Jane Doe', firstName: 'Mary Jane', lastName: 'Doe' })).toEqual({
      firstName: 'Mary Jane',
      lastName: 'Doe',
    });
  });

  it('uses an explicit value for one part and derives the other from name', () => {
    expect(deriveUserName({ name: 'Ada Lovelace', firstName: 'Augusta Ada' })).toEqual({
      firstName: 'Augusta Ada',
      lastName: 'Lovelace',
    });
  });

  it('handles a single-token name by reusing it for both parts', () => {
    expect(deriveUserName({ name: 'Madonna' })).toEqual({
      firstName: 'Madonna',
      lastName: 'Madonna',
    });
  });

  it('uses the name token (not the explicit firstName) as lastName fallback for single-token name', () => {
    expect(deriveUserName({ name: 'Prince', firstName: 'The Artist' })).toEqual({
      firstName: 'The Artist',
      lastName: 'Prince',
    });
  });

  it('joins remaining tokens into lastName for a multi-token name', () => {
    expect(deriveUserName({ name: 'John Ronald Reuel Tolkien' })).toEqual({
      firstName: 'John',
      lastName: 'Ronald Reuel Tolkien',
    });
  });

  it('collapses extra/surrounding whitespace when splitting name', () => {
    expect(deriveUserName({ name: '  Grace   Hopper  ' })).toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
    });
  });

  it('throws a BAD_REQUEST APIError when no name can be determined', () => {
    expect(() => deriveUserName({ name: '   ' })).toThrow(APIError);
    expect(() => deriveUserName({})).toThrow(APIError);
  });
});
