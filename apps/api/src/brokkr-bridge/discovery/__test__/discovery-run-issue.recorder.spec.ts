import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryRunIssueRecorder } from '../discovery-run-issue.recorder';

const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const makePrismaDouble = () => {
  const create = vi.fn().mockResolvedValue({});
  return {
    client: { discoveryRunIssue: { create } } as unknown as PrismaClient,
    create,
  };
};

describe('DiscoveryRunIssueRecorder', () => {
  beforeEach(() => {
    fakeLogger.log.mockClear();
    fakeLogger.warn.mockClear();
    fakeLogger.error.mockClear();
  });

  it('persists the issue row with collector identifier mapped through', async () => {
    const { client, create } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await recorder.record({
      runId: 'run-1',
      deviceId: 'dev-1',
      phase: 'SCHEMA',
      collector: 'lldp',
      code: 'PARSE_FAILED',
      severity: 'WARN',
      detail: { issues: [{ path: ['lldp', 'interface'], message: 'expected union' }] },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: 'run-1',
        phase: 'SCHEMA',
        collector: 'lldp',
        code: 'PARSE_FAILED',
        severity: 'WARN',
      }),
    });
  });

  it('uses composer name when collector is absent', async () => {
    const { client, create } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await recorder.record({
      runId: 'run-1',
      phase: 'COMPOSER',
      composer: 'tee',
      code: 'COMPOSER_THREW',
      severity: 'ERROR',
      detail: 'NVIDIA attestation unreachable',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ collector: 'tee', phase: 'COMPOSER', code: 'COMPOSER_THREW' }),
    });
  });

  it('routes severity to matching logger level', async () => {
    const { client } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await recorder.record({ runId: 'r', phase: 'INGRESS', code: 'OK', severity: 'INFO' });
    await recorder.record({ runId: 'r', phase: 'HANDLER', code: 'WARN_FIELD', severity: 'WARN' });
    await recorder.record({ runId: 'r', phase: 'COMMIT', code: 'COMMIT_FAILED', severity: 'ERROR' });

    expect(fakeLogger.log).toHaveBeenCalledTimes(1);
    expect(fakeLogger.warn).toHaveBeenCalledTimes(1);
    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
  });

  it('emits structured log line with correlation fields', async () => {
    const { client } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await recorder.record({
      runId: 'run-abc',
      deviceId: 'dev-xyz',
      phase: 'HANDLER',
      collector: 'nvidia',
      code: 'HANDLER_THREW',
      severity: 'ERROR',
    });

    const [logLine] = fakeLogger.error.mock.calls[0];
    expect(logLine).toMatch(
      /^discovery\.issue phase=HANDLER severity=ERROR code=HANDLER_THREW runId=run-abc deviceId=dev-xyz collector=nvidia$/,
    );
  });

  it('swallows DB write failures so the orchestrator keeps processing', async () => {
    const create = vi.fn().mockRejectedValue(new Error('connection refused'));
    const client = { discoveryRunIssue: { create } } as unknown as PrismaClient;
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await expect(
      recorder.record({ runId: 'r', phase: 'INGRESS', code: 'OK', severity: 'INFO' }),
    ).resolves.toBeUndefined();

    expect(fakeLogger.error).toHaveBeenCalledWith(expect.stringMatching(/failed to persist issue row/));
  });

  it('caps detail in log line at 1KB', async () => {
    const { client } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    const bigDetail = { blob: 'x'.repeat(5000) };
    await recorder.record({ runId: 'r', phase: 'SCHEMA', code: 'PARSE_FAILED', severity: 'WARN', detail: bigDetail });

    const [logLine] = fakeLogger.warn.mock.calls[0];
    expect(logLine.length).toBeLessThan(1200);
    expect(logLine).toMatch(/…$/);
  });

  it('recordMany fans out to record', async () => {
    const { client, create } = makePrismaDouble();
    const recorder = new DiscoveryRunIssueRecorder(client, fakeLogger);

    await recorder.recordMany([
      { runId: 'r', phase: 'SCHEMA', collector: 'a', code: 'PARSE_FAILED', severity: 'WARN' },
      { runId: 'r', phase: 'SCHEMA', collector: 'b', code: 'PARSE_FAILED', severity: 'WARN' },
    ]);

    expect(create).toHaveBeenCalledTimes(2);
  });
});
