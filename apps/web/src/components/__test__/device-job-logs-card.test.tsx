import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceJobLogsCard } from '../device-job-logs-card';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeviceJobLogsCard deviceId="dev-1" displayName="node-1" onSelectJob={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('DeviceJobLogsCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the access-denied state when the api responds 403', async () => {
    const fetchMock = stubFetch(() => jsonResponse(403, { message: 'Forbidden' }));
    renderCard();
    expect(await screen.findByText('You do not have access to job logs.')).toBeInTheDocument();
    expect(screen.queryByText('No jobs recorded for this device.')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load jobs.')).not.toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/devices/dev-1/jobs');
  });

  it('renders the generic error state on non-403 failures', async () => {
    stubFetch(() => jsonResponse(500, { message: 'boom' }));
    renderCard();
    expect(await screen.findByText('Failed to load jobs.')).toBeInTheDocument();
    expect(screen.queryByText('You do not have access to job logs.')).not.toBeInTheDocument();
  });

  it('renders the empty state when the device has no jobs', async () => {
    stubFetch(() => jsonResponse(200, { jobs: [] }));
    renderCard();
    expect(await screen.findByText('No jobs recorded for this device.')).toBeInTheDocument();
  });

  it('renders the newest job and its log viewer on success', async () => {
    stubFetch((url) =>
      url.includes('/job-logs/')
        ? jsonResponse(200, { entries: [], nextCursor: null })
        : jsonResponse(200, {
            jobs: [
              {
                id: 'job-old',
                jobType: 'Reboot',
                status: 'Completed',
                createdAt: '2026-08-01T10:00:00.000Z',
                error: null,
              },
              {
                id: 'job-new',
                jobType: 'Provision',
                status: 'RUNNING',
                createdAt: '2026-08-02T10:00:00.000Z',
                error: null,
              },
            ],
          }),
    );
    renderCard();
    expect(await screen.findByText(/Provision/)).toBeInTheDocument();
    expect(await screen.findByText('No log entries for this job.')).toBeInTheDocument();
  });
});
