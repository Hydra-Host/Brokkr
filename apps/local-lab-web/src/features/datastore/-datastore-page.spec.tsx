// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/datastore/shared', () => ({
  useDatastoreSearch: () => ({ tab: 'queues' }),
  useSelectDatastoreTab: () => () => {},
}));
vi.mock('@/features/datastore/postgres', () => ({ PostgresTab: () => <div>postgres tab</div> }));
vi.mock('@/features/datastore/queues', () => ({ QueuesTab: () => <div>queues tab</div> }));
vi.mock('@/features/datastore/redis', () => ({ RedisTab: () => <div>redis tab</div> }));
vi.mock('@/features/datastore/thanos', () => ({ ThanosTab: () => <div>thanos tab</div> }));

import { DatastorePage } from './datastore-page';

afterEach(cleanup);

describe('DatastorePage', () => {
  it('renders the tab bar without a read-only badge', () => {
    render(<DatastorePage />);

    expect(screen.getByRole('button', { name: 'Queues' })).toBeDefined();
    expect(screen.getByText('queues tab')).toBeDefined();
    expect(screen.queryByText('read-only')).toBeNull();
  });
});
