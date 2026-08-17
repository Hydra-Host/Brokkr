import * as snmp from 'net-snmp';

const AUTH_PROTOCOLS: Readonly<Record<string, number>> = {
  MD5: snmp.AuthProtocols.md5,
  SHA: snmp.AuthProtocols.sha,
  SHA224: snmp.AuthProtocols.sha224,
  SHA256: snmp.AuthProtocols.sha256,
  SHA384: snmp.AuthProtocols.sha384,
  SHA512: snmp.AuthProtocols.sha512,
};

const PRIV_PROTOCOLS: Readonly<Record<string, number>> = {
  DES: snmp.PrivProtocols.des,
  AES128: snmp.PrivProtocols.aes,
  AES256: snmp.PrivProtocols.aes256r,
};

export function getAvailableAuthProtocols(): string[] {
  return Object.keys(AUTH_PROTOCOLS).sort();
}

export function getAvailablePrivProtocols(): string[] {
  return Object.keys(PRIV_PROTOCOLS).sort();
}

export class SnmpAuthError extends Error {}

export interface SnmpParams {
  version: string;
  community?: string;
  security_level?: string;
  username?: string;
  auth_protocol?: string;
  auth_passphrase?: string;
  priv_protocol?: string;
  priv_passphrase?: string;
}

export type AuthData =
  | { readonly kind: 'community'; readonly community: string; readonly version: number }
  | { readonly kind: 'usm'; readonly user: snmp.V3User };

export function buildAuthData(snmpParams: SnmpParams): AuthData {
  const version = snmpParams.version;

  if (version === '1' || version === '2c') {
    return {
      kind: 'community',
      community: snmpParams.community ?? '',
      version: version === '1' ? snmp.Version1 : snmp.Version2c,
    };
  }

  if (version !== '3') {
    throw new SnmpAuthError(`Unsupported SNMP version: '${version}' (expected 1, 2c, or 3)`);
  }

  const securityLevel = snmpParams.security_level ?? '';
  const username = snmpParams.username ?? '';

  if (securityLevel === 'noAuthNoPriv') {
    return { kind: 'usm', user: { name: username, level: snmp.SecurityLevel.noAuthNoPriv } };
  }

  const authProto = AUTH_PROTOCOLS[snmpParams.auth_protocol ?? ''];
  if (authProto === undefined) {
    throw new SnmpAuthError(`Auth protocol '${snmpParams.auth_protocol}' not available in net-snmp build`);
  }

  if (securityLevel === 'authNoPriv') {
    return {
      kind: 'usm',
      user: {
        name: username,
        level: snmp.SecurityLevel.authNoPriv,
        authProtocol: authProto,
        authKey: snmpParams.auth_passphrase ?? '',
      },
    };
  }

  const privProto = PRIV_PROTOCOLS[snmpParams.priv_protocol ?? ''];
  if (privProto === undefined) {
    throw new SnmpAuthError(`Priv protocol '${snmpParams.priv_protocol}' not available in net-snmp build`);
  }

  return {
    kind: 'usm',
    user: {
      name: username,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: authProto,
      authKey: snmpParams.auth_passphrase ?? '',
      privProtocol: privProto,
      privKey: snmpParams.priv_passphrase ?? '',
    },
  };
}
