import { describe, expect, it } from 'vitest';

import { AREA_SECTIONS, areaIsBuilt, KNOB_PREFIXES, knobAnchor, knobLocation } from './knob-location';

describe('knobLocation', () => {
  it('routes a hub env knob to the stack page under its own rail section', () => {
    expect(knobLocation('stackDefaults.hub.LOG_LEVEL')).toMatchObject({
      area: 'stack',
      route: '/config/stack',
      section: 'HUB',
    });
  });

  it('separates hub from spoke so the two service knob sets never share a section', () => {
    expect(knobLocation('stackDefaults.spoke.LOG_LEVEL')?.section).toBe('SPOKE');
    expect(knobLocation('stackDefaults.hub.LOG_LEVEL')?.section).toBe('HUB');
  });

  it('keeps every port on the stack page, derived ones included', () => {
    expect(knobLocation('ports.postgres')?.section).toBe('PORTS');
    expect(knobLocation('ports.grafana')?.section).toBe('PORTS');
  });

  it('prefers the longer prefix so stack.slot does not fall into the fleet rules', () => {
    expect(knobLocation('stack.slot')).toMatchObject({ area: 'stack', section: 'TOPOLOGY' });
  });

  it('sends a zone path to the zones page rather than the fleet page', () => {
    expect(knobLocation('fleet.zones."sim-zone".bridges')?.area).toBe('zones');
    expect(knobLocation('fleet.mode')?.area).toBe('fleet');
  });

  it('returns null for a path no editor owns yet', () => {
    expect(knobLocation('remoteInfra.enable')).toBeNull();
    expect(knobLocation('somethingBrandNew.flag')).toBeNull();
  });

  it('produces a fragment-safe anchor that survives dots and quotes', () => {
    expect(knobAnchor('identity.pg.user')).toBe('cfg-identity-pg-user');
    expect(knobAnchor('fleet.zones."sim-zone".bridges')).toBe('cfg-fleet-zones-sim-zone-bridges');
  });

  it('gives the same anchor to the deep link and the rail', () => {
    expect(knobLocation('ports.postgres')?.anchor).toBe(knobAnchor('ports.postgres'));
  });

  it('declares a rail section for every prefix the table can match', () => {
    for (const prefix of KNOB_PREFIXES) {
      const where = knobLocation(prefix);
      expect(where, prefix).not.toBeNull();
      expect(AREA_SECTIONS[where!.area], prefix).toContain(where!.section);
    }
  });
});

describe('areaIsBuilt', () => {
  it('reports the areas that have a route', () => {
    expect(areaIsBuilt('stack')).toBe(true);
    expect(areaIsBuilt('fleet')).toBe(true);
    expect(areaIsBuilt('zones')).toBe(true);
    expect(areaIsBuilt('advanced')).toBe(true);
  });

  it('reports every area as built, now that the last page exists', () => {
    expect(areaIsBuilt('advanced')).toBe(true);
  });

  it('answers for every area the classifier can return', () => {
    const areas = ['stackDefaults.hub.LOG_LEVEL', 'fleet.mode', 'fleet.zones.a.index', 'stackCounts.spoke']
      .map((p) => knobLocation(p)?.area)
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    expect(areas.every((a) => typeof areaIsBuilt(a) === 'boolean')).toBe(true);
  });
});

describe('knobLocation — the advanced area', () => {
  it('routes the behavioural forks to advanced, not to the service that names them', () => {
    expect(knobLocation('redisAcl.enable')?.area).toBe('advanced');
    expect(knobLocation('vrrpSim.enable')?.area).toBe('advanced');
    expect(knobLocation('stack.fleetNodeCount')?.area).toBe('advanced');
  });

  it('lets spoke.watch beat the bare spoke namespace, which belongs to the stack page', () => {
    expect(knobLocation('spoke.watch')?.area).toBe('advanced');
    expect(knobLocation('stackDefaults.spoke.LOG_LEVEL')?.area).toBe('stack');
  });

  it('files a spoke knob no reader consumes under INERT rather than under the spoke section', () => {
    expect(knobLocation('stackDefaults.spoke.AGENT_SSH_FORCE_REDEPLOY')).toMatchObject({
      area: 'advanced',
      section: 'INERT',
    });
    expect(knobLocation('stackDefaults.spoke.ANALYTICS_ENABLED')?.section).toBe('INERT');
  });

  it('routes the security keys and the checkout to their own sections', () => {
    expect(knobLocation('zoneCrypto.hubPrivateKey')?.section).toBe('ZONE CRYPTO');
    expect(knobLocation('polyrepo.hub.path')?.section).toBe('CHECKOUT');
  });

  it('names every section its rules can return, so no knob lands in a rail entry that is absent', () => {
    const sections = new Set(
      [
        'redisAcl.enable',
        'vrrpSim.enable',
        'spoke.watch',
        'stack.fleetNodeCount',
        'zoneCrypto.hubPrivateKey',
        'polyrepo.hub.path',
        'stackCounts.spoke',
      ]
        .map((path) => knobLocation(path)?.section)
        .filter((section): section is string => section !== undefined),
    );
    for (const section of sections) expect(AREA_SECTIONS.advanced).toContain(section);
  });
});

describe('knobLocation — completeness against the raw namespace', () => {
  it('owns every path family the catalog publishes, so none falls into the residue', () => {
    const catalogued = [
      'stackDefaults.hub.LOG_LEVEL',
      'stackDefaults.spoke.BRIDGE_SYNC_ENABLED',
      'identity.pg.user',
      'identity.orgId',
      'ports.postgres',
      'osLayerCache.resolvers',
      'lan.expose',
      'telemetry.enable',
      'stack.slot',
      'stack.fleetNodeCount',
      'stackCounts.spoke',
      'spoke.watch',
      'redisAcl.enable',
      'vrrpSim.enable',
      'zoneCrypto.hubPrivateKey',
      'zoneCrypto.bridgeAtRestKey',
      'polyrepo.hub.path',
      'polyrepo.hub.url',
      'fleet.mode',
      'fleet.autoStart',
      'fleet.zones."sim-zone".index',
    ];
    expect(catalogued.filter((path) => knobLocation(path) === null)).toEqual([]);
  });

  it('does not classify the stripped namespace the api stopped using', () => {
    expect(knobLocation('hub.LOG_LEVEL')).toBeNull();
    expect(knobLocation('spoke.LIFECYCLE_WORKER_CONCURRENCY')).toBeNull();
  });
});
