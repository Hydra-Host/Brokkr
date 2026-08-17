import { Address4 } from 'ip-address';

export interface IpValidationResult {
  isValid: boolean;
  errors: string[];
}

export function isValidIpv4(ipString: string): IpValidationResult {
  const errors: string[] = [];

  try {
    if (!ipString) {
      return {
        isValid: false,
        errors: ['IP address is required'],
      };
    }

    const hasSubnetMask = ipString.includes('/');
    const ipWithMask = hasSubnetMask ? ipString : `${ipString}/32`;

    const address = new Address4(ipWithMask);

    if (!address.isCorrect()) {
      errors.push(
        hasSubnetMask
          ? `Invalid IPv4 address or subnet mask format: ${ipString}`
          : `Invalid IPv4 address format: ${ipString}`,
      );
      return { isValid: false, errors };
    }

    if (hasSubnetMask) {
      const mask = parseInt(ipWithMask.split('/')[1], 10);
      if (isNaN(mask) || mask < 0 || mask > 32) {
        errors.push('Subnet mask must be between 0 and 32');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  } catch (_error) {
    return {
      isValid: false,
      errors: [`Invalid IPv4 address format: ${ipString}`],
    };
  }
}
