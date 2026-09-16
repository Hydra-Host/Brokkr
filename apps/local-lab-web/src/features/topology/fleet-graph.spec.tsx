// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FleetGraph } from './fleet-graph';
import type { TopologyBareMetalNode, TopologyModel, TopologyVmNode, TopologyZone } from './fleet-topology';

afterEach(cleanup);

const node = (name: string, over: Partial<TopologyVmNode> = {}): TopologyVmNode => ({
  kind: 'vm',
  name,
  zone: 'sim-zone',
  cpus: 4,
  memoryMb: 8192,
  diskGb: 40,
  arch: 'amd64',
  power: 'on',
  deviceId: null,
  ...over,
});

const metal = (name: string, over: Partial<TopologyBareMetalNode> = {}): TopologyBareMetalNode => ({
  kind: 'baremetal',
  name,
  zone: 'sim-zone',
  arch: 'amd64',
  bmcIp: '192.168.1.50',
  power: 'off',
  deviceId: null,
  ...over,
});

const zone = (over: Partial<TopologyZone> = {}): TopologyZone => ({
  name: 'sim-zone',
  index: 0,
  uuid: 'uuid-0',
  ordinals: [0],
  bridges: [{ proc: 'spoke', port: 8000, grpc: 9082, online: true, leader: true }],
  nodes: [node('cpu-1')],
  health: 'ok',
  healthReason: 'leader spoke',
  seeded: true,
  ...over,
});

const model = (over: Partial<TopologyModel> = {}): TopologyModel => ({
  zones: [zone()],
  orphanNodes: [],
  adoptable: [],
  hubOnly: [],
  capacity: { used: 1, total: 47 },
  trustworthy: true,
  loading: false,
  readErrors: [],
  ...over,
});

describe('FleetGraph', () => {
  it('draws the zone, its bridge and its node together', () => {
    render(<FleetGraph model={model()} />);

    expect(screen.getByText(/sim-zone · idx 0/)).toBeTruthy();
    expect(screen.getByText(/spoke :8000\/:9082/)).toBeTruthy();
    expect(screen.getByText('cpu-1')).toBeTruthy();
  });

  it('states the capacity the zones consume', () => {
    render(<FleetGraph model={model()} />);

    expect(screen.getByText(/1 of 47 bridge ordinals used/)).toBeTruthy();
  });

  it('says why a zone is unknown rather than drawing it as healthy', () => {
    render(<FleetGraph model={model({ zones: [zone({ health: 'unknown', healthReason: 'zone read failed' })] })} />);

    expect(screen.getByLabelText(/zone sim-zone — zone read failed/)).toBeTruthy();
  });

  it('reads a node with no live answer as unknown, not off', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [node('cpu-1', { power: null })] })] })} />);

    expect(screen.getByLabelText(/cpu-1: no live answer covered this node/)).toBeTruthy();
  });

  it('names a node whose zone nothing declares, and why', () => {
    render(<FleetGraph model={model({ orphanNodes: [node('old-1', { zone: 'sim-zone0' })] })} />);

    expect(screen.getByText('old-1 → sim-zone0')).toBeTruthy();
    expect(screen.getByText(/a rename leaves this behind/)).toBeTruthy();
  });

  it('names a node that carries no zone at all without a dangling arrow', () => {
    render(<FleetGraph model={model({ orphanNodes: [metal('metal-1', { zone: '' })] })} />);

    expect(screen.getByRole('button', { name: 'metal-1' })).toBeTruthy();
  });

  it('names a running domain the config does not carry', () => {
    render(<FleetGraph model={model({ adoptable: ['stray'] })} />);

    expect(screen.getByText('stray')).toBeTruthy();
    expect(screen.getByText(/a rebuild would adopt it/)).toBeTruthy();
  });

  it('says the graph is incomplete when a read failed', () => {
    render(<FleetGraph model={model({ trustworthy: false, readErrors: ['hub zone rows unread'] })} />);

    expect(screen.getByText(/this graph is incomplete — hub zone rows unread/)).toBeTruthy();
  });

  it('asks for a zone rather than drawing an empty canvas', () => {
    render(<FleetGraph model={model({ zones: [] })} />);

    expect(screen.getByText(/no zones declared/)).toBeTruthy();
  });

  it('marks a zone with no nodes instead of leaving the lane blank', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [] })] })} />);

    expect(screen.getByText(/no nodes — add one below/)).toBeTruthy();
  });

  it('hands the zone name back when its header is clicked', () => {
    const onSelectZone = vi.fn();
    render(<FleetGraph model={model()} onSelectZone={onSelectZone} />);

    fireEvent.click(screen.getByRole('button', { name: /^zone sim-zone/ }));

    expect(onSelectZone).toHaveBeenCalledWith('sim-zone');
  });

  it('hands an orphan node name back without its zone suffix', () => {
    const onSelectNode = vi.fn();
    render(
      <FleetGraph model={model({ orphanNodes: [node('old-1', { zone: 'gone' })] })} onSelectNode={onSelectNode} />,
    );

    fireEvent.click(screen.getByText('old-1 → gone'));

    expect(onSelectNode).toHaveBeenCalledWith('old-1');
  });
});

describe('FleetGraph — bare-metal tiles', () => {
  const dashOf = (label: RegExp): string | null | undefined =>
    screen.getByRole('button', { name: label }).querySelector('rect')?.getAttribute('stroke-dasharray');

  it('marks a bare-metal tile and names its bmc', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [node('cpu-1'), metal('metal-1')] })] })} />);

    expect(screen.getByLabelText('node metal-1 in zone sim-zone, bare metal')).toBeTruthy();
    expect(screen.getByText('bare metal')).toBeTruthy();
    expect(screen.getByText('bmc 192.168.1.50 · amd64')).toBeTruthy();
  });

  it('draws the bare-metal tile dashed and the vm tile solid', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [node('cpu-1'), metal('metal-1')] })] })} />);

    expect(dashOf(/^node metal-1/)).toBe('3 2');
    expect(dashOf(/^node cpu-1/)).toBeNull();
  });

  it('does not call a lane with only bare-metal nodes empty', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [metal('metal-1')] })] })} />);

    expect(screen.queryByText(/no nodes — add one below/)).toBeNull();
  });

  it('reads a bare-metal power state from its dot', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [metal('metal-1', { power: 'off' })] })] })} />);

    expect(screen.getByLabelText('metal-1: power off')).toBeTruthy();
  });

  it('says when a bare-metal machine has no bmc address yet', () => {
    render(<FleetGraph model={model({ zones: [zone({ nodes: [metal('metal-1', { bmcIp: null })] })] })} />);

    expect(screen.getByText('bmc unset · amd64')).toBeTruthy();
  });

  it('hands a bare-metal node name back when its tile is activated', () => {
    const onSelectNode = vi.fn();
    render(<FleetGraph model={model({ zones: [zone({ nodes: [metal('metal-1')] })] })} onSelectNode={onSelectNode} />);

    fireEvent.click(screen.getByRole('button', { name: /^node metal-1/ }));

    expect(onSelectNode).toHaveBeenCalledWith('metal-1');
  });

  it('keeps the vm tile line as it was', () => {
    render(<FleetGraph model={model()} />);

    expect(screen.getByLabelText('node cpu-1 in zone sim-zone')).toBeTruthy();
    expect(screen.getByText('4c · 8G · 40G · amd64')).toBeTruthy();
    expect(dashOf(/^node cpu-1/)).toBeNull();
    expect(screen.queryByText('bare metal')).toBeNull();
  });
});

describe('FleetGraph — the graph is reachable without a mouse', () => {
  it('puts an interactive zone in the tab order and activates it on Enter', () => {
    const onSelectZone = vi.fn();
    render(<FleetGraph model={model()} onSelectZone={onSelectZone} />);

    const zoneButton = screen.getByRole('button', { name: /^zone sim-zone/ });
    expect(zoneButton.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(zoneButton, { key: 'Enter' });

    expect(onSelectZone).toHaveBeenCalledWith('sim-zone');
  });

  it('activates a node on Space as well as a click', () => {
    const onSelectNode = vi.fn();
    render(<FleetGraph model={model()} onSelectNode={onSelectNode} />);

    fireEvent.keyDown(screen.getByRole('button', { name: /^node cpu-1/ }), { key: ' ' });

    expect(onSelectNode).toHaveBeenCalledWith('cpu-1');
  });

  it('leaves a non-interactive zone out of the tab order rather than focusing to do nothing', () => {
    render(<FleetGraph model={model()} />);

    expect(screen.getByRole('button', { name: /^zone sim-zone/ }).getAttribute('tabindex')).toBe('-1');
  });
});
