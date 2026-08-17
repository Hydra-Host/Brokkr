import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTftpJobId, logServerStatus, setTftpJobId } from '../tftp-log-handler.js';

beforeEach(() => {
  setTftpJobId('');
});

afterEach(() => {
  setTftpJobId('');
  vi.restoreAllMocks();
});

describe('setTftpJobId / getTftpJobId', () => {
  it('mutates module-level job id', () => {
    setTftpJobId('global-test-job');
    expect(getTftpJobId()).toBe('global-test-job');
  });
});

describe('logServerStatus', () => {
  let writes: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    writes = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('logs at info level with TFTP Server prefix', async () => {
    await logServerStatus('Test info message', 'info');
    const merged = writes.join('');
    expect(merged).toContain('TFTP Server: Test info message');
    expect(merged).toContain('"log_level": "info"');
  });

  it('logs warnings via logWarning', async () => {
    await logServerStatus('Test warning message', 'warning');
    const merged = writes.join('');
    expect(merged).toContain('TFTP Server: Test warning message');
    expect(merged).toContain('"log_level": "warning"');
  });

  it('logs errors via logError', async () => {
    await logServerStatus('Test error message', 'error');
    const merged = writes.join('');
    expect(merged).toContain('TFTP Server: Test error message');
    expect(merged).toContain('"log_level": "error"');
  });

  it('routes debug level through logDebug (filtered below INFO threshold)', async () => {
    await expect(logServerStatus('Test debug message', 'debug')).resolves.toBeUndefined();
  });

  it('falls back to info for an unknown level', async () => {
    await logServerStatus('Test message', 'unknown');
    const merged = writes.join('');
    expect(merged).toContain('TFTP Server: Test message');
    expect(merged).toContain('"log_level": "info"');
  });
});
