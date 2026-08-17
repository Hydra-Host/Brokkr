import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Observable } from 'rxjs';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';
import { parseBoundary, ProcessesResponseSchema } from '../common/pc-schemas';
import { classifyProc, depsReady, procIsUp, type PcProcess, type ProcDiag, type ProcHealth } from './proc-health';

export { classifyProc, depsReady, procIsUp };
export type { PcProcess, ProcDiag, ProcHealth };

export const PcProcessConfigSchema = z
  .object({
    Command: z.string().optional(),
    Environment: z.array(z.string()).optional(),
    DependsOn: z.record(z.unknown()).optional(),
    ReadinessProbe: z.unknown().optional(),
    LivenessProbe: z.unknown().optional(),
    ShutDownParams: z.unknown().optional(),
    Availability: z.unknown().optional(),
    Namespace: z.unknown().optional(),
    Description: z.unknown().optional(),
    WorkingDir: z.unknown().optional(),
    LogLocation: z.unknown().optional(),
    Replicas: z.unknown().optional(),
    Disabled: z.unknown().optional(),
    IsElevated: z.unknown().optional(),
    Entrypoint: z.unknown().optional(),
    Extensions: z.unknown().optional(),
  })
  .passthrough();
export type PcProcessConfig = z.infer<typeof PcProcessConfigSchema>;

const LOG_BACKLOG_LINES = 2000;
const FOLLOW_READ_CHUNK = 256 * 1024;

@Injectable()
export class ProcessComposeClient {
  private readonly log = new Logger(ProcessComposeClient.name);
  private readonly bin = process.env.PROCESS_COMPOSE_BIN || 'process-compose';

  private socket(): string {
    const explicit = process.env.PC_SOCKET_PATH;
    if (explicit) return explicit;
    const runtime = process.env.DEVENV_RUNTIME;
    if (!runtime) {
      throw new Error(
        'process-compose socket unavailable: set PC_SOCKET_PATH, or run the control center inside the devenv shell (DEVENV_RUNTIME is unset).',
      );
    }
    return join(runtime, 'pc.sock');
  }

  private logDir(): string {
    const runtime = process.env.DEVENV_RUNTIME;
    if (!runtime) throw new Error('DEVENV_RUNTIME is unset — cannot locate the process-compose logs.');
    return join(runtime, 'processes', 'logs');
  }

  private send(method: string, path: string, socketPath?: string): Promise<{ status: number; body: string }> {
    const token = process.env.PC_API_TOKEN;
    const headers: Record<string, string> = token ? { 'X-PC-Token-Key': token } : {};
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: socketPath ?? this.socket(), path, method, headers }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      // a stuck UDS read must not hang the status poll forever — destroy (fires 'error' → reject).
      req.setTimeout(5_000, () => req.destroy(new Error(`process-compose ${method} ${path} timed out after 5s`)));
      req.on('error', reject);
      req.end();
    });
  }

  /** GET <path> expecting JSON, validated against `schema`; throws on transport error, non-2xx,
   *  unparseable JSON, or a shape the schema rejects. */
  private async getJson<S extends z.ZodTypeAny>(path: string, schema: S, socketPath?: string): Promise<z.infer<S>> {
    const { status, body } = await this.send('GET', path, socketPath);
    if (status < 200 || status >= 300)
      throw new Error(`process-compose GET ${path} failed (HTTP ${status}): ${body.slice(0, 200)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`process-compose GET ${path} returned unparseable JSON: ${body.slice(0, 200)}`);
    }
    return parseBoundary(schema, parsed, `process-compose GET ${path} returned an unexpected shape`);
  }

  private async control(method: string, path: string, label: string): Promise<void> {
    const { status, body } = await this.send(method, path);
    if (status < 200 || status >= 300)
      throw new Error(`process-compose ${label} failed (HTTP ${status}): ${body.trim().slice(0, 200)}`);
    this.log.log(label);
  }

  async list(): Promise<PcProcess[]> {
    const res = await this.getJson('/processes', ProcessesResponseSchema);
    return (res.data ?? []).filter((p) => p.status !== 'Disabled');
  }

  async listAll(): Promise<PcProcess[]> {
    const res = await this.getJson('/processes', ProcessesResponseSchema);
    return res.data ?? [];
  }

  /** /processes against another stack's socket (the /stacks dashboard probe) — same 5s guard as send(). */
  async listOnSocket(socketPath: string): Promise<PcProcess[]> {
    const res = await this.getJson('/processes', ProcessesResponseSchema, socketPath);
    return res.data ?? [];
  }

  async processInfo(name: string): Promise<PcProcessConfig> {
    return this.getJson(`/process/info/${encodeURIComponent(name)}`, PcProcessConfigSchema);
  }

  start(name: string): Promise<void> {
    return this.control('POST', `/process/start/${encodeURIComponent(name)}`, `start ${name}`);
  }

  stop(name: string): Promise<void> {
    return this.control('PATCH', `/process/stop/${encodeURIComponent(name)}`, `stop ${name}`);
  }

  restart(name: string): Promise<void> {
    return this.control('POST', `/process/restart/${encodeURIComponent(name)}`, `restart ${name}`);
  }

  // POST /process/restart returns 200 but leaves a signal-shutdown process in Completed without
  // starting it, so a caller that health-gates the result can only time out. Stop, then start.
  async restartAndWait(name: string): Promise<boolean> {
    if (!(await this.stopAndWait(name))) return false;
    // A start that 4xxs (e.g. pc already resurrected it) must not throw past the caller's own
    // abort message; report it and let the caller's health gate decide.
    try {
      await this.start(name);
    } catch (error) {
      this.log.warn(`restartAndWait: start ${name} failed: ${getErrorMessage(error)}`);
      return false;
    }
    return true;
  }

  // Inherits the /process/restart defect above: a 200 with no start never reaches the catch, so the
  // stop is explicit here too.
  async ensureRunning(name: string): Promise<void> {
    if (await this.restartAndWait(name)) return;
    await this.start(name).catch((error: unknown) => {
      this.log.warn(`ensureRunning: start ${name} failed: ${getErrorMessage(error)}`);
    });
  }

  async ensureStopped(name: string): Promise<void> {
    await this.stop(name).catch(() => {});
  }

  async stopAndWait(name: string, timeoutMs = 130_000): Promise<boolean> {
    // error/terminated count: an exited-with-error process is no longer running, which is all callers wait for.
    const terminal = new Set(['stopped', 'completed', 'disabled', 'skipped', 'error', 'terminated']);
    await this.stop(name).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const proc = (await this.listAll()).find((p) => p.name === name);
        if (!proc || terminal.has((proc.status ?? '').toLowerCase())) return true;
      } catch (error) {
        this.log.debug(`stopAndWait poll failed for ${name}: ${getErrorMessage(error)}`);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  streamLog(name: string, backlog = LOG_BACKLOG_LINES): Observable<string> {
    let url: string;
    try {
      const qs = `name=${encodeURIComponent(name)}&offset=${backlog}&follow=true`;
      url = `ws+unix://${this.socket()}:/process/logs/ws?${qs}`;
    } catch (e) {
      return new Observable<string>((s) => {
        s.next(`[logs unavailable] ${getErrorMessage(e)}\n`);
        s.complete();
      });
    }
    const token = process.env.PC_API_TOKEN;
    const opts = token ? { headers: { 'X-PC-Token-Key': token } } : undefined;
    return new Observable<string>((subscriber) => {
      const ws = new WebSocket(url, opts);
      ws.on('message', (raw: RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as { message?: string };
          if (msg.message) subscriber.next(`${msg.message}\n`);
        } catch {
          const text = raw.toString();
          if (text) subscriber.next(text);
        }
      });
      ws.on('error', (e: Error) => subscriber.next(`[logs error] ${e.message}\n`));
      ws.on('close', () => subscriber.complete());
      return () => {
        try {
          ws.close();
        } catch (error) {
          this.log.debug(`log stream close failed for ${name}: ${(error as Error).message}`);
        }
      };
    });
  }

  logFile(name: string, stream: 'stdout' | 'stderr' = 'stdout'): string {
    return join(this.logDir(), `${name}.${stream}.log`);
  }

  private tailFile(path: string, maxLen: number): string | undefined {
    try {
      const size = statSync(path).size;
      if (size === 0) return undefined;
      const span = Math.min(size, 8192);
      const buf = Buffer.alloc(span);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, span, size - span);
      } finally {
        closeSync(fd);
      }
      const lines = buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const last = lines[lines.length - 1];
      return last ? last.slice(0, maxLen) : undefined;
    } catch {
      return undefined;
    }
  }

  tailError(name: string, maxLen = 240): string | undefined {
    return this.tailFile(this.logFile(name, 'stderr'), maxLen) ?? this.tailFile(this.logFile(name, 'stdout'), maxLen);
  }

  taskLogFile(name: string): string {
    return join(this.logDir(), `${name}.log`);
  }

  taskLogDir(): string {
    return this.logDir();
  }

  /** Epoch of the running bring-up: the socket is rebound by every `devenv up`, which is what
   *  devenv/lib/with-task-log.sh compares each task log against. */
  socketMtimeMs(): number | null {
    try {
      return statSync(this.socket()).mtimeMs;
    } catch {
      return null;
    }
  }

  tailFileLast(path: string, maxLen = 240): string | undefined {
    return this.tailFile(path, maxLen);
  }

  followFile(
    path: string,
    opts: { backlogBytes?: number; pollMs?: number; startOffset?: number } = {},
  ): Observable<string> {
    const { backlogBytes = 64 * 1024, pollMs = 500, startOffset } = opts;
    return new Observable<string>((subscriber) => {
      let stopped = false;
      let lastSize = 0;
      let carry = '';
      // a StringDecoder holds partial multi-byte sequences across chunk/tick seams — per-chunk toString would emit U+FFFD
      let decoder = new StringDecoder('utf8');
      const emit = (text: string) => {
        const parts = (carry + text).split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) subscriber.next(`${line}\n`);
      };
      // returns the position actually consumed so a mid-delta read failure never re-emits on the next tick
      const readDelta = (from: number, to: number): number => {
        let pos = from;
        try {
          const fd = openSync(path, 'r');
          try {
            while (pos < to) {
              const span = Math.min(to - pos, FOLLOW_READ_CHUNK);
              const buf = Buffer.alloc(span);
              const read = readSync(fd, buf, 0, span, pos);
              if (read <= 0) break;
              emit(decoder.write(buf.subarray(0, read)));
              pos += read;
            }
          } finally {
            closeSync(fd);
          }
        } catch (error) {
          this.log.debug(`followFile read failed: ${getErrorMessage(error)}`);
        }
        return pos;
      };
      try {
        const size = statSync(path).size;
        const from = startOffset === undefined ? Math.max(0, size - backlogBytes) : Math.min(startOffset, size);
        lastSize = readDelta(from, size);
      } catch (error) {
        this.log.debug(`followFile backlog read failed: ${getErrorMessage(error)}`);
      }
      let timer: ReturnType<typeof setTimeout>;
      const tick = () => {
        if (stopped) return;
        try {
          const size = statSync(path).size;
          if (size < lastSize) {
            lastSize = 0;
            carry = '';
            decoder = new StringDecoder('utf8');
          }
          if (size > lastSize) lastSize = readDelta(lastSize, size);
        } catch (error) {
          this.log.debug(`followFile poll read failed: ${getErrorMessage(error)}`);
        }
        if (!stopped) timer = setTimeout(tick, pollMs);
      };
      timer = setTimeout(tick, pollMs);
      return () => {
        stopped = true;
        clearTimeout(timer);
        const tail = carry + decoder.end();
        if (tail) subscriber.next(`${tail}\n`);
      };
    });
  }

  streamTaskLog(name: string): Observable<string> {
    let path: string;
    try {
      path = this.taskLogFile(name);
    } catch (e) {
      return new Observable<string>((s) => {
        s.next(`[logs unavailable] ${getErrorMessage(e)}\n`);
        s.complete();
      });
    }
    return this.followFile(path);
  }

  tailTaskLog(name: string, maxLen = 240): string | undefined {
    try {
      return this.tailFileLast(this.taskLogFile(name), maxLen);
    } catch {
      return undefined;
    }
  }

  async projectUpdate(configPath: string): Promise<void> {
    const { code, stderr } = await this.run(['project', 'update', '-f', configPath]);
    if (code !== 0) throw new Error(`process-compose project update failed (exit ${code}): ${stderr.trim()}`);
    this.log.log(`project update (${configPath})`);
  }

  private run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const argv = ['-U', '-u', this.socket(), ...args];
    const timeoutMs = 60_000;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const child = spawn(this.bin, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PC_DISABLE_DOTENV: '1' },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
      child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
      child.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }));
      child.on('close', (code, signal) => {
        // an external sigkill (oom killer, manual kill -9) is not a timeout — only label
        // kills that arrive at the deadline as such
        if (signal === 'SIGKILL') {
          stderr +=
            Date.now() - startedAt >= timeoutMs - 1_000
              ? `\n[timed out after ${timeoutMs / 1000}s — killed]`
              : '\n[killed (sigkill)]';
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}
