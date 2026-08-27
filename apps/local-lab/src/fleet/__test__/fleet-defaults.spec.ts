import { describe, expect, it } from 'vitest';

import { FleetDefaultsSchema, FleetNodeEffectiveSchema, FleetNodeSchema } from '@repo/local-lab-contract';

describe('fleet defaults on the wire', () => {
  it('lets a node leave a size field unset so it can inherit', () => {
    const parsed = FleetNodeEffectiveSchema.parse({
      name: 'cpu-1',
      zone: 'sim-zone',
      ipmi_mac: 'aa:bb:cc:00:00:01',
      data_mac: 'aa:bb:cc:00:00:02',
      cpus: null,
      memory_mb: null,
      disk_gb: null,
      disks: [],
      passthrough: [],
      nics: [],
      data_mtu: null,
      arch: null,
      network_type: null,
      ip: null,
      bmc_ip: null,
      bmc: null,
      effective_ip: '192.168.200.10',
      effective_bmc_ip: '192.168.105.10',
      effective_cpus: 2,
      effective_memory_mb: 4096,
      effective_disk_gb: 40,
    });

    expect(parsed.cpus).toBeNull();
    expect(parsed.effective_cpus).toBe(2);
  });

  it('carries a null default so clearing one is expressible', () => {
    expect(FleetDefaultsSchema.parse({ cpus: null, memory_mb: 8192, disk_gb: null, arch: null })).toEqual({
      cpus: null,
      memory_mb: 8192,
      disk_gb: null,
      arch: null,
    });
  });

  it('refuses a size that is not a positive integer', () => {
    expect(() => FleetDefaultsSchema.parse({ cpus: 0, memory_mb: null, disk_gb: null, arch: null })).toThrow();
    expect(() => FleetDefaultsSchema.parse({ cpus: 1.5, memory_mb: null, disk_gb: null, arch: null })).toThrow();
  });
});

describe('the derived fields never reach the overlay', () => {
  it('names every effective_ field, so a new one cannot be forgotten in the strip', () => {
    const derived = Object.keys(FleetNodeEffectiveSchema.shape).filter((k) => k.startsWith('effective_'));
    expect(derived.sort()).toEqual([
      'effective_bmc_ip',
      'effective_cpus',
      'effective_disk_gb',
      'effective_ip',
      'effective_memory_mb',
    ]);
    expect(Object.keys(FleetNodeSchema.shape).filter((k) => k.startsWith('effective_'))).toEqual([]);
  });
});
