import { describe, expect, it } from 'vitest';
import { BareMetalNodeSchema, FleetPendingSchema, VerifyFindingKindSchema } from './schemas/fleet';

const legacyNode = {
  name: 'bm-1',
  bmc_ip: '10.10.0.5',
  bmc_mac: 'aa:bb:cc:dd:ee:01',
  pxe_mac: 'aa:bb:cc:dd:ee:02',
  arch: null,
  system_id: null,
};

describe('bare-metal contract shapes', () => {
  it('names the four bare-metal verify kinds and the stale-bake apply severity', () => {
    expect(VerifyFindingKindSchema.options).toEqual(
      expect.arrayContaining(['bmc-unreachable', 'bmc-auth-failed', 'no-hub-device', 'identity-split']),
    );
    expect(FleetPendingSchema.shape.severity.options).toContain('stale-bake');
  });

  it('round-trips a bare-metal node written before zone and network type existed', () => {
    expect(BareMetalNodeSchema.parse(legacyNode)).toEqual(legacyNode);
    expect(BareMetalNodeSchema.parse({ ...legacyNode, zone: 'sim-zone1', network_type: 'nat' })).toMatchObject({
      zone: 'sim-zone1',
      network_type: 'nat',
    });
  });
});
