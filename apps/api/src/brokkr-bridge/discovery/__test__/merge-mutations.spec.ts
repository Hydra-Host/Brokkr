import { describe, expect, it } from 'vitest';
import type { DeviceMutation } from '../collectors/collector.types';
import { mergeMutations } from '../merge-mutations';

describe('mergeMutations — pciDevicesPartial', () => {
  it('keeps the partial marker when a later collector says nothing about pci', () => {
    const buffered: DeviceMutation = { pciDevicesPartial: true };

    mergeMutations(buffered, { deviceUpdate: { architecture: 'x86_64' } });

    expect(buffered.pciDevicesPartial).toBe(true);
  });

  it('keeps the partial marker when a later mutation reports a complete bus', () => {
    const buffered: DeviceMutation = { pciDevicesPartial: true };

    mergeMutations(buffered, { pciDevicesPartial: false });

    expect(buffered.pciDevicesPartial).toBe(true);
  });

  it('raises the marker when any merged mutation is partial', () => {
    const buffered: DeviceMutation = { upserts: { pciDevices: [] } };

    mergeMutations(buffered, { pciDevicesPartial: true });

    expect(buffered.pciDevicesPartial).toBe(true);
  });

  it('leaves the marker unset when every mutation reported a complete bus', () => {
    const buffered: DeviceMutation = {};

    mergeMutations(buffered, { pciDevicesPartial: false });

    expect(buffered.pciDevicesPartial).toBeUndefined();
  });
});
