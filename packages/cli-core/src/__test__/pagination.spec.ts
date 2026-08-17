import { describe, expect, it } from 'vitest';
import { buildQuery, paginationFooter } from '../index.js';

describe('buildQuery', () => {
  it('clamps page-size to 100 and defaults bad values', () => {
    expect(buildQuery({ page: '3', pageSize: '999', json: false })).toEqual({ page: 3, pageSize: 100 });
    expect(buildQuery({ page: 'x', pageSize: '0', json: false })).toEqual({ page: 1, pageSize: 20 });
  });

  it('passes through sort/search/filters and truncates search to 200', () => {
    const q = buildQuery({ page: '1', pageSize: '20', json: false, sort: 'name:asc', search: 'x'.repeat(250), filters: 'a:eq:b' });
    expect(q.sort).toBe('name:asc');
    expect(q.filters).toBe('a:eq:b');
    expect(q.search?.length).toBe(200);
  });
});

describe('paginationFooter', () => {
  it('returns total-only for single page and a next hint otherwise', () => {
    expect(paginationFooter({ page: 1, pageSize: 20, totalItems: 5, totalPages: 1 }, 'brokkr admin servers list')).toBe('5 total');
    expect(paginationFooter({ page: 1, pageSize: 20, totalItems: 40, totalPages: 2 }, 'brokkr admin servers list')).toContain('--page 2');
  });

  it('omits the next hint on the last page', () => {
    const footer = paginationFooter({ page: 2, pageSize: 20, totalItems: 40, totalPages: 2 }, 'brokkr admin servers list');
    expect(footer).toBe('Page 2/2 (40 total)');
    expect(footer).not.toContain('--page 3');
  });
});
