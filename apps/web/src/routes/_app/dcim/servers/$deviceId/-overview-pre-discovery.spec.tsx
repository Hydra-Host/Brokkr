// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Server } from '@repo/api-client';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => () => ({}),
  getRouteApi: () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { ComputeCardBody, isDiscovered } from './index';

const specs = (over: Partial<Server['specs']> = {}): Server['specs'] => ({
  cpu: { model: null },
  gpu: { model: null },
  memory: { total: null },
  storage: {},
  ...over,
});

afterEach(cleanup);

describe('ComputeCardBody', () => {
  it('renders the pre-discovery state and no cpu header when nothing has been reported', () => {
    render(<ComputeCardBody specs={specs()} deviceId="dev-1" />);

    expect(isDiscovered(specs())).toBe(false);
    expect(screen.getByText(/Hardware not discovered yet/)).toBeInTheDocument();
    expect(screen.getByText(/Start discovery with Collect in the header/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Discovery runs' })).toHaveAttribute(
      'href',
      '/dcim/servers/$deviceId/discovery-runs',
    );
    expect(screen.queryByText('CPU')).toBeNull();
  });

  it('renders the cpu header and no pre-discovery text once a cpu model is known', () => {
    const discovered = specs({ cpu: { model: 'EPYC' } });
    render(<ComputeCardBody specs={discovered} deviceId="dev-1" />);

    expect(isDiscovered(discovered)).toBe(true);
    expect(screen.getByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('EPYC')).toBeInTheDocument();
    expect(screen.queryByText(/Hardware not discovered yet/)).toBeNull();
  });
  it('renders no separator when only memory is known', () => {
    const { container } = render(<ComputeCardBody specs={specs({ memory: { total: 64 } })} deviceId="dev-1" />);

    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-orientation="horizontal"]')).toHaveLength(0);
  });

  it('separates only the sections that are present', () => {
    const { container } = render(
      <ComputeCardBody specs={specs({ gpu: { model: 'H100' }, memory: { total: 64 } })} deviceId="dev-1" />,
    );

    expect(container.querySelectorAll('[data-orientation="horizontal"]')).toHaveLength(1);
  });
});
