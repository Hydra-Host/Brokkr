/**
 * Background recorder for lifecycle e2e tests — TS port of lifecycle_recorder.py.
 *
 * Merges real-time streams into the lab's event timeline:
 *   ATOM  — Redis keyspace notifications for zone device atoms
 *   DB    — Postgres pg_notify via LISTEN sim_lifecycle
 *   SAGA  — spoke stdout log tail for saga step events
 *   API   — hub-api stdout log tail for HTTP requests + BridgeResultsConsumer
 *
 * Each source POSTs events to the lab API's event endpoint (TEST_EVENTS_URL).
 * Start/stop via start() / stop() around a lifecycle test.
 */

import Redis from 'ioredis';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client as PgClient } from 'pg';

const LIFECYCLE_TABLES = new Set([
  'Device',
  'Server',
  'Deployment',
  'Job',
  'LifecycleJob',
  'LifecycleJobEvent',
  'DeploymentLayer',
  'DeploymentSshKeys',
]);

const ATOM_SKIP_PREFIXES = ['discovery:', 'mac:', 'ipmi_mac:', 'system_uuid:', 'pointers'];

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const HTTP_RE = /\[LoggingMiddleware\]\s+(?<method>GET|POST|PATCH|PUT|DELETE)\s+(?<path>\/\S+)\s+(?<status>\d+)/;
const HTTP_SKIP = new Set(['/healthcheck', '/api/v1/auth/sign-in/email']);
// set-active carries the org id in the path, so it needs a pattern, not a Set entry.
const HTTP_SKIP_RE = /^\/api\/v1\/organizations\/[^/]+\/set-active$/;
const HTTP_DEVICE_RE = /\/devices\/(?<dev>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/;
const BRIDGE_RESULT_RE = /\[BridgeResultsConsumer\]\s+(?<msg>.+)/;
const BRIDGE_RESULT_DEVICE_RE = /device=(?<dev>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/;

const SAGA_START_RE =
  /Starting saga '(?<saga>\w+)' for plan (?<plan>[0-9a-f-]+)(?:\s*\(lock acquired: device:(?<dev>[0-9a-f-]+)\))?/;
const SAGA_TRIGGERED_RE = /Triggered (?<saga>\w+) saga for device (?<dev>[0-9a-f-]+) \(plan=(?<plan>[0-9a-f-]+)\)/;
const SAGA_STEP_RE = /Saga '(?<saga>\w+)' step '(?<step>[\w.]+)' (?<verb>completed|failed|deferred)/;
const SAGA_PLAN_DONE_RE = /Saga '(?<saga>\w+)' (?<verb>completed|failed)\S* for plan (?<plan>[0-9a-f-]+)/;
const SAGA_RECOVERY_RE = /Saga '(?<saga>\w+)' recovery: rewinding to '(?<step>[\w.]+)'/;
const SAGA_DEVICE_INLINE_RE = /device (?<dev>[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/;

function postEvent(
  eventsUrl: string,
  source: string,
  message: string,
  opts?: { level?: string; metadata?: Record<string, unknown> },
): void {
  fetch(eventsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      level: opts?.level ?? 'info',
      message,
      metadata: opts?.metadata,
    }),
  }).catch(() => {});
}

function logsIn(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

function discoverLogs(pattern: RegExp): string[] {
  // devenv puts process logs under $DEVENV_RUNTIME (an XDG runtime dir on Linux); the /tmp glob
  // below is the older layout and stays as a fallback.
  const runtime = process.env.DEVENV_RUNTIME;
  if (runtime) {
    const found = logsIn(path.join(runtime, 'processes', 'logs'), pattern);
    if (found.length > 0) return found;
  }
  const base = '/tmp';
  try {
    return fs
      .readdirSync(base)
      .filter((d) => d.startsWith('devenv-'))
      .flatMap((d) => logsIn(path.join(base, d, 'processes', 'logs'), pattern))
      .sort();
  } catch {
    return [];
  }
}

class LogTailer {
  private fd: number | null = null;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf = '';
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly onLine: (line: string) => void,
  ) {}

  start(): void {
    try {
      const stat = fs.statSync(this.filePath);
      this.offset = stat.size;
      this.fd = fs.openSync(this.filePath, 'r');
      this.timer = setInterval(() => this.poll(), 300);
    } catch {
      // File doesn't exist yet — silently skip
    }
  }

  private poll(): void {
    if (this.stopped || this.fd === null) return;
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= this.offset) return;
      const chunk = Buffer.alloc(stat.size - this.offset);
      fs.readSync(this.fd, chunk, 0, chunk.length, this.offset);
      this.offset = stat.size;
      this.buf += chunk.toString('utf8');
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line) this.onLine(line);
      }
    } catch {
      // file may have been rotated
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* */
      }
    }
  }
}

export class LifecycleRecorder {
  private readonly eventsUrl: string;
  private readonly redisUrl: string;
  private readonly pgDsn: string;
  private readonly zoneId: string;
  private subscriber: Redis | null = null;
  private valueClient: Redis | null = null;
  private pgClient: PgClient | null = null;
  private tailers: LogTailer[] = [];
  private planDevices = new Map<string, string>();
  private activePlans = new Map<string, Set<string>>();
  private stopped = false;
  private priorNotifyKeyspaceEvents: string | null = null;

  constructor() {
    this.eventsUrl = process.env.TEST_EVENTS_URL ?? '';
    this.redisUrl = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
    this.pgDsn = process.env.HUB_DATABASE_URL ?? 'postgresql://brokkr:password@127.0.0.1:5432/brokkr';
    this.zoneId = process.env.BRIDGE_ZONE_ID ?? '';
  }

  async start(): Promise<void> {
    if (!this.eventsUrl) return;
    await Promise.allSettled([
      this.startAtomSource(),
      this.startDbSource(),
      this.startSagaSource(),
      this.startApiSource(),
    ]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.tailers) t.stop();
    if (this.subscriber) {
      try {
        this.subscriber.disconnect();
      } catch {
        /* */
      }
    }
    if (this.valueClient) {
      try {
        this.valueClient.disconnect();
      } catch {
        /* */
      }
    }
    if (this.pgClient) {
      try {
        await this.pgClient.end();
      } catch {
        /* */
      }
    }
    if (this.priorNotifyKeyspaceEvents !== null) {
      const restoreClient = new Redis(this.redisUrl);
      try {
        await restoreClient.config('SET', 'notify-keyspace-events', this.priorNotifyKeyspaceEvents);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.eventsUrl) postEvent(this.eventsUrl, 'atom', `(notify-keyspace-events restore failed: ${msg})`);
      } finally {
        restoreClient.disconnect();
      }
      this.priorNotifyKeyspaceEvents = null;
    }
  }

  private emit(source: string, message: string, metadata?: Record<string, unknown>): void {
    if (this.stopped || !this.eventsUrl) return;
    postEvent(this.eventsUrl, source, message, { metadata });
  }

  // ---- ATOM: Redis keyspace notifications ----

  private async startAtomSource(): Promise<void> {
    if (!this.zoneId) return;
    try {
      const configClient = new Redis(this.redisUrl);
      const prior = await configClient.config('GET', 'notify-keyspace-events');
      await configClient.config('SET', 'notify-keyspace-events', 'KEA');
      // ioredis returns [key, value] for CONFIG GET; record only after the SET is confirmed
      // (the value may be '') so stop() skips the restore when nothing was mutated.
      if (Array.isArray(prior) && typeof prior[1] === 'string') {
        this.priorNotifyKeyspaceEvents = prior[1];
      }
      await configClient.quit();

      this.subscriber = new Redis(this.redisUrl);
      this.valueClient = new Redis(this.redisUrl);
      const db = this.redisDb();
      const prefix = `__keyspace@${db}__:`;
      await this.subscriber.psubscribe(`${prefix}${this.zoneId}:*`);

      this.subscriber.on('pmessage', (_pattern: string, channel: string, event: string) => {
        if (this.stopped) return;
        const key = channel.slice(prefix.length);
        if (!key.includes(':device:')) return;

        const after = key.split(':device:')[1];
        if (!after) return;
        const sepIdx = after.indexOf(':');
        const dev = sepIdx >= 0 ? after.slice(0, sepIdx) : after;
        const atom = sepIdx >= 0 ? after.slice(sepIdx + 1) : '';

        if (!atom) {
          if (event === 'expire') return;
          const verb: Record<string, string> = { set: 'acquire', del: 'release' };
          this.emit('atom', `lock ${verb[event] ?? event}`, { deviceId: dev });
          return;
        }

        if (ATOM_SKIP_PREFIXES.some((p) => atom.startsWith(p))) return;

        if (event === 'set') {
          this.valueClient!.get(key)
            .then((val) => {
              const detail = this.formatAtomValue(val);
              this.emit('atom', `${event} ${atom}${detail}`, { deviceId: dev });
            })
            .catch(() => {
              this.emit('atom', `${event} ${atom}`, { deviceId: dev });
            });
        } else if (event === 'del') {
          this.emit('atom', `${event} ${atom}`, { deviceId: dev });
        }
      });
    } catch (err) {
      this.emit('atom', `(recorder disabled: ${err})`);
    }
  }

  private formatAtomValue(raw: string | null): string {
    if (!raw) return '';
    try {
      const doc = JSON.parse(raw);
      const value = doc?.value ?? doc;
      if (process.env.SIM_LC_ATOM_VALUES?.toLowerCase() === 'full' && typeof value === 'object') {
        return ' ' + JSON.stringify(value);
      }
      const bits: string[] = [];
      if (doc?.value !== undefined && doc?.status !== undefined) bits.push(`env:${doc.status}`);
      if (typeof value === 'object' && value !== null) {
        for (const f of ['status', 'role', 'is_placeholder', 'installed_os', 'rescue_os', 'last_job_id']) {
          const v = (value as Record<string, unknown>)[f];
          if (v != null) bits.push(`${f}=${f === 'last_job_id' ? String(v).slice(0, 8) : v}`);
        }
      }
      return bits.length ? ` [${bits.join(' ')}]` : '';
    } catch {
      return '';
    }
  }

  private redisDb(): number {
    const parts = this.redisUrl.split('/');
    const last = parts[parts.length - 1]?.split('?')[0];
    return last && /^\d+$/.test(last) ? parseInt(last, 10) : 0;
  }

  // ---- DB: Postgres LISTEN/NOTIFY ----

  private async startDbSource(): Promise<void> {
    try {
      this.pgClient = new PgClient({ connectionString: this.pgDsn });
      await this.pgClient.connect();
      await this.pgClient.query('LISTEN sim_lifecycle');
      this.pgClient.on('notification', (msg) => {
        if (this.stopped || !msg.payload) return;
        this.recordDbNotify(msg.payload);
      });
    } catch (err) {
      this.emit('db', `(recorder disabled: ${err})`);
    }
  }

  private recordDbNotify(payload: string): void {
    try {
      const d = JSON.parse(payload);
      const tbl = d.tbl ?? '?';
      if (!LIFECYCLE_TABLES.has(tbl)) return;
      const op = d.op ?? '?';
      const fields = Object.entries(d)
        .filter(([k]) => !['tbl', 'op', 'deviceId', 'serverId'].includes(k))
        .map(([k, v]) => {
          if (v == null) return null;
          const sv = String(v);
          return `${k}=${k.endsWith('Id') || k === 'id' ? sv.slice(0, 8) : sv}`;
        })
        .filter(Boolean)
        .join(' ');
      const deviceId = d.deviceId ?? d.id ?? d.serverId;
      this.emit('db', `${tbl}.${op} ${fields}`.trimEnd(), {
        deviceId,
        table: tbl,
        operation: op,
      });
    } catch {
      this.emit('db', payload.slice(0, 80));
    }
  }

  // ---- SAGA: spoke stdout log tail ----

  private startSagaSource(): void {
    const logPaths = discoverLogs(/^spoke.*\.stdout\.log$/);
    for (const logPath of logPaths) {
      const tailer = new LogTailer(logPath, (line) => this.recordSaga(line));
      tailer.start();
      this.tailers.push(tailer);
    }
  }

  private resolveDevice(planId: string | undefined, sagaName: string | undefined, line: string): string {
    if (planId && this.planDevices.has(planId)) return this.planDevices.get(planId)!;
    const m = SAGA_DEVICE_INLINE_RE.exec(line);
    if (m?.groups?.dev) return m.groups.dev;
    if (sagaName) {
      const plans = this.activePlans.get(sagaName);
      if (plans?.size === 1) {
        const solePlan = plans.values().next().value as string;
        return this.planDevices.get(solePlan) ?? '';
      }
    }
    return '';
  }

  private recordSaga(rawLine: string): void {
    const line = rawLine.replace(ANSI_RE, '');
    let m = SAGA_START_RE.exec(line);
    if (m?.groups) {
      const { saga, plan, dev } = m.groups;
      if (dev) this.planDevices.set(plan, dev);
      if (!this.activePlans.has(saga)) this.activePlans.set(saga, new Set());
      this.activePlans.get(saga)!.add(plan);
      this.emit('saga', `${saga} started (plan=${plan.slice(0, 8)})`, { deviceId: dev });
      return;
    }

    m = SAGA_TRIGGERED_RE.exec(line);
    if (m?.groups) {
      const { saga, dev, plan } = m.groups;
      this.planDevices.set(plan, dev);
      if (!this.activePlans.has(saga)) this.activePlans.set(saga, new Set());
      this.activePlans.get(saga)!.add(plan);
      this.emit('saga', `${saga} triggered (plan=${plan.slice(0, 8)})`, { deviceId: dev });
      return;
    }

    m = SAGA_PLAN_DONE_RE.exec(line);
    if (m?.groups) {
      const { saga, verb, plan } = m.groups;
      const dev = this.planDevices.get(plan) ?? '';
      this.activePlans.get(saga)?.delete(plan);
      if (this.activePlans.get(saga)?.size === 0) this.activePlans.delete(saga);
      this.emit('saga', `${saga} ${verb} (plan=${plan.slice(0, 8)})`, { deviceId: dev });
      return;
    }

    m = SAGA_STEP_RE.exec(line);
    if (m?.groups) {
      const { saga, step, verb } = m.groups;
      const dev = this.resolveDevice(undefined, saga, line);
      this.emit('saga', `${saga}/${step} ${verb}`, { deviceId: dev });
      return;
    }

    m = SAGA_RECOVERY_RE.exec(line);
    if (m?.groups) {
      const { saga, step } = m.groups;
      const dev = this.resolveDevice(undefined, saga, line);
      this.emit('saga', `${saga} recovery→${step}`, { deviceId: dev });
    }
  }

  // ---- API: hub-api stdout log tail ----

  private startApiSource(): void {
    const logPaths = discoverLogs(/^hub-api.*\.stdout\.log$/);
    for (const logPath of logPaths) {
      const tailer = new LogTailer(logPath, (line) => this.recordApi(line));
      tailer.start();
      this.tailers.push(tailer);
    }
  }

  private recordApi(rawLine: string): void {
    const line = rawLine.replace(ANSI_RE, '');

    let m = HTTP_RE.exec(line);
    if (m?.groups) {
      const { method, path: reqPath, status } = m.groups;
      if (HTTP_SKIP.has(reqPath) || HTTP_SKIP_RE.test(reqPath) || reqPath === '/healthcheck') return;
      const devM = HTTP_DEVICE_RE.exec(reqPath);
      const shortPath = reqPath.replace('/api/v1', '');
      this.emit('api', `${method} ${shortPath} → ${status}`, {
        deviceId: devM?.groups?.dev,
      });
      return;
    }

    m = BRIDGE_RESULT_RE.exec(line);
    if (m?.groups) {
      const msg = m.groups.msg.trim();
      const devM = BRIDGE_RESULT_DEVICE_RE.exec(msg);
      this.emit('api', msg, { deviceId: devM?.groups?.dev });
    }
  }
}
