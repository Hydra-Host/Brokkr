import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CommandTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CommandFailed extends Error {
  readonly cmd: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(cmd: readonly string[], exitCode: number, stdout: string, stderr: string) {
    super(`Command failed with exit code ${exitCode}`);
    this.name = 'CommandFailed';
    this.cmd = cmd;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  get output(): string {
    return this.stdout;
  }
}

const SIGNAL_NUMBERS: Record<string, number> = osConstants.signals as unknown as Record<string, number>;

function signalToExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const n = SIGNAL_NUMBERS[signal];
  return n === undefined ? 1 : -n;
}

export async function run(cmd: readonly string[], timeout = 10): Promise<CommandResult> {
  if (cmd.length === 0) {
    throw new Error('Command is empty');
  }

  const [bin, ...args] = cmd;
  if (bin === undefined) {
    throw new Error('Command is empty');
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let spawnError: Error | null = null;
    let timer: NodeJS.Timeout | null = null;

    if (timeout !== 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout * 1000);
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      spawnError = err;
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);

      if (timedOut) {
        reject(new CommandTimeout(`Command timed out after ${timeout} seconds`));
        return;
      }

      if (spawnError) {
        reject(spawnError);
        return;
      }

      const stdoutBuf = Buffer.concat(stdoutChunks);
      const stderrBuf = Buffer.concat(stderrChunks);
      const exitCode = code !== null ? code : signalToExitCode(signal);

      if (exitCode !== 0) {
        reject(new CommandFailed(cmd, exitCode, stdoutBuf.toString('utf-8'), stderrBuf.toString('utf-8')));
        return;
      }

      // Strict UTF-8 on the success path so a corrupt result can't pass silently.
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let stdout: string;
      let stderr: string;
      try {
        stdout = decoder.decode(stdoutBuf);
        stderr = decoder.decode(stderrBuf);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });
  });
}
