// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { blocker } = vi.hoisted(() => ({
  blocker: { status: 'idle' as string, proceed: () => {}, reset: () => {} },
}));

vi.mock('@tanstack/react-router', () => ({ useBlocker: () => blocker }));

import { UnsavedNavGate } from './unsaved-nav-gate';

afterEach(cleanup);

describe('UnsavedNavGate', () => {
  beforeEach(() => {
    blocker.status = 'idle';
  });

  it('renders nothing while the router is not blocking', () => {
    const { container } = render(<UnsavedNavGate dirty what="stack config" />);

    expect(container.textContent).toBe('');
  });

  it('names which edits are dropped so the prompt is not generic', () => {
    blocker.status = 'blocked';
    render(<UnsavedNavGate dirty what="zone" />);

    expect(screen.getByText(/unsaved zone edits are dropped/)).toBeTruthy();
  });
});
