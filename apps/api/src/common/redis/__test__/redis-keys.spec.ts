import { describe, expect, it } from 'vitest';
import {
  deviceLookup,
  devicePointers,
  deviceRecord,
  deviceSecret,
  ipxeUrl,
  rescueSshKeys,
  serverToken,
  TTL_DEVICE_SECRET_SECONDS,
  TTL_IPXE_URL_SECONDS,
  TTL_RESCUE_SSH_KEYS_SECONDS,
} from '../redis-keys';

describe('redis-keys: device atoms (MR3)', () => {
  describe('deviceRecord', () => {
    it('builds the unprefixed device_record key from a device UUID', () => {
      expect(deviceRecord('11111111-2222-3333-4444-555555555555')).toBe(
        'device:11111111-2222-3333-4444-555555555555:device_record',
      );
    });

    it('builds the key from a placeholder UUID identically', () => {
      expect(deviceRecord('aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee')).toBe(
        'device:aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee:device_record',
      );
    });
  });

  describe('devicePointers (tracking key)', () => {
    it('builds the tracking-key path by device UUID', () => {
      expect(devicePointers('11111111-2222-3333-4444-555555555555')).toBe(
        'device:11111111-2222-3333-4444-555555555555:pointers',
      );
    });
  });

  describe('deviceLookup', () => {
    it('normalizes mac to hyphens + lowercase', () => {
      expect(deviceLookup('mac', 'AA:BB:CC:DD:EE:FF')).toBe('device:lookup:mac:aa-bb-cc-dd-ee-ff');
      expect(deviceLookup('mac', 'aa-bb-cc-dd-ee-ff')).toBe('device:lookup:mac:aa-bb-cc-dd-ee-ff');
      expect(deviceLookup('mac', 'aa:bb:cc:dd:ee:ff')).toBe('device:lookup:mac:aa-bb-cc-dd-ee-ff');
    });

    it('normalizes ipmi_mac the same way as mac', () => {
      expect(deviceLookup('ipmi_mac', 'AA:BB:CC:DD:EE:FF')).toBe('device:lookup:ipmi_mac:aa-bb-cc-dd-ee-ff');
    });

    it('lowercases system_uuid but does not touch separators', () => {
      expect(deviceLookup('system_uuid', '550E8400-E29B-41D4-A716-446655440000')).toBe(
        'device:lookup:system_uuid:550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('lowercases serial / chassis_serial / board_serial', () => {
      expect(deviceLookup('serial', 'SN-100')).toBe('device:lookup:serial:sn-100');
      expect(deviceLookup('chassis_serial', 'CH-100')).toBe('device:lookup:chassis_serial:ch-100');
      expect(deviceLookup('board_serial', 'BB-100')).toBe('device:lookup:board_serial:bb-100');
    });

    it('produces the same key regardless of inbound MAC formatting (canonicalization)', () => {
      const colon = deviceLookup('mac', 'aa:bb:cc:dd:ee:ff');
      const hyphen = deviceLookup('mac', 'aa-bb-cc-dd-ee-ff');
      const upper = deviceLookup('mac', 'AA:BB:CC:DD:EE:FF');
      expect(colon).toBe(hyphen);
      expect(hyphen).toBe(upper);
    });
  });

  describe('serverToken', () => {
    it('resolves to the per-device-UUID server_token key', () => {
      expect(serverToken('11111111-2222-3333-4444-555555555555')).toBe(
        'device:11111111-2222-3333-4444-555555555555:server_token',
      );
    });
  });

  describe('rescueSshKeys (MR6)', () => {
    it('builds the unprefixed plain rescue ssh_pub_keys key from a device UUID', () => {
      expect(rescueSshKeys('11111111-2222-3333-4444-555555555555')).toBe(
        'device:11111111-2222-3333-4444-555555555555:rescue:ssh_pub_keys',
      );
    });

    it('uses a 24h TTL', () => {
      expect(TTL_RESCUE_SSH_KEYS_SECONDS).toBe(24 * 60 * 60);
    });
  });

  describe('deviceSecret (sealed per-device secret atom)', () => {
    it('builds the per-(device, purpose, kind) key under the secrets segment', () => {
      expect(deviceSecret('11111111-2222-3333-4444-555555555555', 'BMC', 'USER')).toBe(
        'device:11111111-2222-3333-4444-555555555555:secrets:bmc:user',
      );
    });

    it('lowercases purpose and kind so writer and (deferred) reader address the identical key', () => {
      expect(deviceSecret('11111111-2222-3333-4444-555555555555', 'Console', 'Cert')).toBe(
        'device:11111111-2222-3333-4444-555555555555:secrets:console:cert',
      );
    });

    it('carries no TTL — a sealed credential is durable device state, not a provision-window artifact', () => {
      expect(TTL_DEVICE_SECRET_SECONDS).toBe(0);
    });
  });

  describe('ipxeUrl (short-lived custom-iPXE url)', () => {
    it('builds the unprefixed config:ipxe_url key from a device UUID', () => {
      expect(ipxeUrl('550e8400-e29b-41d4-a716-446655440042')).toBe(
        'device:550e8400-e29b-41d4-a716-446655440042:config:ipxe_url',
      );
    });

    it('uses a provision-window TTL (1h)', () => {
      expect(TTL_IPXE_URL_SECONDS).toBe(60 * 60);
    });
  });
});
