import type { PrefixDhcpConfig } from '@repo/api-client';
import { describe, expect, it } from 'vitest';

import { apiToForm, dhcpConfigFormSchema, formValuesToPayload } from '../prefix-dhcp-config-card';

describe('prefix DHCP config form helpers', () => {
  const proxyConfig: PrefixDhcpConfig = {
    dhcpMode: 'PROXY',
    dhcpLeaseTtlSeconds: null,
    ipxeBuildTarget: 'IPXE',
    dhcpOptions: [{ code: 12, value: 'host' }],
    dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:ff'],
    dhcpProxyPeerAuthoritative: false,
    dhcpRelayAgentIp: '10.0.1.254',
  };

  it('apiToForm loads MACs regardless of mode (switching away from PROXY and back preserves them)', () => {
    const authForm = apiToForm({ ...proxyConfig, dhcpMode: 'AUTHORITATIVE' });
    expect(authForm.dhcpProxyAllowedMacs).toEqual([{ value: 'aa:bb:cc:dd:ee:ff' }]);
  });

  it('formValuesToPayload preserves every list even when the mode is OFF (no data loss on disable)', () => {
    const payload = formValuesToPayload(apiToForm({ ...proxyConfig, dhcpMode: 'OFF' }));
    expect(payload.dhcpMode).toBe('OFF');
    expect(payload.dhcpOptions).toEqual([{ code: 12, value: 'host' }]);
    expect(payload.dhcpProxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(payload.dhcpRelayAgentIp).toBe('10.0.1.254');
  });

  it('round-trips a PROXY config through form and back unchanged', () => {
    const payload = formValuesToPayload(apiToForm(proxyConfig));
    expect(payload.dhcpMode).toBe('PROXY');
    expect(payload.dhcpProxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(payload.dhcpRelayAgentIp).toBe('10.0.1.254');
  });

  it('drops empty/blank rows and lowercases MACs on submit', () => {
    const form = apiToForm(proxyConfig);
    form.dhcpProxyAllowedMacs = [{ value: 'AA:BB:CC:DD:EE:FF' }, { value: '' }, { value: '  ' }];
    const payload = formValuesToPayload(form);
    expect(payload.dhcpProxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:ff']);
  });

  it('drops INVALID rows from the payload so the strict API never 400s on hidden data', () => {
    const form = apiToForm(proxyConfig);
    form.dhcpProxyAllowedMacs = [{ value: 'aa:bb:cc:dd:ee:ff' }, { value: 'not-a-mac' }];
    form.dhcpOptions = [
      { code: 12, value: 'ok' },
      { code: 0, value: 'bad-code' },
      { code: 54, value: 'reserved' },
    ];
    const payload = formValuesToPayload(form);
    expect(payload.dhcpProxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(payload.dhcpOptions).toEqual([{ code: 12, value: 'ok' }]);
  });

  it('loads and preserves the relay agent IP for every DHCP mode', () => {
    const modes: Array<PrefixDhcpConfig['dhcpMode']> = ['AUTHORITATIVE', 'PROXY', 'OFF', null];
    for (const dhcpMode of modes) {
      const form = apiToForm({ ...proxyConfig, dhcpMode });
      expect(form.dhcpRelayAgentIp).toBe('10.0.1.254');
      expect(formValuesToPayload(form).dhcpRelayAgentIp).toBe('10.0.1.254');
    }
  });

  it('maps an empty relay agent IP to null', () => {
    const form = apiToForm({ ...proxyConfig, dhcpRelayAgentIp: null });
    expect(formValuesToPayload(form).dhcpRelayAgentIp).toBeNull();
  });

  it('rejects an invalid relay agent IP when DHCP is enabled', () => {
    const form = apiToForm(proxyConfig);
    form.dhcpRelayAgentIp = '10.0.1.999';
    expect(dhcpConfigFormSchema.safeParse(form).success).toBe(false);
  });

  it('rejects non-routable relay agent IPs when DHCP is enabled', () => {
    for (const relayAgentIp of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '255.255.255.255',
    ]) {
      const form = apiToForm(proxyConfig);
      form.dhcpRelayAgentIp = relayAgentIp;
      expect(dhcpConfigFormSchema.safeParse(form).success).toBe(false);
      expect(formValuesToPayload(form).dhcpRelayAgentIp).toBeNull();
    }
  });

  it('removes an invalid hidden relay agent IP from the full-replace payload', () => {
    const form = apiToForm({ ...proxyConfig, dhcpMode: 'OFF' });
    form.dhcpRelayAgentIp = '10.0.1.999';
    expect(formValuesToPayload(form).dhcpRelayAgentIp).toBeNull();
  });
});
