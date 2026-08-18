import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../html';

describe('escapeHtml', () => {
  it('escapes each special character', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('replaces ampersand before other entities', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
