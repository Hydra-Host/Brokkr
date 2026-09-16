// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
vi.mock('@/lib/api', () => ({ tsr: { runPgQuery: { useMutation: () => ({ mutate, isPending: false }) } } }));

import { capabilityRefusalMessage } from '@/contract';
import { setHostToken } from '@/lib/lab-token';

import { SqlRunner } from './sql-runner';

const HOST_TOKEN_PROMPT = 'input[aria-label="host token"]';
const refusal = { status: 403, body: { error: capabilityRefusalMessage('host-exec') } };

beforeEach(() => {
  localStorage.clear();
  mutate.mockReset();
  setHostToken('wrong-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('SqlRunner on a host-exec refusal', () => {
  it('re-opens the host token prompt when the refusal arrives as a rejection', () => {
    mutate.mockImplementation((_body, handlers) => handlers.onError(refusal));

    render(<SqlRunner />);
    expect(document.querySelector(HOST_TOKEN_PROMPT)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(document.querySelector(HOST_TOKEN_PROMPT)).not.toBeNull();
  });

  it("keeps the server's own refusal text beside the re-opened prompt", () => {
    mutate.mockImplementation((_body, handlers) => handlers.onError(refusal));

    render(<SqlRunner />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(screen.getByText(capabilityRefusalMessage('host-exec'))).toBeTruthy();
    expect(document.querySelector(HOST_TOKEN_PROMPT)).not.toBeNull();
  });

  it('leaves the prompt closed for a refusal a second token cannot buy', () => {
    mutate.mockImplementation((_body, handlers) =>
      handlers.onError({ status: 400, body: { error: 'syntax error at or near "SELCT"' } }),
    );

    render(<SqlRunner />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(document.querySelector(HOST_TOKEN_PROMPT)).toBeNull();
    expect(screen.getByText('syntax error at or near "SELCT"')).toBeTruthy();
  });
});
