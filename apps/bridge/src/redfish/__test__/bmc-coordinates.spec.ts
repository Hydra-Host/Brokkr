import { describe, expect, it } from 'vitest';

import { bmcCoordinates, redfishProbeCoordinates } from '../bmc-coordinates.js';
import { buildRedfishConfig } from '../redfish.config.js';

const SIM_ENV = { LOCAL_SIMULATION_ENABLED: 'true' };
const SIM_CIDR_ENV = { ...SIM_ENV, SIM_BMC_CIDR: '192.168.105.0/24' };
const REAL_BMC = { protocol: 'https', port: 443 };
const SIM_BMC = { protocol: 'http', port: 8443 };

describe('bmcCoordinates', () => {
  it('uses http on the simulated port when simulation is enabled and no cidr is set', () => {
    expect(bmcCoordinates('10.0.0.5', SIM_ENV)).toEqual(SIM_BMC);
  });

  it('honors SIM_REDFISH_PORT for the simulated coordinate', () => {
    expect(bmcCoordinates('10.0.0.5', { ...SIM_ENV, SIM_REDFISH_PORT: '9001' })).toEqual({
      protocol: 'http',
      port: 9001,
    });
  });

  it('honors NETWORK_REDFISH_PORT for the real coordinate', () => {
    expect(bmcCoordinates('10.0.0.5', { NETWORK_REDFISH_PORT: '8444', LOCAL_SIMULATION_ENABLED: 'false' })).toEqual({
      protocol: 'https',
      port: 8444,
    });
  });

  it('uses http on the simulated port for an address inside the simulated bmc cidr', () => {
    expect(bmcCoordinates('192.168.105.9', SIM_CIDR_ENV)).toEqual(SIM_BMC);
  });

  it('uses https 443 for an address outside the simulated bmc cidr', () => {
    expect(bmcCoordinates('10.0.0.5', SIM_CIDR_ENV)).toEqual({ protocol: 'https', port: 443 });
  });

  it('uses https 443 when simulation is disabled, even inside the cidr', () => {
    expect(bmcCoordinates('10.0.0.5', { LOCAL_SIMULATION_ENABLED: 'false' })).toEqual({ protocol: 'https', port: 443 });
    expect(bmcCoordinates('192.168.105.9', { ...SIM_CIDR_ENV, LOCAL_SIMULATION_ENABLED: 'false' })).toEqual(REAL_BMC);
  });

  it('uses https 443 for every address when the cidr is malformed', () => {
    expect(bmcCoordinates('192.168.105.9', { ...SIM_ENV, SIM_BMC_CIDR: 'not-a-cidr' })).toEqual(REAL_BMC);
  });

  it('keeps the real coordinates for every caller when SIM_BMC_CIDR is unset and simulation is off', () => {
    expect(buildRedfishConfig({}).simBmcCidr).toBeNull();
    expect(bmcCoordinates('10.0.0.5', {})).toEqual({ protocol: 'https', port: 443 });
    expect(redfishProbeCoordinates('10.0.0.5', {})).toEqual([{ protocol: 'https', port: 443 }]);
  });
});

describe('redfishProbeCoordinates', () => {
  it('lists the real coordinate first, then the simulated one for a qualifying address', () => {
    expect(redfishProbeCoordinates('192.168.105.9', SIM_CIDR_ENV)).toEqual([REAL_BMC, SIM_BMC]);
  });

  it('lists only the real coordinate for an address outside the simulated bmc cidr', () => {
    expect(redfishProbeCoordinates('10.0.0.5', SIM_CIDR_ENV)).toEqual([REAL_BMC]);
  });

  it('lists both coordinates for every address when simulation is on and no cidr is set', () => {
    expect(redfishProbeCoordinates('10.0.0.5', SIM_ENV)).toEqual([REAL_BMC, SIM_BMC]);
  });

  it('carries NETWORK_REDFISH_PORT on the real coordinate, ahead of the simulated one', () => {
    expect(redfishProbeCoordinates('10.0.0.5', { ...SIM_ENV, NETWORK_REDFISH_PORT: '8444' })).toEqual([
      { protocol: 'https', port: 8444 },
      SIM_BMC,
    ]);
  });
});
