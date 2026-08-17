if (typeof globalThis.global === 'undefined') {
  (globalThis as Record<string, unknown>).global = globalThis;
}

if (typeof globalThis.setImmediate === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).setImmediate = (fn: () => void) => setTimeout(fn, 0);
  (globalThis as unknown as Record<string, unknown>).clearImmediate = (id: number) => clearTimeout(id);
}
if (typeof console.Console === 'undefined') {
  (console as unknown as Record<string, unknown>).Console = class BrowserConsole {
    log = console.log.bind(console);
    error = console.error.bind(console);
    warn = console.warn.bind(console);
    info = console.info.bind(console);
    debug = console.debug.bind(console);
    dir = console.dir.bind(console);
    constructor(_stdout?: unknown, _stderr?: unknown) {}
  };
}

const noop = (): boolean => true;

// Always overwrite — Vite's dev server may set a partial process object missing fields Ink/Commander expect.
{
  (globalThis as Record<string, unknown>).process = {
    argv: ['node', 'brokkr'],
    env: { BROKKR_BRIDGE: '1', FORCE_COLOR: '3', TERM: 'xterm-256color', NODE_ENV: 'production', DEV: '' },
    stdout: { write: noop, isTTY: true, columns: 120, rows: 40, on: noop, once: noop, off: noop, emit: noop },
    stderr: { write: noop, isTTY: true, columns: 120, rows: 40, on: noop, once: noop, off: noop, emit: noop },
    stdin: { setEncoding: noop, resume: noop, pause: noop, on: noop, off: noop, isTTY: false, read: noop },
    exit: (code?: number) => {
      throw Object.assign(new Error(`process.exit(${code ?? 0})`), { exitCode: code ?? 0 });
    },
    platform: 'linux',
    cwd: () => '/',
    nextTick: (fn: () => void) => setTimeout(fn, 0),
    version: 'v20.0.0',
    versions: { node: '20.0.0' },
  };
}
