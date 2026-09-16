// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = { active: { length: 0, getLine: () => null } };
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    clear() {}
    dispose() {}
    hasSelection() {
      return false;
    }
    onData() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@/lib/api', () => ({ tsr: { getMachineConsoleLog: { useQuery: () => ({ data: undefined }) } } }));
vi.mock('@/components/console', () => ({ ConsoleControls: () => null }));

import { WS_TOKEN_PROTOCOL } from '@/contract';
import { setHostToken, setLabApiToken } from '@/lib/lab-token';

import { Xterm } from './terminal';

const opened: { url: string; protocols: string | string[] | undefined }[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string, protocols?: string | string[]) {
    opened.push({ url, protocols });
  }
  send() {}
  close() {}
}

describe('Xterm transport', () => {
  beforeEach(() => {
    opened.length = 0;
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('never puts the token in the query string, which the lab now refuses', () => {
    setLabApiToken('pasted');
    render(<Xterm path="/api/fleet/shell?node=cpu-1" />);
    expect(opened[0]?.url).toBe(`ws://${location.host}/api/fleet/shell?node=cpu-1`);
    expect(opened[0]?.url).not.toContain('token=');
  });

  it('offers the host token as the value right after the lab.token marker', () => {
    setHostToken('host-sekret');
    render(<Xterm path="/api/fleet/shell?node=cpu-1" />);
    expect(opened[0]?.protocols).toEqual([WS_TOKEN_PROTOCOL, 'host-sekret']);
  });

  it('offers the typed host token over the injected one', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    setHostToken('host-sekret');
    render(<Xterm path="/api/tests/term?run=r1" />);
    expect(opened[0]?.protocols).toEqual([WS_TOKEN_PROTOCOL, 'host-sekret']);
  });

  it('offers the ordinary token as a subprotocol when no host token was typed', () => {
    setLabApiToken('pasted');
    render(<Xterm path="/api/fleet/shell?node=cpu-1" />);
    expect(opened[0]?.protocols).toEqual([WS_TOKEN_PROTOCOL, 'pasted']);
  });

  it('does not connect at all while a token is provably required and unset', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    render(<Xterm path="/api/fleet/shell?node=cpu-1" />);
    expect(opened).toEqual([]);
  });

  it('unmounts cleanly after the WebSocket constructor rejects the token', () => {
    class ThrowingSocket {
      static OPEN = 1;
      constructor() {
        throw new SyntaxError("subprotocol 'bad token' is not a valid token");
      }
    }
    vi.stubGlobal('WebSocket', ThrowingSocket);
    setLabApiToken('bad token');

    const view = render(<Xterm path="/api/fleet/shell?node=cpu-1" />);

    expect(() => view.unmount()).not.toThrow();
  });
});
