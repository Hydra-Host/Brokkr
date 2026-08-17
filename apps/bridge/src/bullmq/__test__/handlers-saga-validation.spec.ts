import { describe, expect, it } from 'vitest';

import { powerOffSagaPayloadSchema } from '../../power-ops/power-off.schema.js';
import { powerOnSagaPayloadSchema } from '../../power-ops/power-on.schema.js';
import { validateSagaPayload, type SagaPayloadSchemaRegistry } from '../saga-payload-validate.js';

const schemas: SagaPayloadSchemaRegistry = {
  power_off: powerOffSagaPayloadSchema,
  power_on: powerOnSagaPayloadSchema,
};

const BMC_SECRET = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: '22222222-2222-2222-2222-222222222222',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
  ephPub: 'ZXBoUHViQmFzZTY0',
  ciphertext: 'Y2lwaGVydGV4dEJhc2U2NA==',
  tag: 'dGFnQmFzZTY0',
};

function validPowerOffPayload(): Record<string, unknown> {
  return {
    device_id: '22222222-2222-2222-2222-222222222222',
    bmc_ip: '10.0.0.1',
    secrets: { bmc: { ...BMC_SECRET } },
  };
}

describe('validateSagaPayload: valid payloads', () => {
  it('valid power_off passes', () => {
    expect(() => validateSagaPayload('power_off', validPowerOffPayload(), schemas)).not.toThrow();
  });

  it('valid power_on passes', () => {
    expect(() =>
      validateSagaPayload(
        'power_on',
        {
          device_id: '77777777-7777-7777-7777-777777777777',
          bmc_ip: '10.0.0.2',
          secrets: { bmc: { ...BMC_SECRET, deviceId: '77777777-7777-7777-7777-777777777777' } },
        },
        schemas,
      ),
    ).not.toThrow();
  });
});

describe('validateSagaPayload: missing required fields', () => {
  it('rejects missing bmc_ip', () => {
    const payload = validPowerOffPayload();
    delete payload.bmc_ip;
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });

  it('rejects missing device_id', () => {
    const payload = validPowerOffPayload();
    delete payload.device_id;
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });
});

describe('validateSagaPayload: sealed BMC secret', () => {
  it('rejects a cred-saga payload missing the secrets envelope', () => {
    const payload = validPowerOffPayload();
    delete payload.secrets;
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });

  it('rejects plaintext root creds (username/password are no longer payload fields)', () => {
    const payload = { ...validPowerOffPayload(), username: 'admin', password: 's3cret' };
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });

  it('rejects a malformed sealed secret (missing zoneKeyId)', () => {
    const { zoneKeyId: _omit, ...badBmc } = BMC_SECRET;
    const payload = { ...validPowerOffPayload(), secrets: { bmc: badBmc } };
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });

  it('rejects empty bmc_ip', () => {
    const payload = validPowerOffPayload();
    payload.bmc_ip = '';
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });
});

describe('validateSagaPayload: extra field', () => {
  it('rejects unknown fields under strict schemas', () => {
    const payload = validPowerOffPayload();
    payload.unexpected_field = 'surprise';
    expect(() => validateSagaPayload('power_off', payload, schemas)).toThrow(/Invalid payload for saga 'power_off'/);
  });
});

describe('validateSagaPayload: unknown saga', () => {
  it('passes silently when no schema is registered', () => {
    expect(() => validateSagaPayload('totally_unknown_saga', { arbitrary: 'data' }, schemas)).not.toThrow();
  });
});
