export interface BmcCredentials {
  readonly bmcIp: string;
  readonly username: string;
  readonly password: string;
}

export function bmcCredentials(bmcIp: string, username: string, password: string): BmcCredentials {
  return Object.freeze({ bmcIp, username, password });
}
