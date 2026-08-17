import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FleetTopologyService } from './fleet-topology.service';

@Injectable()
export class FleetExecService {
  constructor(private readonly topology: FleetTopologyService) {}

  private expandPath(v: string): string {
    const withVars = v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => process.env[name] ?? '');
    if (withVars === '~') return homedir();
    if (withVars.startsWith('~/')) return join(homedir(), withVars.slice(2));
    return withVars;
  }

  private sshPrivKeyPath(): string {
    const v = process.env.BRIDGE_SSH_PRIVKEY_PATH || process.env.SSH_KEY_PATH;
    if (!v)
      throw new BadRequestException('BRIDGE_SSH_PRIVKEY_PATH (or SSH_KEY_PATH) not set in the lab process environment');
    return this.expandPath(v);
  }

  // Must use the same fallback chain as Python _ssh_pubkey() — NOT SSH_KEY_PATH, which VMClient does not honour.
  devPubkey(): { pubkey: string | null } {
    const priv = process.env.BRIDGE_SSH_PRIVKEY_PATH || '~/.ssh/id_ed25519';
    const pubPath = `${this.expandPath(priv)}.pub`;
    if (!existsSync(pubPath)) return { pubkey: null };
    return { pubkey: readFileSync(pubPath, 'utf8').trim() };
  }

  // Matches the VMClient flag set (apps/local-sim/tests/e2e/clients.py) for exit-code parity; the command is unrestricted, so this must stay loopback-only or behind the lab auth guard.
  async runOnNode(
    name: string,
    command: string,
    user = 'root',
    timeoutS = 30,
  ): Promise<{ stdout: string; stderr: string; exit_code: number; duration_ms: number }> {
    const ip = this.topology.dataIpForNode(name);
    const keyPath = this.sshPrivKeyPath();
    const sshUser = user && user.trim() !== '' ? user : 'root';
    const argv = [
      '-i',
      keyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `ConnectTimeout=${timeoutS}`,
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      `${sshUser}@${ip}`,
      command,
    ];
    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      const cap = (s: string, chunk: Buffer): string => {
        const next = s + chunk.toString('utf8');
        return next.length > 1_048_576 ? next.slice(-1_048_576) : next;
      };
      child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
      const killAfterS = timeoutS + 5;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolve({
          stdout,
          stderr: stderr || `lab-side timeout after ${killAfterS}s`,
          exit_code: 124,
          duration_ms: Date.now() - started,
        });
      }, killAfterS * 1000);
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exit_code: 255, duration_ms: Date.now() - started });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exit_code: code ?? 255, duration_ms: Date.now() - started });
      });
    });
  }

  /** Mirrors local.config.LocalPaths.root — must resolve the same path the engine writes to. */
  consoleLogPath(name: string): string {
    if (!this.topology.nodeNames().includes(name)) throw new NotFoundException(`unknown node '${name}'`);
    const raw = process.env.LOCAL_STATE;
    const stateRoot = raw ? this.expandPath(raw) : join(homedir(), '.local', 'share', 'local');
    const logPath = join(stateRoot, 'state', 'logs', `${name}.log`);
    if (!existsSync(logPath)) throw new NotFoundException(`no console log yet for '${name}' (looked at ${logPath})`);
    return logPath;
  }

  consoleLog(name: string, tailBytes = 65_536): { content: string; bytes: number; truncated: boolean } {
    const logPath = this.consoleLogPath(name);
    const total = statSync(logPath).size;
    const want = Math.min(total, tailBytes);
    const offset = total - want;
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(want);
      let read = 0;
      while (read < want) {
        const n = readSync(fd, buf, read, want - read, offset + read);
        if (n <= 0) break;
        read += n;
      }
      return { content: buf.subarray(0, read).toString('utf8'), bytes: total, truncated: offset > 0 };
    } finally {
      closeSync(fd);
    }
  }
}
