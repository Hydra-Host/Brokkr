import { describe, expect, it } from 'vitest';

import { toDiagnosticDevice, type DiagnosticServer } from './-header-lines';

const server = (overrides: Partial<DiagnosticServer> = {}): DiagnosticServer => ({
  id: '7f3a2c1e-9b0d-4e5f-a6c7-8d9e0f1a2b3c',
  name: 'gpu-node-07',
  dcim: {},
  status: { value: 'inventory', label: 'Inventory' },
  zoneId: 'zone-1',
  zoneName: 'ams-1',
  networking: { ipmiIp: '10.40.0.17' },
  ...overrides,
});

describe('toDiagnosticDevice', () => {
  it('maps the identity, zone, status and BMC address', () => {
    expect(toDiagnosticDevice(server())).toEqual({
      id: '7f3a2c1e-9b0d-4e5f-a6c7-8d9e0f1a2b3c',
      displayName: 'gpu-node-07',
      zoneId: 'zone-1',
      zoneName: 'ams-1',
      bmcIp: '10.40.0.17',
      deployedOs: false,
      status: 'Inventory',
    });
  });

  it('prefers the operator nickname as the display name', () => {
    expect(toDiagnosticDevice(server({ dcim: { nickname: 'rack-7 slot 3' } })).displayName).toBe('rack-7 slot 3');
    expect(toDiagnosticDevice(server({ dcim: { nickname: '' } })).displayName).toBe('gpu-node-07');
  });

  it('nulls the BMC address when none is known', () => {
    expect(toDiagnosticDevice(server({ networking: {} })).bmcIp).toBeNull();
    expect(toDiagnosticDevice(server({ networking: { ipmiIp: null } })).bmcIp).toBeNull();
  });

  it('reports a deployed os only while the status is provisioned', () => {
    expect(toDiagnosticDevice(server({ status: { value: 'provisioned', label: 'Provisioned' } })).deployedOs).toBe(
      true,
    );
    expect(toDiagnosticDevice(server({ status: { value: 'Provisioned', label: 'Provisioned' } })).deployedOs).toBe(
      true,
    );
    expect(toDiagnosticDevice(server({ status: { value: 'provisioning', label: 'Provisioning' } })).deployedOs).toBe(
      false,
    );
    expect(toDiagnosticDevice(server({ status: undefined })).deployedOs).toBe(false);
  });
});
