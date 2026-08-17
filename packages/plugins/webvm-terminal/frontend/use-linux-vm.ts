import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  COMMAND_END,
  COMMAND_START,
  formatApiOutput,
  makeApiRequest,
  REQUEST_END,
  REQUEST_START,
  RESPONSE_END,
  RESPONSE_START,
} from './linux-api-bridge';
import {
  BROKKR_BASHRC,
  BROKKR_SCRIPT,
  INITIAL_LOADING_STEPS,
  randomSpinnerVerb,
  TERMINAL_BANNER,
} from './linux-panel-constants';
import type {
  CheerpXDevice,
  CheerpXInstance,
  LoadingState,
  LoadingStep,
  XFitAddon,
  XTerminal,
} from './linux-panel-types';

const CHEERPX_SCRIPT_URL = 'https://cxrtnc.leaningtech.com/1.2.6/cx.js';
// SRI: this document makes credentialed API calls, so a compromised CDN script could hijack
// the session. Recompute on upgrade: curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
const CHEERPX_SCRIPT_INTEGRITY = 'sha384-XrX8yxwHGOTrWBFQ2Trx3RhzbQtVAeVC2jOlRTM+dHaE4eg8lZUMGB8dlk76V0oF';
const DEBIAN_IMAGE_URL = 'wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2';

/** BROKKR_CMD marker payload from the guest shell wrapper; args are base64 per
 * element — bash can't JSON-escape arbitrary control characters portably. */
const CommandPayloadSchema = z.object({ args64: z.array(z.string()) });

function decodeBase64Utf8(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
}

function loadCheerpXScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.CheerpX) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = CHEERPX_SCRIPT_URL;
    script.async = true;
    // crossOrigin is required for SRI on a cross-origin script.
    script.crossOrigin = 'anonymous';
    script.integrity = CHEERPX_SCRIPT_INTEGRITY;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load CheerpX script'));
    document.head.appendChild(script);
  });
}

export interface BrokkrCommandHandle {
  done: Promise<void>;
  sendInput: (data: string) => void;
  kill: () => void;
}

export type BrokkrCommandHandler = (
  args: string[],
  write: (s: string) => void,
  options: { cols: number; rows: number },
) => BrokkrCommandHandle;

export interface UseLinuxVMOptions {
  onCommand?: BrokkrCommandHandler;
  getBashCompletion?: () => Promise<string>;
}

export function useLinuxVM(options?: UseLinuxVMOptions) {
  const onCommand = options?.onCommand;
  const getBashCompletion = options?.getBashCompletion;

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<XFitAddon | null>(null);
  const cxInstanceRef = useRef<CheerpXInstance | null>(null);
  const sendInputRef = useRef<((charCode: number) => void) | null>(null);
  const outputBufferRef = useRef('');
  const spinnerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCommandRef = useRef<BrokkrCommandHandle | null>(null);
  const activeCommandIsTuiRef = useRef(false);

  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>(INITIAL_LOADING_STEPS);

  const updateStep = useCallback((stepId: string, status: LoadingStep['status']) => {
    setLoadingSteps((prev) => prev.map((step) => (step.id === stepId ? { ...step, status } : step)));
  }, []);

  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  const initializeVM = useCallback(async () => {
    if (isInitialized || !containerRef.current) return;

    try {
      if (typeof self === 'undefined' || !self.crossOriginIsolated) {
        throw new Error(
          'Cross-origin isolation not enabled. SharedArrayBuffer requires COOP/COEP headers. ' +
            'Restart the dev server and hard refresh (Cmd+Shift+R).',
        );
      }

      setLoadingState('loading-script');
      setErrorMessage(null);
      setLoadingSteps(INITIAL_LOADING_STEPS);

      updateStep('script', 'active');
      await loadCheerpXScript();
      if (!window.CheerpX) throw new Error('CheerpX not available after script load');
      updateStep('script', 'done');

      setLoadingState('loading-vm');

      updateStep('xterm', 'active');
      const [xtermModule, fitAddonModule] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      await import('@xterm/xterm/css/xterm.css');

      const styles = getComputedStyle(document.documentElement);
      const bgColor = styles.getPropertyValue('--color-bg-primary').trim() || '#100b09';
      const fgColor = styles.getPropertyValue('--color-text-primary').trim() || '#fff3ce';
      const accentColor = styles.getPropertyValue('--color-accent').trim() || '#ffdc75';
      const dimColor = styles.getPropertyValue('--color-text-dim').trim() || '#60514b';
      const mutedColor = styles.getPropertyValue('--color-text-muted').trim() || '#ad9985';

      const terminal = new xtermModule.Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
        fontSize: 13,
        theme: {
          background: bgColor,
          foreground: fgColor,
          cursor: accentColor,
          cursorAccent: bgColor,
          selectionBackground: mutedColor + '40',
          black: bgColor,
          red: '#ff383b',
          green: '#6fec4f',
          yellow: accentColor,
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#0bdedf',
          white: fgColor,
          brightBlack: dimColor,
          brightRed: '#ff6b6b',
          brightGreen: '#86efac',
          brightYellow: '#fde57c',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#5cfeff',
          brightWhite: '#ffffff',
        },
      });

      const fitAddon = new fitAddonModule.FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      updateStep('xterm', 'done');

      updateStep('devices', 'active');
      const CheerpX = window.CheerpX;

      let baseDevice: CheerpXDevice;
      if (CheerpX.CloudDevice) {
        baseDevice = await CheerpX.CloudDevice.create(DEBIAN_IMAGE_URL);
      } else if (CheerpX.HttpBytesDevice) {
        baseDevice = await CheerpX.HttpBytesDevice(DEBIAN_IMAGE_URL);
      } else {
        throw new Error('No compatible disk device API found in CheerpX');
      }

      const overlayDevice = await CheerpX.IDBDevice.create('brokkr-linux-overlay');
      const rootDevice = await CheerpX.OverlayDevice.create(baseDevice, overlayDevice);
      const dataDevice = await CheerpX.DataDevice.create();

      await dataDevice.writeFile('/brokkr', BROKKR_SCRIPT);
      let bashrc = BROKKR_BASHRC;
      if (getBashCompletion) {
        try {
          bashrc += '\n' + (await getBashCompletion());
        } catch (err) {
          console.warn('brokkr: failed to load bash completion —', err);
        }
      }
      await dataDevice.writeFile('/bashrc', bashrc);
      updateStep('devices', 'done');

      updateStep('vm', 'active');
      const cx = await CheerpX.Linux.create({
        mounts: [
          { type: 'ext2', path: '/', dev: rootDevice },
          { type: 'devs', path: '/dev' },
          { type: 'dir', path: '/brokkr', dev: dataDevice },
        ],
      });
      cxInstanceRef.current = cx;

      const decoder = new TextDecoder('utf-8');

      let suppressOutput = false;
      let suppressedBuffer = '';
      // Marker traffic captured while suppressed (`brokkr a; brokkr b`): replayed via
      // processOutput() after the operation settles so queued commands don't vanish.
      let deferredBuffer = '';

      const startSpinner = () => {
        let dotCount = 1;
        const verb = randomSpinnerVerb();
        terminal.write(`\n  \x1b[31m${verb}.\x1b[0m`);
        spinnerIntervalRef.current = setInterval(() => {
          dotCount = (dotCount % 3) + 1;
          terminal.write(`\r\x1b[2K  \x1b[31m${verb}${'.'.repeat(dotCount)}\x1b[0m`);
        }, 300);
      };

      const stopSpinner = () => {
        if (spinnerIntervalRef.current) {
          clearInterval(spinnerIntervalRef.current);
          spinnerIntervalRef.current = null;
        }
        terminal.write('\r\x1b[2K');
        suppressOutput = false;
        if (suppressedBuffer) {
          terminal.write(suppressedBuffer);
          suppressedBuffer = '';
        }
        replayDeferred();
      };

      const tryHandleMarker = (markerStart: string, markerEnd: string, handler: (json: string) => void): boolean => {
        const startIdx = outputBufferRef.current.indexOf(markerStart);
        if (startIdx === -1) return false;

        const jsonStart = startIdx + markerStart.length;
        const endIdx = outputBufferRef.current.indexOf(markerEnd, jsonStart);

        if (endIdx !== -1) {
          const beforeMarker = outputBufferRef.current.slice(0, startIdx);
          const payload = outputBufferRef.current.slice(jsonStart, endIdx);
          outputBufferRef.current = outputBufferRef.current.slice(endIdx + markerEnd.length);

          if (beforeMarker) terminal.write(beforeMarker);

          suppressOutput = true;
          suppressedBuffer = '';
          startSpinner();
          handler(payload);
          return true;
        }

        if (startIdx > 0) {
          terminal.write(outputBufferRef.current.slice(0, startIdx));
          outputBufferRef.current = outputBufferRef.current.slice(startIdx);
        }
        return true;
      };

      // From the first NUL onward everything goes to deferredBuffer so a marker
      // split across chunks stays contiguous.
      const bufferSuppressed = (data: string) => {
        if (deferredBuffer) {
          deferredBuffer += data;
          return;
        }
        const nullIdx = data.indexOf('\x00');
        if (nullIdx === -1) {
          suppressedBuffer += data;
          return;
        }
        suppressedBuffer += data.slice(0, nullIdx);
        deferredBuffer = data.slice(nullIdx);
      };

      // Hoisted (stopSpinner calls it). Runs processOutput even with nothing deferred:
      // a second marker coalesced into the same chunk would otherwise never dispatch.
      function replayDeferred(): void {
        if (deferredBuffer) {
          outputBufferRef.current += deferredBuffer;
          deferredBuffer = '';
        }
        if (outputBufferRef.current) processOutput();
      }

      const writeFunc = (buf: Uint8Array) => {
        const data = decoder.decode(buf);

        if (suppressOutput) {
          bufferSuppressed(data);
          return;
        }

        outputBufferRef.current += data;
        processOutput();
      };

      function processOutput(): void {
        if (
          tryHandleMarker(COMMAND_START, COMMAND_END, (json) => {
            try {
              // Guest-VM payload — a trust boundary, so validate; atob throws on
              // malformed base64, landing in the catch below like bad JSON.
              const args = CommandPayloadSchema.parse(JSON.parse(json)).args64.map(decodeBase64Utf8);
              const handler = onCommandRef.current;
              if (!handler) {
                terminal.write('\x1b[31mError: CLI handler not available\x1b[0m\n');
                stopSpinner();
                return;
              }

              if (spinnerIntervalRef.current) {
                clearInterval(spinnerIntervalRef.current);
                spinnerIntervalRef.current = null;
              }
              terminal.write('\r\x1b[2K');
              const isTui = args.length === 0 || (args.length === 1 && args[0] === 'tui');
              const handle = handler(args, (s) => terminal.write(s), {
                cols: terminal.cols,
                rows: terminal.rows,
              });
              // Deferral makes dispatch-while-active unreachable, but an earlier handle
              // must never keep running headless if that regresses: last one wins.
              activeCommandRef.current?.kill();
              activeCommandRef.current = handle;
              activeCommandIsTuiRef.current = isTui;
              // A stale settle (another command took over mid-kill) must touch nothing; a null
              // ref (Ctrl+C, no successor) still needs the cleanup or output stays suppressed forever.
              const settle = (onOwned: () => void) => {
                if (activeCommandRef.current !== null && activeCommandRef.current !== handle) return;
                activeCommandRef.current = null;
                activeCommandIsTuiRef.current = false;
                // Discard bash's buffered intermediate PS1
                suppressedBuffer = '';
                suppressOutput = false;
                try {
                  onOwned();
                } finally {
                  // Replay markers that arrived mid-command even if onOwned threw,
                  // or the queued command would vanish.
                  replayDeferred();
                }
              };
              handle.done.then(
                () =>
                  settle(() => {
                    if (isTui) {
                      terminal.write('\x1b[2J\x1b[H');
                    }
                    // Nudge bash for a fresh prompt
                    sendInput(10);
                  }),
                (err) =>
                  settle(() => {
                    terminal.write(`\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
                  }),
              );
            } catch {
              terminal.write('\x1b[31mError: Invalid command payload\x1b[0m\n');
              stopSpinner();
            }
          })
        ) {
          return;
        }

        if (
          tryHandleMarker(REQUEST_START, REQUEST_END, (requestJson) => {
            let parsed: { id?: string; method?: string; url?: string; body?: unknown } | null = null;
            try {
              parsed = JSON.parse(requestJson);
            } catch {
              parsed = null;
            }

            makeApiRequest(requestJson)
              .then(({ status, body }) => {
                // stopSpinner lifts output suppression — a throw while building/injecting the
                // response must not skip it or the terminal buffers all further VM output forever.
                try {
                  if (parsed?.id && sendInputRef.current) {
                    const responsePayload = JSON.stringify({
                      id: parsed.id,
                      status,
                      headers: { 'content-type': 'application/json' },
                      body,
                    });
                    const responseStr = `${RESPONSE_START}${responsePayload}${RESPONSE_END}`;
                    const inject = sendInputRef.current;
                    // CheerpX's console callback takes bytes (0-255) — encode to UTF-8 first;
                    // charCodeAt would feed UTF-16 code units and corrupt non-ASCII bytes.
                    const responseBytes = new TextEncoder().encode(responseStr);
                    for (const byte of responseBytes) {
                      inject(byte);
                    }
                  } else {
                    terminal.write(formatApiOutput(status, body));
                  }
                } finally {
                  stopSpinner();
                }
              })
              .catch((err: unknown) => {
                // makeApiRequest resolves even on fetch failure (500 envelope);
                // this only fires if that contract regresses — never hang.
                terminal.write(`\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
                stopSpinner();
              });
          })
        ) {
          return;
        }

        const nullIdx = outputBufferRef.current.indexOf('\x00');
        if (nullIdx !== -1) {
          if (nullIdx > 0) {
            terminal.write(outputBufferRef.current.slice(0, nullIdx));
            outputBufferRef.current = outputBufferRef.current.slice(nullIdx);
          }
          return;
        }

        terminal.write(outputBufferRef.current);
        outputBufferRef.current = '';
      }

      const cols = terminal.cols > 10 ? terminal.cols : 80;
      const rows = terminal.rows > 5 ? terminal.rows : 24;
      const sendInput = cx.setCustomConsole(writeFunc, cols, rows);
      sendInputRef.current = sendInput;

      terminal.onData((str) => {
        if (activeCommandRef.current) {
          if (str === '\x03' && activeCommandIsTuiRef.current) {
            const handle = activeCommandRef.current;
            activeCommandRef.current = null;
            activeCommandIsTuiRef.current = false;
            handle.kill();
            terminal.write('\x1b[2J\x1b[H');
            // No VM SIGINT fall-through: the TUI ran in the browser and bash is already
            // at its (suppressed) prompt — an injected ^C would just buffer an extra prompt.
            return;
          } else {
            activeCommandRef.current.sendInput(str);
            return;
          }
        }

        if (str === '\x03') {
          sendInput(3);
          sendInput(10);
          return;
        }
        // CheerpX's console sink takes bytes (0-255) — encode keystrokes to UTF-8;
        // charCodeAt would send UTF-16 code units and corrupt non-ASCII input.
        for (const byte of new TextEncoder().encode(str)) {
          sendInput(byte);
        }
      });

      updateStep('vm', 'done');

      updateStep('shell', 'active');
      setLoadingState('ready');
      setIsInitialized(true);

      for (const line of TERMINAL_BANNER) {
        terminal.writeln(line);
      }

      await cx.run('/bin/bash', ['-c', 'cp /brokkr/bashrc /home/user/.bashrc'], {
        env: ['HOME=/home/user', 'PATH=/usr/bin:/bin'],
      });

      await cx.run('/bin/bash', ['--login'], {
        env: ['HOME=/home/user', 'TERM=xterm-256color'],
      });
      updateStep('shell', 'done');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      setLoadingState('error');
      setErrorMessage(errMsg || 'Unknown error');
      setLoadingSteps((prev) => prev.map((step) => (step.status === 'active' ? { ...step, status: 'error' } : step)));
    }
  }, [isInitialized, updateStep, getBashCompletion]);

  useEffect(() => {
    if (loadingState !== 'idle') return;
    if (typeof self === 'undefined' || !self.crossOriginIsolated) return;
    const timer = setTimeout(() => initializeVM(), 100);
    return () => clearTimeout(timer);
  }, [loadingState, initializeVM]);

  useEffect(() => {
    return () => {
      if (spinnerIntervalRef.current) {
        clearInterval(spinnerIntervalRef.current);
        spinnerIntervalRef.current = null;
      }
      terminalRef.current?.dispose();
    };
  }, []);

  // Attached for the whole hook lifetime (not gated on 'ready'): the VM reads the
  // terminal's dimensions when its console is wired, so a stale size mid-boot would lock in.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver(() => fitAddonRef.current?.fit());
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // One extra fit shortly after the VM is ready, once its final layout settles.
  useEffect(() => {
    if (loadingState !== 'ready') return;
    const timer = setTimeout(() => fitAddonRef.current?.fit(), 50);
    return () => clearTimeout(timer);
  }, [loadingState]);

  const progress = (() => {
    let done = 0;
    let active = 0;
    for (const s of loadingSteps) {
      if (s.status === 'done') done++;
      else if (s.status === 'active') active++;
    }
    return Math.round(((done + active * 0.5) / loadingSteps.length) * 100);
  })();

  // Reload instead of re-initializing: CheerpX has no stop/destroy API, and a second
  // instance on the same 'brokkr-linux-overlay' IDBDevice could corrupt the overlay.
  const retry = useCallback(() => {
    window.location.reload();
  }, []);

  return { containerRef, loadingState, errorMessage, loadingSteps, progress, retry };
}
