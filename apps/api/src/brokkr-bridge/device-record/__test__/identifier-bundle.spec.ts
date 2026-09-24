import { describe, expect, it } from 'vitest';
import { identifierBundleFor } from '../identifier-bundle';

describe('identifierBundleFor', () => {
  it('derives mac from the data NIC and ipmi_mac from the mgmtOnly NIC', () => {
    const bundle = identifierBundleFor({
      systemUuid: 'sys-uuid-1',
      serial: 'SN001',
      chassisSerial: 'CH001',
      baseboardSerial: 'BB001',
      interfaces: [
        { macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false },
        { macAddress: '11:22:33:44:55:66', mgmtOnly: true },
      ],
    });

    expect(bundle).toEqual({
      mac: 'aa:bb:cc:dd:ee:ff',
      ipmi_mac: '11:22:33:44:55:66',
      system_uuid: 'sys-uuid-1',
      serial: 'SN001',
      chassis_serial: 'CH001',
      board_serial: 'BB001',
      interface_macs: ['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'],
    });
  });

  it('derives only mac when there is no mgmtOnly interface', () => {
    const bundle = identifierBundleFor({
      systemUuid: 'sys-uuid-1',
      interfaces: [{ macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false }],
    });

    expect(bundle).toEqual({
      mac: 'aa:bb:cc:dd:ee:ff',
      system_uuid: 'sys-uuid-1',
      interface_macs: ['aa:bb:cc:dd:ee:ff'],
    });
  });

  it('omits keys for null / absent fields', () => {
    expect(identifierBundleFor({ systemUuid: null, serial: null, chassisSerial: null, baseboardSerial: null })).toEqual(
      {},
    );
    expect(identifierBundleFor({})).toEqual({});
  });

  it('collects interface MACs into interface_macs, de-duped and skipping empties', () => {
    const bundle = identifierBundleFor({
      interfaces: [
        { macAddress: 'de:ad:be:ef:00:01', mgmtOnly: false },
        { macAddress: 'de:ad:be:ef:00:02', mgmtOnly: false },
        { macAddress: 'de:ad:be:ef:00:01', mgmtOnly: false },
        { macAddress: null, mgmtOnly: false },
        { macAddress: '', mgmtOnly: false },
      ],
    });

    expect(bundle.mac).toBe('de:ad:be:ef:00:01');
    expect(bundle.interface_macs).toEqual(['de:ad:be:ef:00:01', 'de:ad:be:ef:00:02']);
  });

  it('omits interface_macs entirely when there are no interface MACs', () => {
    const bundle = identifierBundleFor({ interfaces: [{ macAddress: null }, { macAddress: '' }] });

    expect('interface_macs' in bundle).toBe(false);
  });

  it('takes the mac of the data interface that holds an address over an earlier one without', () => {
    const bundle = identifierBundleFor({
      interfaces: [
        { macAddress: '58:a2:e1:2e:16:88', mgmtOnly: false, ipAddresses: [] },
        { macAddress: '80:61:5f:2c:59:ac', mgmtOnly: false, ipAddresses: [{ address: '172.16.12.50' }] },
      ],
    });
    expect(bundle.mac).toBe('80:61:5f:2c:59:ac');
    expect(bundle.interface_macs).toEqual(['58:a2:e1:2e:16:88', '80:61:5f:2c:59:ac']);
  });
});
