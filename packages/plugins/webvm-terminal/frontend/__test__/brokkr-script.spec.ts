import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COMMAND_END, COMMAND_START } from '../linux-api-bridge';
import { BROKKR_SCRIPT } from '../linux-panel-constants';

const dir = mkdtempSync(join(tmpdir(), 'brokkr-script-'));
const scriptPath = join(dir, 'brokkr');
writeFileSync(scriptPath, BROKKR_SCRIPT, { mode: 0o755 });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function roundTrip(args: string[]): string[] {
  const stdout = execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8' });
  const start = stdout.indexOf(COMMAND_START);
  const end = stdout.indexOf(COMMAND_END, start + COMMAND_START.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const payload = z
    .object({ args64: z.array(z.string()) })
    .parse(JSON.parse(stdout.slice(start + COMMAND_START.length, end)));
  return payload.args64.map((value) => Buffer.from(value, 'base64').toString('utf8'));
}

describe('BROKKR_SCRIPT arg encoding', () => {
  it('round-trips plain args', () => {
    expect(roundTrip(['servers', 'list', '--json'])).toEqual(['servers', 'list', '--json']);
  });

  it('round-trips no args', () => {
    expect(roundTrip([])).toEqual([]);
  });

  it('survives quotes, backslashes, and JSON-hostile characters', () => {
    const args = ['say "hi"', 'back\\slash', '{"k":"v"}', "it's"];
    expect(roundTrip(args)).toEqual(args);
  });

  it('survives newlines and control characters', () => {
    const args = ['line1\nline2', 'tab\there', 'bell'];
    expect(roundTrip(args)).toEqual(args);
  });

  it('survives multi-byte utf-8', () => {
    const args = ['naïve — ✓', '日本語'];
    expect(roundTrip(args)).toEqual(args);
  });

  it('survives args long enough that base64 wraps its output (tr strips the newlines)', () => {
    const args = ['x'.repeat(200), 'n-and-\\backslash-'.repeat(10), 'word '.repeat(40).trim()];
    expect(roundTrip(args)).toEqual(args);
  });
});
