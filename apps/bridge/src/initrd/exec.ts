import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class CommandTimeout extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'CommandTimeout';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export interface RunOptions {
  timeoutMs?: number;
}

export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      rejectPromise(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new CommandTimeout(`${cmd} ${args.join(' ')}`, opts.timeoutMs ?? 0));
        return;
      }
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs: Date.now() - started,
      });
    });
  });
}
