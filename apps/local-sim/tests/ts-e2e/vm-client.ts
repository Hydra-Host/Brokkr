import { execFile } from 'node:child_process';

export interface RunResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

function emitSshEvent(user: string, ip: string, cmd: string, result: RunResult): void {
  const eventsUrl = process.env.TEST_EVENTS_URL;
  if (!eventsUrl) return;
  const ok = result.returncode === 0;
  const shortCmd = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  fetch(eventsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'ssh',
      level: ok ? 'info' : 'warn',
      message: `${user}@${ip} ${shortCmd} → ${ok ? 'ok' : `exit ${result.returncode}`}`,
    }),
  }).catch(() => {});
}

/**
 * Returns the part before the first `-`, or `'ubuntu'` if the slug is empty.
 *
 * brokkr-live (discovery) takes `root`; the installed customer OS takes
 * `ubuntu` (the deploy cloud-init writes the key there, not to root).
 */
export function userForSlug(slug: string): string {
  if (!slug) return 'ubuntu';
  const first = slug.split('-', 1)[0];
  return first || 'ubuntu';
}

export class VMClient {
  readonly ip: string;
  readonly user: string;

  constructor(ip: string, user: string = 'root') {
    this.ip = ip;
    this.user = user;
  }

  /**
   * Execute a command on the VM over SSH.
   *
   * Returns a result object with returncode, stdout, and stderr. On timeout
   * or OS-level error, returns a synthetic non-zero result (returncode 124)
   * instead of throwing -- callers treat non-zero as "probe failed", so poll
   * loops keep retrying until the device truly returns or the caller's own
   * timeout budget expires (a clean assertion, not a crash).
   */
  async run(cmd: string, timeout: number = 10): Promise<RunResult> {
    // Use the same key the bridge baked into the VM's authorized_keys. The harness
    // exports SIM_SSH_KEY (the key whose pubkey it feeds the bridge); with it unset,
    // fall back to ssh's default identity so a bare local run still works.
    const keyPath = process.env.SIM_SSH_KEY;
    const args = [
      '-o',
      'BatchMode=yes',
      ...(keyPath ? ['-i', keyPath] : []),
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `ConnectTimeout=${timeout}`,
      '-o',
      'UserKnownHostsFile=/dev/null',
      `${this.user}@${this.ip}`,
      cmd,
    ];

    // Match Python: subprocess.run timeout is ConnectTimeout + 5
    const timeoutMs = (timeout + 5) * 1000;

    return new Promise<RunResult>((resolve) => {
      execFile('ssh', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          const exitCode = error.killed ? 124 : (code ?? 124);
          const r: RunResult = { returncode: exitCode, stdout: stdout ?? '', stderr: stderr ?? String(error) };
          emitSshEvent(this.user, this.ip, cmd, r);
          resolve(r);
          return;
        }
        const r: RunResult = { returncode: 0, stdout, stderr };
        emitSshEvent(this.user, this.ip, cmd, r);
        resolve(r);
      });
    });
  }

  /**
   * Check whether a systemd unit is active on the VM.
   *
   * Throws a `ConnectionError`-equivalent Error if SSH itself fails
   * (returncode 255 = SSH transport failure).
   */
  async systemctlActive(unit: string): Promise<boolean> {
    const result = await this.run(`systemctl is-active ${unit}`);
    if (result.returncode === 255) {
      throw new Error(`SSH to ${this.ip} failed: ${result.stderr.trim()}`);
    }
    return result.stdout.trim() === 'active';
  }

  /**
   * Read a file from the VM. Throws if the command fails.
   */
  async readFile(path: string): Promise<string> {
    const result = await this.run(`cat ${path}`);
    if (result.returncode !== 0) {
      throw new Error(`${path} on ${this.ip}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }
}
