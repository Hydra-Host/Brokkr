import { describe, expect, it } from 'vitest';

import { validateStackSearch } from './stack-search';

describe('validateStackSearch', () => {
  it('carries no selection when the url is bare', () => {
    expect(validateStackSearch({})).toEqual({ init: undefined });
  });

  it('keeps a colon-bearing init task name', () => {
    expect(validateStackSearch({ init: 'zone-crypto:mint-tokens' })).toEqual({ init: 'zone-crypto:mint-tokens' });
  });

  it('drops a wrong-typed or empty init param instead of throwing', () => {
    expect(validateStackSearch({ init: '' }).init).toBeUndefined();
    expect(validateStackSearch({ init: 7 }).init).toBeUndefined();
    expect(validateStackSearch({ init: null }).init).toBeUndefined();
    expect(validateStackSearch({ init: {} }).init).toBeUndefined();
  });

  it('ignores params the route does not own', () => {
    expect(validateStackSearch({ init: 'hub:migrate', bogus: 'x' })).toEqual({ init: 'hub:migrate' });
  });
});
