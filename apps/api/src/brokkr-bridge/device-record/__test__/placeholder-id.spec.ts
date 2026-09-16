import { describe, expect, it } from 'vitest';
import { NIL_UUID, PLACEHOLDER_NAMESPACE_UUID, placeholderIdFromBundle, uuidv5 } from '../placeholder-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('placeholderIdFromBundle', () => {
  it('is deterministic across invocations with the same bundle', () => {
    const bundle = { mac: 'aa:bb:cc:dd:ee:ff' };
    expect(placeholderIdFromBundle(bundle)).toBe(placeholderIdFromBundle(bundle));
  });

  it('produces a valid RFC 4122 v5 UUID string', () => {
    const id = placeholderIdFromBundle({ mac: 'aa:bb:cc:dd:ee:ff' });
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_RE);
  });

  it('normalizes mac (case + separator) so colon/hyphen + casing collide', () => {
    const a = placeholderIdFromBundle({ mac: 'AA:BB:CC:DD:EE:FF' });
    const b = placeholderIdFromBundle({ mac: 'aa-bb-cc-dd-ee-ff' });
    const c = placeholderIdFromBundle({ mac: 'aa:bb:cc:dd:ee:ff' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('feeds the hyphen-separated lowercase mac to the v5 hash so existing placeholder ids stay stable', () => {
    const canonical = JSON.stringify({
      mac: 'aa-bb-cc-dd-ee-ff',
      ipmi_mac: null,
      system_uuid: null,
      serial: null,
      chassis_serial: null,
      board_serial: null,
    });
    expect(placeholderIdFromBundle({ mac: 'AA:BB:CC:DD:EE:FF' })).toBe(uuidv5(canonical, PLACEHOLDER_NAMESPACE_UUID));
  });

  it('normalizes ipmi_mac the same way as mac', () => {
    const a = placeholderIdFromBundle({ ipmi_mac: 'AA:BB:CC:DD:EE:FF' });
    const b = placeholderIdFromBundle({ ipmi_mac: 'aa-bb-cc-dd-ee-ff' });
    expect(a).toBe(b);
  });

  it('produces different ids for different bundles', () => {
    const a = placeholderIdFromBundle({ mac: 'aa:bb:cc:dd:ee:ff' });
    const b = placeholderIdFromBundle({ mac: '11:22:33:44:55:66' });
    expect(a).not.toBe(b);
  });

  it('factors every identifier into the hash (different serial -> different id)', () => {
    const a = placeholderIdFromBundle({ serial: 'SN-1' });
    const b = placeholderIdFromBundle({ serial: 'SN-2' });
    expect(a).not.toBe(b);
  });

  it('lowercases serial so mixed-case duplicates collide', () => {
    expect(placeholderIdFromBundle({ serial: 'ABC-123' })).toBe(placeholderIdFromBundle({ serial: 'abc-123' }));
  });

  it('lowercases chassis_serial so mixed-case duplicates collide', () => {
    expect(placeholderIdFromBundle({ chassis_serial: 'Chassis-X' })).toBe(
      placeholderIdFromBundle({ chassis_serial: 'chassis-x' }),
    );
  });

  it('lowercases board_serial so mixed-case duplicates collide', () => {
    expect(placeholderIdFromBundle({ board_serial: 'Board-Y' })).toBe(
      placeholderIdFromBundle({ board_serial: 'board-y' }),
    );
  });

  it('lowercases system_uuid so mixed-case duplicates collide', () => {
    expect(placeholderIdFromBundle({ system_uuid: 'ABCDEF-1234' })).toBe(
      placeholderIdFromBundle({ system_uuid: 'abcdef-1234' }),
    );
  });

  it('mac-only and serial-only bundles differ even with the same value', () => {
    const a = placeholderIdFromBundle({ mac: 'aa:bb:cc:dd:ee:ff' });
    const b = placeholderIdFromBundle({ serial: 'aa:bb:cc:dd:ee:ff' });
    expect(a).not.toBe(b);
  });

  it('treats an empty bundle as a stable UUID constant', () => {
    const id = placeholderIdFromBundle({});
    expect(id).toMatch(UUID_RE);
    expect(id).toBe(placeholderIdFromBundle({}));
  });

  it('never collides with the nil UUID sentinel', () => {
    expect(placeholderIdFromBundle({ mac: 'aa:bb:cc:dd:ee:ff' })).not.toBe(NIL_UUID);
  });
});

describe('uuidv5', () => {
  it('matches the RFC 4122 §4.3 test vector for the DNS namespace + "python.org"', () => {
    const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidv5('python.org', NAMESPACE_DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is deterministic for the placeholder namespace', () => {
    expect(uuidv5('hello', PLACEHOLDER_NAMESPACE_UUID)).toBe(uuidv5('hello', PLACEHOLDER_NAMESPACE_UUID));
  });

  it('stamps version 5 and the RFC variant bits', () => {
    expect(uuidv5('anything', PLACEHOLDER_NAMESPACE_UUID)).toMatch(UUID_RE);
  });
});
