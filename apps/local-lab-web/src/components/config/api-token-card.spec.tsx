// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/lib/toast';

import { ApiTokenCard } from './api-token-card';

function hostInput(): HTMLInputElement {
  const el = document.querySelector('input[aria-label="Host token"]');
  if (!(el instanceof HTMLInputElement)) throw new Error('host token input missing');
  return el;
}

function saveButtons(): HTMLButtonElement[] {
  return screen.getAllByRole('button', { name: 'Save' }) as HTMLButtonElement[];
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_LAB_API_TOKEN', '');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('ApiTokenCard save button', () => {
  it('starts disabled while nothing is typed', () => {
    render(
      <ToastProvider>
        <ApiTokenCard />
      </ToastProvider>,
    );
    expect(saveButtons().every((b) => b.disabled)).toBe(true);
  });

  it('enables on an edit and disables again once the token is saved', () => {
    render(
      <ToastProvider>
        <ApiTokenCard />
      </ToastProvider>,
    );
    const input = hostInput();

    fireEvent.change(input, { target: { value: 'host-secret' } });
    const enabled = saveButtons().filter((b) => !b.disabled);
    expect(enabled).toHaveLength(1);

    fireEvent.click(enabled[0]!);

    expect(saveButtons().every((b) => b.disabled)).toBe(true);
    expect(hostInput().value).toBe('host-secret');
  });

  it('re-enables when the operator edits again after a save', () => {
    render(
      <ToastProvider>
        <ApiTokenCard />
      </ToastProvider>,
    );
    fireEvent.change(hostInput(), { target: { value: 'host-secret' } });
    fireEvent.click(saveButtons().filter((b) => !b.disabled)[0]!);

    fireEvent.change(hostInput(), { target: { value: 'host-secret-2' } });

    expect(saveButtons().filter((b) => !b.disabled)).toHaveLength(1);
  });
});
