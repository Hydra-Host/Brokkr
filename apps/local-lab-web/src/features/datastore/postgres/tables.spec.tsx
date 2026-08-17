// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PgTable } from '@/contract';

import { TableGroup } from './tables';

const table = (schema: string, name: string): PgTable => ({ schema, name, estRows: 0 });

const SESSION = table('public', 'Session');
const ACCOUNT = table('public', 'Account');

afterEach(cleanup);

describe('TableGroup', () => {
  it('opens a collapsed group that holds the selected table', () => {
    render(
      <TableGroup
        title="Admin / Prisma"
        hint="system"
        tables={[SESSION, ACCOUNT]}
        selected={{ schema: 'public', name: 'Session' }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('Session')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('▾')).toBeDefined();
  });

  it('stays collapsed when the selection lives in another group', () => {
    render(
      <TableGroup
        title="Admin / Prisma"
        hint="system"
        tables={[SESSION, ACCOUNT]}
        selected={{ schema: 'public', name: 'Device' }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText('Session')).toBeNull();
    expect(screen.getByText('▸')).toBeDefined();
  });

  it('stays collapsed when nothing is selected', () => {
    render(<TableGroup title="No records" hint="empty" tables={[SESSION]} selected={null} onSelect={vi.fn()} />);
    expect(screen.queryByText('Session')).toBeNull();
    expect(screen.getByText('▸')).toBeDefined();
  });

  it('distinguishes a same-named table in another schema from the selection', () => {
    render(
      <TableGroup
        title="Admin / Prisma"
        hint="system"
        tables={[table('auth', 'Session')]}
        selected={{ schema: 'public', name: 'Session' }}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('▸')).toBeDefined();
  });

  it('honours defaultOpen with no selection', () => {
    render(
      <TableGroup title="Records" hint="rows > 0" tables={[SESSION]} selected={null} onSelect={vi.fn()} defaultOpen />,
    );
    expect(screen.getByText('Session')).toBeDefined();
  });
});
