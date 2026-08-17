import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  default: { writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn() },
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('.././upgrade-exit', () => ({
  scheduleExit: vi.fn(),
  daemonReload: vi.fn(),
}));

import fs from 'node:fs/promises';
import type { HandlerContext } from '../../../dispatch/registry';
import { handleAgentUpgrade } from '.././upgrade';
import { scheduleExit } from '.././upgrade-exit';

const writeFile = vi.mocked(fs.writeFile);
const rename = vi.mocked(fs.rename);
const unlink = vi.mocked(fs.unlink);
const scheduleExitMock = vi.mocked(scheduleExit);

const BUNDLE = Buffer.from("console.log('hi')\n");
const SHA = crypto.createHash('sha256').update(BUNDLE).digest('hex');
const UNIT = Buffer.from('[Unit]\nDescription=bridge-agent\n');
const UNIT_SHA = crypto.createHash('sha256').update(UNIT).digest('hex');
const CONFIG = Buffer.from('device_id: "42"\nzone_id: "00000000-0000-4000-8000-000000000001"\n');
const CONFIG_SHA = crypto.createHash('sha256').update(CONFIG).digest('hex');

function streamOf(buf: Buffer): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new Uint8Array(buf);
  })();
}

function mkCtx(
  opts: {
    signal?: AbortSignal;
    fetchArtifact?: HandlerContext['fetchArtifact'];
  } = {},
): HandlerContext {
  const base: HandlerContext = {
    work_id: 'w1',
    job_id: 'j1',
    signal: opts.signal ?? new AbortController().signal,
    resultDelivered: Promise.resolve(),
    reportProgress: vi.fn(),
    emit: vi.fn(),
  };
  return opts.fetchArtifact ? { ...base, fetchArtifact: opts.fetchArtifact } : base;
}

beforeEach(() => {
  vi.restoreAllMocks();
  writeFile.mockReset();
  rename.mockReset();
  unlink.mockReset();
  unlink.mockResolvedValue(undefined);
  scheduleExitMock.mockReset();
});

describe('agent.upgrade', () => {
  it('streams, verifies, renames, and returns success', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const out = await handleAgentUpgrade(
      { sha256: SHA, expected_version: 'v2' },
      mkCtx({ fetchArtifact: () => streamOf(BUNDLE) }),
    );

    expect(out.bundle_bytes).toBe(BUNDLE.length);
    expect(out.sha256_verified).toBe(true);
    expect(out.unit_replaced).toBe(false);
    expect(typeof out.restart_scheduled_at_ms).toBe('number');
    expect(writeFile).toHaveBeenCalledWith('/opt/brokkr/agent/main.js.new', expect.any(Buffer), { mode: 0o600 });
    expect(rename).toHaveBeenCalledWith('/opt/brokkr/agent/main.js.new', '/opt/brokkr/agent/main.js');
    expect(scheduleExitMock).toHaveBeenCalledWith(false, expect.any(Promise));
  });

  it('throws FETCH_UNAVAILABLE when ctx has no fetchArtifact', async () => {
    await expect(handleAgentUpgrade({ sha256: SHA, expected_version: 'v2' }, mkCtx())).rejects.toThrow(
      /FETCH_UNAVAILABLE/,
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('throws SHA256_MISMATCH without writing when hash differs', async () => {
    await expect(
      handleAgentUpgrade(
        { sha256: 'f'.repeat(64), expected_version: 'v2' },
        mkCtx({ fetchArtifact: () => streamOf(BUNDLE) }),
      ),
    ).rejects.toThrow(/SHA256_MISMATCH/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('throws DOWNLOAD_FAILED when the stream errors mid-read', async () => {
    const broken: AsyncIterable<Uint8Array> = (async function* () {
      yield new Uint8Array(Buffer.from('partial'));
      throw new Error('stream reset');
    })();
    await expect(
      handleAgentUpgrade({ sha256: SHA, expected_version: 'v2' }, mkCtx({ fetchArtifact: () => broken })),
    ).rejects.toThrow(/DOWNLOAD_FAILED/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('throws DISK_WRITE_FAILED when writeFile errors', async () => {
    writeFile.mockRejectedValue(new Error('ENOSPC'));

    await expect(
      handleAgentUpgrade({ sha256: SHA, expected_version: 'v2' }, mkCtx({ fetchArtifact: () => streamOf(BUNDLE) })),
    ).rejects.toThrow(/DISK_WRITE_FAILED/);
  });

  it('throws SHA256_MISMATCH on the unit artifact without writing either file', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const fetchArtifact: HandlerContext['fetchArtifact'] = (_sha, artifact) =>
      streamOf(artifact === 'unit' ? UNIT : BUNDLE);

    await expect(
      handleAgentUpgrade(
        { sha256: SHA, expected_version: 'v2', unit_sha256: 'f'.repeat(64) },
        mkCtx({ fetchArtifact }),
      ),
    ).rejects.toThrow(/SHA256_MISMATCH/);

    expect(rename).not.toHaveBeenCalledWith(
      '/etc/systemd/system/brokkr-bridge-agent.service.new',
      '/etc/systemd/system/brokkr-bridge-agent.service',
    );
  });

  it('also swaps the systemd unit when unit_sha256 is provided', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const fetchArtifact: HandlerContext['fetchArtifact'] = (_sha, artifact) =>
      streamOf(artifact === 'unit' ? UNIT : BUNDLE);

    const out = await handleAgentUpgrade(
      { sha256: SHA, expected_version: 'v2', unit_sha256: UNIT_SHA },
      mkCtx({ fetchArtifact }),
    );

    expect(out.unit_replaced).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/etc/systemd/system/brokkr-bridge-agent.service.new', expect.any(Buffer), {
      mode: 0o644,
    });
    expect(rename).toHaveBeenCalledWith(
      '/etc/systemd/system/brokkr-bridge-agent.service.new',
      '/etc/systemd/system/brokkr-bridge-agent.service',
    );
    expect(scheduleExitMock).toHaveBeenCalledWith(true, expect.any(Promise));
  });

  it('config_replaced defaults to false when no config_sha256 is provided', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const out = await handleAgentUpgrade(
      { sha256: SHA, expected_version: 'v2' },
      mkCtx({ fetchArtifact: () => streamOf(BUNDLE) }),
    );
    expect(out.config_replaced).toBe(false);
  });

  it('atomically swaps agent.yaml when config_sha256 is provided (0o600)', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const fetchArtifact: HandlerContext['fetchArtifact'] = (_sha, artifact) =>
      streamOf(artifact === 'config' ? CONFIG : BUNDLE);

    const out = await handleAgentUpgrade(
      { sha256: SHA, expected_version: 'v2', config_sha256: CONFIG_SHA },
      mkCtx({ fetchArtifact }),
    );

    expect(out.config_replaced).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/opt/brokkr/agent.yaml.new', expect.any(Buffer), { mode: 0o600 });
    expect(rename).toHaveBeenCalledWith('/opt/brokkr/agent.yaml.new', '/opt/brokkr/agent.yaml');
  });

  it('throws SHA256_MISMATCH on the config artifact without writing it', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const fetchArtifact: HandlerContext['fetchArtifact'] = (_sha, artifact) =>
      streamOf(artifact === 'config' ? CONFIG : artifact === 'unit' ? UNIT : BUNDLE);

    await expect(
      handleAgentUpgrade(
        { sha256: SHA, expected_version: 'v2', config_sha256: 'f'.repeat(64) },
        mkCtx({ fetchArtifact }),
      ),
    ).rejects.toThrow(/CONFIG_WRITE_FAILED|SHA256_MISMATCH/);
    expect(rename).not.toHaveBeenCalledWith('/opt/brokkr/agent.yaml.new', '/opt/brokkr/agent.yaml');
  });

  it('swaps all three artifacts (bundle + unit + config) in a single upgrade', async () => {
    writeFile.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);

    const fetchArtifact: HandlerContext['fetchArtifact'] = (_sha, artifact) =>
      streamOf(artifact === 'unit' ? UNIT : artifact === 'config' ? CONFIG : BUNDLE);

    const out = await handleAgentUpgrade(
      {
        sha256: SHA,
        expected_version: 'v2',
        unit_sha256: UNIT_SHA,
        config_sha256: CONFIG_SHA,
      },
      mkCtx({ fetchArtifact }),
    );

    expect(out.unit_replaced).toBe(true);
    expect(out.config_replaced).toBe(true);
    expect(rename).toHaveBeenCalledWith('/opt/brokkr/agent/main.js.new', '/opt/brokkr/agent/main.js');
    expect(rename).toHaveBeenCalledWith(
      '/etc/systemd/system/brokkr-bridge-agent.service.new',
      '/etc/systemd/system/brokkr-bridge-agent.service',
    );
    expect(rename).toHaveBeenCalledWith('/opt/brokkr/agent.yaml.new', '/opt/brokkr/agent.yaml');
  });
});
