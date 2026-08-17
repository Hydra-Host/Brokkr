import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import type { OperationInput, OperationOutput } from '@repo/bridge-agent-protocol';
import type { HandlerContext } from '../../dispatch/registry';
import { registerOperation } from '../../dispatch/registry';
import { scheduleExit } from './upgrade-exit';

type UpgradeInput = OperationInput<'agent.upgrade'>;
type UpgradeOutput = OperationOutput<'agent.upgrade'>;

const BUNDLE_TARGET = '/opt/brokkr/agent/main.js';
const UNIT_TARGET = '/etc/systemd/system/brokkr-bridge-agent.service';
const CONFIG_TARGET = '/opt/brokkr/agent.yaml';

async function drainAndVerify(
  chunks: AsyncIterable<Uint8Array>,
  expectedSha: string,
  kind: 'bundle' | 'unit' | 'config',
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) {
    parts.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(parts);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha) {
    throw new Error(`SHA256_MISMATCH: ${kind} expected ${expectedSha}, got ${actual}`);
  }
  return bytes;
}

async function atomicWriteAndSwap(target: string, bytes: Buffer, mode: number): Promise<void> {
  const tmp = `${target}.new`;
  let renamed = false;
  try {
    await fs.writeFile(tmp, bytes, { mode });
    await fs.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
}

export async function handleAgentUpgrade(input: UpgradeInput, ctx: HandlerContext): Promise<UpgradeOutput> {
  const startMs = Date.now();

  if (!ctx.fetchArtifact) {
    throw new Error('FETCH_UNAVAILABLE: agent.upgrade requires ctx.fetchArtifact (no active gRPC session?)');
  }

  let bytes: Buffer;
  try {
    bytes = await drainAndVerify(ctx.fetchArtifact(input.sha256, 'bundle'), input.sha256, 'bundle');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SHA256_MISMATCH')) {
      throw error;
    }
    throw new Error(`DOWNLOAD_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await atomicWriteAndSwap(BUNDLE_TARGET, bytes, 0o600);
  } catch (error) {
    throw new Error(`DISK_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  let unitReplaced = false;
  if (input.unit_sha256) {
    let unitBytes: Buffer;
    try {
      unitBytes = await drainAndVerify(ctx.fetchArtifact(input.unit_sha256, 'unit'), input.unit_sha256, 'unit');
    } catch (error) {
      throw new Error(`UNIT_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await atomicWriteAndSwap(UNIT_TARGET, unitBytes, 0o644);
      unitReplaced = true;
    } catch (error) {
      throw new Error(`UNIT_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let configReplaced = false;
  if (input.config_sha256) {
    let configBytes: Buffer;
    try {
      configBytes = await drainAndVerify(
        ctx.fetchArtifact(input.config_sha256, 'config'),
        input.config_sha256,
        'config',
      );
    } catch (error) {
      throw new Error(`CONFIG_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 0o600: agent.yaml carries secrets; must match the SSH-bootstrap path's chmod.
    try {
      await atomicWriteAndSwap(CONFIG_TARGET, configBytes, 0o600);
      configReplaced = true;
    } catch (error) {
      throw new Error(`CONFIG_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  scheduleExit(unitReplaced, ctx.resultDelivered);

  return {
    bundle_bytes: bytes.length,
    sha256_verified: true,
    unit_replaced: unitReplaced,
    config_replaced: configReplaced,
    restart_scheduled_at_ms: startMs,
  };
}

export function registerAgentUpgrade(): void {
  registerOperation('agent.upgrade', handleAgentUpgrade);
}
