import { generateStaticBashCompletion } from './completion/static-bash.js';
import { createProgram } from './program.js';

export function getBashCompletionScript(): string {
  return generateStaticBashCompletion(createProgram());
}

export interface BrokkrCommandOptions {
  cols?: number;
  rows?: number;
}

export interface BrokkrCommandHandle {
  done: Promise<void>;
  sendInput: (data: string) => void;
  kill: () => void;
}

export function runBrokkrCommand(
  args: string[],
  write: (str: string) => void,
  options?: BrokkrCommandOptions,
): BrokkrCommandHandle {
  const proc = globalThis.process as unknown as Record<string, unknown>;
  const { stdout, stderr, stdin } = globalThis.process;

  (stdout as unknown as Record<string, unknown>).isTTY = true;
  (stderr as unknown as Record<string, unknown>).isTTY = true;
  if (options?.cols) {
    (stdout as unknown as Record<string, unknown>).columns = options.cols;
    (stderr as unknown as Record<string, unknown>).columns = options.cols;
  }
  if (options?.rows) {
    (stdout as unknown as Record<string, unknown>).rows = options.rows;
    (stderr as unknown as Record<string, unknown>).rows = options.rows;
  }

  const origStdoutWrite = stdout.write.bind(stdout);
  const origStderrWrite = stderr.write.bind(stderr);
  const origLog = console.log;
  const origError = console.error;
  const origExit = globalThis.process.exit;

  const writeProxy = ((str: unknown) => {
    write(String(str));
    return true;
  }) as typeof stdout.write;
  stdout.write = writeProxy;
  stderr.write = writeProxy;
  console.log = (...a: unknown[]) => write(a.join(' ') + '\n');
  console.error = (...a: unknown[]) => write(a.join(' ') + '\n');

  type Listener = (...args: unknown[]) => void;
  type Writable = { _write?: (chunk: string, enc: string, cb: () => void) => void };
  const listeners = new Map<string, Set<Listener>>();
  const inputQueue: string[] = [];
  const pipeDests = new Set<Writable>();
  const noop = () => stdinProxy;

  const stdinProxy = {
    isTTY: true,
    setEncoding: noop,
    resume: noop,
    pause: noop,
    setRawMode: noop,
    ref: noop,
    unref: noop,
    read: (): string | null => inputQueue.shift() ?? null,
    pipe: (dest: Writable) => {
      pipeDests.add(dest);
      return dest;
    },
    unpipe: (dest?: Writable) => {
      if (dest) pipeDests.delete(dest);
      else pipeDests.clear();
      return stdinProxy;
    },
    on: (event: string, fn: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return stdinProxy;
    },
    off: (event: string, fn: Listener) => {
      listeners.get(event)?.delete(fn);
      return stdinProxy;
    },
    once: (event: string, fn: Listener) => {
      const wrapped: Listener = (...a) => {
        stdinProxy.off(event, wrapped);
        fn(...a);
      };
      return stdinProxy.on(event, wrapped);
    },
    addListener: (event: string, fn: Listener) => stdinProxy.on(event, fn),
    removeListener: (event: string, fn: Listener) => stdinProxy.off(event, fn),
    removeAllListeners: (event?: string) => {
      if (event) listeners.delete(event);
      else listeners.clear();
      return stdinProxy;
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    listeners: (event: string) => [...(listeners.get(event) ?? [])],
    emit: (event: string, ...a: unknown[]) => {
      const fns = listeners.get(event);
      if (fns) for (const fn of fns) fn(...a);
    },
  };
  proc.stdin = stdinProxy;

  let inkInstance: { unmount: () => void; cleanup: () => void } | undefined;
  let resolveKilled: (() => void) | undefined;

  const sendInput = (data: string) => {
    inputQueue.push(data);
    stdinProxy.emit('readable');
  };

  const kill = () => {
    if (inkInstance) {
      inkInstance.unmount();
      inkInstance.cleanup();
      inkInstance = undefined;
    }
    resolveKilled?.();
  };

  proc.exit = ((code?: number) => {
    kill();
    throw Object.assign(new Error('process.exit'), { exitCode: code ?? 0 });
  }) as never;

  const restore = () => {
    stdout.write = origStdoutWrite;
    stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    proc.stdin = stdin;
    proc.exit = origExit;
    listeners.clear();
    inputQueue.length = 0;
  };

  const done = (async () => {
    try {
      const isTui = args.length === 0 || (args.length === 1 && args[0] === 'tui');

      if (isTui) {
        const { getConnectionMode, getActiveEnv } = await import('./config/env.js');
        const { getAuthenticatedClient } = await import('./core/client.js');
        const { render } = await import('ink');
        const React = await import('react');
        const { App } = await import('./tui/app.js');

        inkInstance = render(
          React.createElement(App, {
            client: getAuthenticatedClient(),
            env: getActiveEnv(),
            orgName: getConnectionMode() === 'bridge' ? 'Browser Session' : 'CLI',
          }),
          {
            stdout: stdout as unknown as NodeJS.WriteStream,
            stdin: stdinProxy as unknown as NodeJS.ReadStream,
          },
        );

        await new Promise<void>((resolve) => {
          resolveKilled = resolve;
        });
      } else {
        const program = createProgram();
        program.configureOutput({
          writeOut: (str: string) => write(str),
          writeErr: (str: string) => write(str),
        });
        program.exitOverride();
        await program.parseAsync(['node', 'brokkr', ...args], { from: 'node' });
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'exitCode' in err) return;
      write(`\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    } finally {
      restore();
    }
  })();

  return { done, sendInput, kill };
}
