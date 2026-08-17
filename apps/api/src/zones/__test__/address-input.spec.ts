import { ZoneAddressInputSchema } from '@repo/api-client';
import { countryNameFromCode, formatAddress, toZoneAddressData } from '@repo/utils';
import { describe, expect, it } from 'vitest';

const validInput = {
  addressLineOne: '123 Main St',
  city: 'Frankfurt',
  stateOrProvince: 'HE',
  postalCode: '60311',
  countryCode: 'DE',
  latitude: 50.11,
  longitude: 8.68,
  timezone: 'Europe/Berlin',
};

describe('ZoneAddressInputSchema enforcement', () => {
  it('accepts a fully valid address', () => {
    expect(ZoneAddressInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects a non-IANA timezone', () => {
    expect(ZoneAddressInputSchema.safeParse({ ...validInput, timezone: 'EST' }).success).toBe(false);
  });

  it('rejects unknown and non-uppercase country codes', () => {
    expect(ZoneAddressInputSchema.safeParse({ ...validInput, countryCode: 'XX' }).success).toBe(false);
    expect(ZoneAddressInputSchema.safeParse({ ...validInput, countryCode: 'de' }).success).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(ZoneAddressInputSchema.safeParse({ ...validInput, latitude: 91 }).success).toBe(false);
  });
});

describe('address derivation', () => {
  it('derives the country display name from the ISO code', () => {
    expect(countryNameFromCode('DE')).toBe('Germany');
  });

  it('builds the formatted address from the structured parts', () => {
    expect(formatAddress(validInput)).toBe('123 Main St, Frankfurt, HE 60311, Germany');
  });

  it('toZoneAddressData fills the derived display fields', () => {
    const data = toZoneAddressData(validInput);
    expect(data.country).toBe('Germany');
    expect(data.formattedAddress).toContain('Germany');
  });
});
