import { describe, expect, it } from 'vitest';

import { filterLeavesByQuery } from '../filter-leaves';

const leaves = [
  { title: 'Servers', url: '/servers', sectionTitle: 'Rentals' },
  { title: 'Clusters', url: '/clusters', sectionTitle: 'Infrastructure' },
  { title: 'Docs', url: '/help/docs', sectionTitle: null },
];

describe('filterLeavesByQuery', () => {
  it('returns all leaves when the query is empty', () => {
    expect(filterLeavesByQuery(leaves, '')).toEqual(leaves);
  });

  it('matches title, section, and url case-insensitively', () => {
    expect(filterLeavesByQuery(leaves, 'SERV').map((leaf) => leaf.title)).toEqual(['Servers']);
    expect(filterLeavesByQuery(leaves, 'infra').map((leaf) => leaf.title)).toEqual(['Clusters']);
    expect(filterLeavesByQuery(leaves, '/help').map((leaf) => leaf.title)).toEqual(['Docs']);
  });
});
