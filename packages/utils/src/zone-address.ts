export interface ZoneAddressInput {
  addressLineOne: string;
  addressLineTwo?: string | null;
  city: string;
  stateOrProvince?: string | null;
  postalCode?: string | null;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
}

const regionDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryNameFromCode(countryCode: string): string {
  return regionDisplayNames.of(countryCode) ?? countryCode;
}

export function formatAddress(address: ZoneAddressInput): string {
  const stateAndPostal = [address.stateOrProvince, address.postalCode].filter(Boolean).join(' ');
  return [
    address.addressLineOne,
    address.addressLineTwo,
    address.city,
    stateAndPostal,
    countryNameFromCode(address.countryCode),
  ]
    .filter(Boolean)
    .join(', ');
}

export function toZoneAddressData(address: ZoneAddressInput) {
  return {
    formattedAddress: formatAddress(address),
    addressLineOne: address.addressLineOne,
    addressLineTwo: address.addressLineTwo,
    city: address.city,
    stateOrProvince: address.stateOrProvince,
    postalCode: address.postalCode,
    country: countryNameFromCode(address.countryCode),
    countryCode: address.countryCode,
    latitude: address.latitude,
    longitude: address.longitude,
    timezone: address.timezone,
  };
}
