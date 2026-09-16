import type { BareMetalNode } from '@repo/local-lab-contract';
import { describe, expect, it } from 'vitest';

import { bmDeviceUuid, simDeviceUuid } from '../../common/hub-client';
import { resolveRoster } from '../fleet-roster';

const bmNode = (over: Partial<BareMetalNode> & { name: string }): BareMetalNode => ({
  bmc_ip: '10.10.0.5',
  bmc_mac: 'aa:bb:cc:dd:ee:01',
  pxe_mac: 'aa:bb:cc:dd:ee:02',
  arch: null,
  system_id: null,
  ...over,
});

describe('resolveRoster', () => {
  it('derives vm device ids from the flat node index', () => {
    expect(resolveRoster({ vmNodeNames: () => ['node1', 'node2'], baremetalNodes: () => [] })).toEqual([
      { name: 'node1', kind: 'vm', deviceId: simDeviceUuid(0), pxeMac: null, bmcIp: null, zone: null, systemId: null },
      { name: 'node2', kind: 'vm', deviceId: simDeviceUuid(1), pxeMac: null, bmcIp: null, zone: null, systemId: null },
    ]);
  });

  it('derives bare-metal device ids from the pxe mac and carries bmc ip and zone', () => {
    expect(
      resolveRoster({
        vmNodeNames: () => [],
        baremetalNodes: () => [bmNode({ name: 'bm-1', pxe_mac: '00:00:5e:00:53:b4', zone: 'sim-zone1' })],
      }),
    ).toEqual([
      {
        name: 'bm-1',
        kind: 'baremetal',
        deviceId: bmDeviceUuid('00:00:5e:00:53:b4'),
        pxeMac: '00:00:5e:00:53:b4',
        bmcIp: '10.10.0.5',
        zone: 'sim-zone1',
        systemId: null,
      },
    ]);
  });

  it('concatenates vm rows before bare-metal rows when both rosters carry entries', () => {
    const roster = resolveRoster({
      vmNodeNames: () => ['node1', 'node2'],
      baremetalNodes: () => [bmNode({ name: 'bm-1' }), bmNode({ name: 'bm-2', pxe_mac: '00:00:5e:00:53:b5' })],
    });

    expect(roster.map((n) => [n.name, n.kind])).toEqual([
      ['node1', 'vm'],
      ['node2', 'vm'],
      ['bm-1', 'baremetal'],
      ['bm-2', 'baremetal'],
    ]);
    expect(roster.map((n) => n.deviceId)).toEqual([
      simDeviceUuid(0),
      simDeviceUuid(1),
      bmDeviceUuid('aa:bb:cc:dd:ee:02'),
      bmDeviceUuid('00:00:5e:00:53:b5'),
    ]);
  });

  it('returns the bare-metal roster alone when no vm node is enabled', () => {
    const roster = resolveRoster({ vmNodeNames: () => [], baremetalNodes: () => [bmNode({ name: 'bm-1' })] });

    expect(roster.map((n) => n.kind)).toEqual(['baremetal']);
  });

  it('returns an empty roster when both planes are off', () => {
    expect(resolveRoster({ vmNodeNames: () => [], baremetalNodes: () => [] })).toEqual([]);
  });

  it('drops a bare-metal machine with a blank pxe mac, whose device id would not be derivable', () => {
    const roster = resolveRoster({
      vmNodeNames: () => [],
      baremetalNodes: () => [bmNode({ name: 'bm-blank', pxe_mac: '   ' }), bmNode({ name: 'bm-ok' })],
    });

    expect(roster.map((n) => n.name)).toEqual(['bm-ok']);
  });

  it('reports null zone and null bmc ip for a machine written before zone existed', () => {
    const [node] = resolveRoster({
      vmNodeNames: () => [],
      baremetalNodes: () => [bmNode({ name: 'bm-legacy', bmc_ip: '' })],
    });

    expect(node).toMatchObject({ zone: null, bmcIp: null });
  });

  it('carries the bare-metal system id into the roster', () => {
    const [node] = resolveRoster({
      vmNodeNames: () => [],
      baremetalNodes: () => [bmNode({ name: 'bm-1', system_id: 'System.Embedded.1' })],
    });

    expect(node).toMatchObject({ systemId: 'System.Embedded.1' });
  });
});
