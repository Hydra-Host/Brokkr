import { describe, expect, it } from 'vitest';

import { buildBridgeInventory, type ConfiguredBridge } from '../bridge-inventory';
import type { PresenceRecord } from '../leader.reader';

const NOW = 1_700_000_000_000;
const seconds = (ms: number) => String(ms / 1000);

const record = (instanceId: string, over: Record<string, string> = {}): PresenceRecord => ({
  instanceId,
  hash: {
    instance_id: instanceId,
    is_leader: 'False',
    registered_at: seconds(NOW - 2_000),
    ...over,
  },
});

const configured = (instanceId: string, port = 8000, grpcPort = 9082): ConfiguredBridge => ({
  instanceId,
  port,
  grpcPort,
});

describe('buildBridgeInventory', () => {
  it('marks a registered and configured bridge as both, carrying its ports', () => {
    const [row] = buildBridgeInventory([record('spoke')], [configured('spoke', 8000, 9082)], NOW);

    expect(row).toMatchObject({
      instanceId: 'spoke',
      expected: true,
      registered: true,
      online: true,
      isLeader: false,
      port: 8000,
      grpcPort: 9082,
    });
  });

  it('keeps a configured bridge that never registered, as the ha symptom it is', () => {
    const [row] = buildBridgeInventory([], [configured('spoke-2')], NOW);

    expect(row).toMatchObject({ instanceId: 'spoke-2', expected: true, registered: false });
    expect(row.online).toBeNull();
    expect(row.isLeader).toBeNull();
  });

  it('keeps a registered bridge the stack config does not declare, rather than filtering it out', () => {
    const rows = buildBridgeInventory([record('orphan')], [], NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instanceId: 'orphan', expected: false, registered: true });
  });

  it('unions both sides without duplicating a bridge present in each', () => {
    const rows = buildBridgeInventory(
      [record('spoke'), record('orphan')],
      [configured('spoke'), configured('spoke-2')],
      NOW,
    );

    expect(rows.map((row) => row.instanceId)).toEqual(['orphan', 'spoke', 'spoke-2']);
  });

  it('reads a stale presence record as offline even though its key still exists', () => {
    const [row] = buildBridgeInventory([record('spoke', { registered_at: seconds(NOW - 60_000) })], [], NOW);

    expect(row.registered).toBe(true);
    expect(row.online).toBe(false);
  });

  it('does not read a lowercase leader flag as leader', () => {
    const [row] = buildBridgeInventory([record('spoke', { is_leader: 'true' })], [], NOW);

    expect(row.isLeader).toBeNull();
  });

  it('leaves interfaces undetermined when the record carried none', () => {
    const [row] = buildBridgeInventory([record('spoke')], [], NOW);

    expect(row.interfaces).toBeNull();
    expect(row.plugins).toBeNull();
  });

  it('distinguishes a bridge reporting no interfaces from one reporting none readably', () => {
    const [empty] = buildBridgeInventory([record('spoke', { interfaces_json: '[]' })], [], NOW);
    const [broken] = buildBridgeInventory([record('spoke', { interfaces_json: 'not-json' })], [], NOW);

    expect(empty.interfaces).toEqual([]);
    expect(broken.interfaces).toBeNull();
  });
});
