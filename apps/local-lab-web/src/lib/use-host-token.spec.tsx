// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { capabilityRefusalMessage } from '@/contract';

import { hostToken } from './lab-token';
import { isHostExecRefusal, isThrownHostExecRefusal, useHostToken } from './use-host-token';

const refusalBody = { error: capabilityRefusalMessage('host-exec') };

const calls: { blocked: boolean; token: string }[] = [];

function Harness() {
  const gate = useHostToken('The SQL console');
  calls.push({ blocked: gate.blocked, token: gate.token });
  return (
    <div>
      <button onClick={() => gate.ask()}>ask</button>
      <button onClick={() => gate.noteRefusal(403, refusalBody)}>refuse</button>
      <button onClick={() => gate.noteThrownRefusal({ status: 403, body: refusalBody })}>throw-refuse</button>
      <button onClick={() => gate.noteThrownRefusal(new Error('network down'))}>throw-other</button>
      <button onClick={() => gate.noteRefusal(500, { error: 'boom' })}>other</button>
      <span data-testid="token">{gate.token}</span>
      <span data-testid="blocked">{String(gate.blocked)}</span>
      {gate.dialog}
    </div>
  );
}

function Peer() {
  const gate = useHostToken('Caching a sudo password');
  return (
    <div>
      <span data-testid="peer-blocked">{String(gate.blocked)}</span>
      {gate.dialog}
    </div>
  );
}

const latest = () => calls[calls.length - 1];
const promptShown = () => screen.queryByLabelText('host token') !== null;

function type(value: string) {
  fireEvent.change(screen.getByLabelText('host token'), { target: { value } });
  fireEvent.click(screen.getByText('Use token'));
}

describe('isHostExecRefusal', () => {
  it('is true only for the capability refusal the lab renders', () => {
    expect(isHostExecRefusal(403, refusalBody)).toBe(true);
  });

  it('is false for a 403 a second token cannot buy', () => {
    expect(isHostExecRefusal(403, { error: capabilityRefusalMessage('admin') })).toBe(false);
  });

  it('is false for any other status carrying the same words', () => {
    expect(isHostExecRefusal(500, refusalBody)).toBe(false);
    expect(isHostExecRefusal(401, refusalBody)).toBe(false);
  });

  it('is false for a body with no error field', () => {
    expect(isHostExecRefusal(403, null)).toBe(false);
    expect(isHostExecRefusal(403, { message: capabilityRefusalMessage('host-exec') })).toBe(false);
  });
});

describe('useHostToken', () => {
  beforeEach(() => {
    calls.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('prompts on first use when the stack served a token that cannot reach host-exec', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    expect(promptShown()).toBe(true);
    expect(latest().blocked).toBe(true);
  });

  it('does not prompt on loopback, where nothing is injected and the address grants', () => {
    render(<Harness />);
    expect(promptShown()).toBe(false);
    expect(latest().blocked).toBe(false);
  });

  it('stores what was typed under the host key and stops blocking', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    type('  host-sekret  ');
    expect(hostToken()).toBe('host-sekret');
    expect(latest().token).toBe('host-sekret');
    expect(latest().blocked).toBe(false);
    expect(promptShown()).toBe(false);
  });

  it('offers the typed token, never the injected one, once one is typed', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    expect(latest().token).toBe('injected');
    type('host-sekret');
    expect(latest().token).toBe('host-sekret');
  });

  it('reopens the prompt on a capability refusal from the server', () => {
    render(<Harness />);
    expect(promptShown()).toBe(false);
    fireEvent.click(screen.getByText('refuse'));
    expect(promptShown()).toBe(true);
  });

  it('leaves the prompt closed for a failure a token cannot fix', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('other'));
    expect(promptShown()).toBe(false);
  });

  it('opens on demand when a surface asks before calling', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('ask'));
    expect(promptShown()).toBe(true);
  });

  it('closes without storing anything when dismissed', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(promptShown()).toBe(false);
    expect(hostToken()).toBe('');
  });

  it('refuses to submit a blank token', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('host token'), { target: { value: '   ' } });
    expect(screen.getByText('Use token').hasAttribute('disabled')).toBe(true);
  });

  it('keeps the stored token when Enter is pressed on a blank input', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    type('kept-token');
    fireEvent.click(screen.getByText('ask'));

    fireEvent.change(screen.getByLabelText('host token'), { target: { value: '  ' } });
    fireEvent.keyDown(screen.getByLabelText('host token'), { key: 'Enter' });

    expect(hostToken()).toBe('kept-token');
  });

  it('closes every open prompt on the page once one of them is answered', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(
      <div>
        <Harness />
        <Peer />
      </div>,
    );
    expect(screen.getAllByLabelText('host token')).toHaveLength(2);

    fireEvent.change(screen.getAllByLabelText('host token')[0]!, { target: { value: 'shared-token' } });
    fireEvent.click(screen.getAllByText('Use token')[0]!);

    expect(screen.queryAllByLabelText('host token')).toHaveLength(0);
  });

  it('unblocks a second gate on the page once either one is given a token', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(
      <div>
        <Harness />
        <Peer />
      </div>,
    );
    expect(screen.getByTestId('peer-blocked').textContent).toBe('true');

    fireEvent.change(screen.getAllByLabelText('host token')[0]!, { target: { value: 'shared-token' } });
    fireEvent.click(screen.getAllByText('Use token')[0]!);

    expect(screen.getByTestId('peer-blocked').textContent).toBe('false');
  });
});

describe('isThrownHostExecRefusal', () => {
  it('is true for the rejected response ts-rest throws on a host-exec refusal', () => {
    expect(isThrownHostExecRefusal({ status: 403, body: refusalBody })).toBe(true);
  });

  it('is false for a 403 naming an authority a second token cannot buy', () => {
    expect(isThrownHostExecRefusal({ status: 403, body: { error: capabilityRefusalMessage('admin') } })).toBe(false);
  });

  it.each([null, undefined, 'boom', 42, new Error('network down'), { status: '403' }, { body: refusalBody }])(
    'is false for a rejection with no usable status: %s',
    (thrown) => {
      expect(isThrownHostExecRefusal(thrown)).toBe(false);
    },
  );

  it('reads a missing body as absent rather than throwing', () => {
    expect(isThrownHostExecRefusal({ status: 403 })).toBe(false);
  });
});

describe('useHostToken on the thrown refusal path', () => {
  afterEach(() => cleanup());

  it('re-opens the prompt when the refusal arrives as a rejection', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(promptShown()).toBe(false);

    fireEvent.click(screen.getByText('throw-refuse'));

    expect(promptShown()).toBe(true);
  });

  it('leaves the prompt closed for a rejection a second token cannot answer', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Harness />);
    fireEvent.click(screen.getByText('Dismiss'));

    fireEvent.click(screen.getByText('throw-other'));

    expect(promptShown()).toBe(false);
  });
});
