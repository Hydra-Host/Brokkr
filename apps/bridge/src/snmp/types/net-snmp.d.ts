declare module 'net-snmp' {
  import { EventEmitter } from 'node:events';

  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export interface ObjectTypeMap {
    Boolean: number;
    Integer: number;
    BitString: number;
    OctetString: number;
    Null: number;
    OID: number;
    IpAddress: number;
    Counter: number;
    Gauge: number;
    TimeTicks: number;
    Opaque: number;
    Counter64: number;
    NoSuchObject: number;
    NoSuchInstance: number;
    EndOfMibView: number;
    [key: number]: string | undefined;
  }
  export const ObjectType: ObjectTypeMap;

  export interface SecurityLevelMap {
    noAuthNoPriv: number;
    authNoPriv: number;
    authPriv: number;
  }
  export const SecurityLevel: SecurityLevelMap;

  export interface AuthProtocolsMap {
    none: number;
    md5: number;
    sha: number;
    sha224: number;
    sha256: number;
    sha384: number;
    sha512: number;
  }
  export const AuthProtocols: AuthProtocolsMap;

  export interface PrivProtocolsMap {
    none: number;
    des: number;
    aes: number;
    aes256b: number;
    aes256r: number;
  }
  export const PrivProtocols: PrivProtocolsMap;

  export interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }

  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    version?: number;
    transport?: string;
  }

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }

  export interface Session extends EventEmitter {
    get(oids: string[], responseCb: (error: Error | null, varbinds?: Varbind[]) => void): Session;
    subtree(
      oid: string,
      maxRepetitions: number,
      feedCb: (varbinds: Varbind[]) => boolean | undefined,
      doneCb: (error: Error | null) => void,
    ): Session;
    close(): Session;
  }

  export function createSession(target: string, community: string, options?: SessionOptions): Session;
  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;
  export function isVarbindError(varbind: Varbind): boolean;
  export function varbindError(varbind: Varbind): string;
}
