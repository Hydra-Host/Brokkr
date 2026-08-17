export interface LeaseRecord {
  ip: string;
  mac: string;
  hostname: string | null;
  expiresAt: number;
}
