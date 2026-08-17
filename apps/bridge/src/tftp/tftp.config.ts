import { getIpxeConfig } from '../ipxe/ipxe.config';

const TFTP_DEFAULT_PORT = 69;
const TFTP_DEFAULT_HOST = '0.0.0.0';
const TFTP_MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const TFTP_ALLOWED_EXTENSIONS: readonly string[] = ['.efi', '.img', '.iso', '.bin', '.pxe', '.cfg', '.txt', '.conf'];

export interface TftpConfig {
  tftpEnabled: boolean;
  tftpRootDir: string;
  port: number;
  host: string;
  logTransfers: boolean;
  allowedExtensions: readonly string[];
  maxFileSize: number;
  enableWrite: boolean;
}

export function buildTftpConfig(env: NodeJS.ProcessEnv = process.env): TftpConfig {
  const rawEnabled = env.TFTP_ENABLED ?? 'True';
  const tftpEnabled = rawEnabled.toLowerCase() === 'true';
  const ipxeConfig = getIpxeConfig();
  return {
    tftpEnabled,
    tftpRootDir: ipxeConfig.finalBuildsDir,
    port: TFTP_DEFAULT_PORT,
    host: TFTP_DEFAULT_HOST,
    logTransfers: true,
    allowedExtensions: TFTP_ALLOWED_EXTENSIONS,
    maxFileSize: TFTP_MAX_FILE_SIZE,
    enableWrite: false,
  };
}

let cached: TftpConfig | null = null;

export function getTftpConfig(): TftpConfig {
  if (cached === null) {
    cached = buildTftpConfig();
  }
  return cached;
}

export function resetTftpConfigForTests(): void {
  cached = null;
}
