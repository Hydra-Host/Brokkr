/**
 * VRRP VIP failover functional e2e.
 *
 * Wraps the apps/bridge/scripts/vrrp-e2e.ts harness so it runs in the local-sim ts-e2e
 * suite and surfaces in the control center Results tab. The harness drives the REAL
 * VrrpReconcilerService against LIVE Redis using the sim `ip` shim
 * (devenv/pkgs/vrrp-sim/ip.py): leader binds the VIP, follower binds nothing, failover
 * moves it to the new leader, a cleared atom releases it. It's self-contained (own zone
 * prefix + temp state dir, no real interfaces touched) and needs only a reachable Redis.
 *
 * Reused by SPAWNING the script, not importing it — ts-e2e is black-box and can't import
 * apps/bridge source. Harness exit codes: 0 = all checks green, 1 = a check failed,
 * 2 = Redis unreachable (→ skip, matching how smoke tolerates an absent stack).
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// apps/local-sim/tests/ts-e2e -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BRIDGE_DIR = path.join(REPO_ROOT, 'apps/bridge');
const HARNESS = path.join(BRIDGE_DIR, 'scripts/vrrp-e2e.ts');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';

// Fast reachability probe: ioredis retries a dead endpoint for ~20s before failing, so the
// harness's own ping guard can't cheaply distinguish "stack down". A short TCP connect can.
function redisReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return resolve(false);
    }
    const sock = net.connect({ host: parsed.hostname || '127.0.0.1', port: Number(parsed.port) || 6379 });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function runHarness(): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // cwd = apps/bridge so tsx picks up the bridge tsconfig (experimentalDecorators);
    // the harness imports NestJS-decorated services. Its shim path resolves via __dirname,
    // so cwd doesn't affect anything else.
    const child = spawn('npx', ['tsx', HARNESS], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0' },
    });
    let output = '';
    child.stdout.on('data', (c) => (output += String(c)));
    child.stderr.on('data', (c) => (output += String(c)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

describe('vrrp-failover', () => {
  it('VRRP VIP failover round-trip: bind → failover → clear (real reconciler + live Redis + ip shim)', async (ctx) => {
    // Stack down → skip rather than fail (mirrors how smoke tolerates an absent stack).
    if (!(await redisReachable(REDIS_URL))) return ctx.skip();
    const { code, output } = await runHarness();
    // Surface the harness ✓/✗ breakdown in the captured Results log.
    console.log(output);
    // Secondary guard: harness exits 2 if its own Redis ping fails.
    if (code === 2) return ctx.skip();
    expect(code, output).toBe(0);
  });
});
