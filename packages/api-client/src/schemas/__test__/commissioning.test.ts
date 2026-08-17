import {
  CommissioningDeviceInputSchema,
  CommissioningScanPollResponseSchema,
  CommissioningScanRequestSchema,
  ScannedDeviceSchema,
} from '../commissioning';

describe('CommissioningScanRequestSchema.subnets', () => {
  it('accepts omitted subnets (optional)', () => {
    expect(CommissioningScanRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts explicit undefined subnets', () => {
    expect(CommissioningScanRequestSchema.safeParse({ subnets: undefined }).success).toBe(true);
  });

  it('accepts a valid array of CIDRs', () => {
    expect(CommissioningScanRequestSchema.safeParse({ subnets: ['10.0.0.0/24', '192.168.1.0/28'] }).success).toBe(true);
  });

  it('rejects an empty array (min 1)', () => {
    expect(CommissioningScanRequestSchema.safeParse({ subnets: [] }).success).toBe(false);
  });

  it('rejects more than 50 entries (max 50)', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `10.0.${i}.0/24`);
    expect(CommissioningScanRequestSchema.safeParse({ subnets: tooMany }).success).toBe(false);
  });

  it('accepts exactly 50 entries', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `10.0.${i}.0/24`);
    expect(CommissioningScanRequestSchema.safeParse({ subnets: fifty }).success).toBe(true);
  });

  it.each(['not-a-cidr', '10.0.0.0', '10.0.0.0/33', '999.0.0.0/24'])('rejects a malformed CIDR entry %s', (entry) => {
    expect(CommissioningScanRequestSchema.safeParse({ subnets: [entry] }).success).toBe(false);
  });
});

describe('CommissioningScanPollResponseSchema', () => {
  it('parses a pending status', () => {
    expect(CommissioningScanPollResponseSchema.safeParse({ status: 'pending' }).success).toBe(true);
  });

  it('parses a complete status with result devices/total', () => {
    const result = CommissioningScanPollResponseSchema.safeParse({
      status: 'complete',
      result: { devices: [], total: 0, partial: false, subnetsTotal: 1, subnetsFailed: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('parses a failed status with error', () => {
    expect(CommissioningScanPollResponseSchema.safeParse({ status: 'failed', error: 'scan timed out' }).success).toBe(
      true,
    );
  });
});

const VALID_SCANNED_DEVICE = {
  id: null,
  bmcMac: 'aa:bb:cc:dd:ee:ff',
  bmcIp: '10.0.0.5',
  nicMac: '11:22:33:44:55:66',
  nicIp: '10.0.1.5',
  hasIpmi: true,
  hasRedfish: false,
  serial: 'SN12345',
  boardSerial: 'BSN12345',
  chassisSerial: 'CSN12345',
  manufacturer: 'Acme',
  enriched: true,
  commissioningStatus: 'Detected',
};

describe('ScannedDeviceSchema', () => {
  it('parses a representative valid object', () => {
    expect(ScannedDeviceSchema.safeParse(VALID_SCANNED_DEVICE).success).toBe(true);
  });

  it.each(['Detected', 'InProgress', 'Done', 'Failed'])('accepts commissioningStatus enum member %s', (status) => {
    expect(ScannedDeviceSchema.safeParse({ ...VALID_SCANNED_DEVICE, commissioningStatus: status }).success).toBe(true);
  });

  it('rejects an unknown commissioningStatus', () => {
    expect(ScannedDeviceSchema.safeParse({ ...VALID_SCANNED_DEVICE, commissioningStatus: 'Unknown' }).success).toBe(false);
  });
});

describe('CommissioningDeviceInputSchema', () => {
  const VALID_INPUT = {
    bmcMac: 'aa:bb:cc:dd:ee:ff',
    bmcIp: '10.0.0.5',
    bmcUsername: 'admin',
    bmcPassword: 'secret',
  };

  it('accepts the required credential fields alone', () => {
    expect(CommissioningDeviceInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it.each(['bmcMac', 'bmcIp', 'bmcUsername', 'bmcPassword'])('rejects when required field %s is omitted', (field) => {
    const { [field]: _omitted, ...rest } = VALID_INPUT;
    expect(CommissioningDeviceInputSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts the optional fields when present', () => {
    const withOptionals = {
      ...VALID_INPUT,
      nicMac: '11:22:33:44:55:66',
      nicIp: '10.0.1.5',
      osIp: '10.0.2.5',
      serial: 'SN12345',
    };
    expect(CommissioningDeviceInputSchema.safeParse(withOptionals).success).toBe(true);
  });

  it('accepts the input when optional fields are absent', () => {
    expect(CommissioningDeviceInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });
});
