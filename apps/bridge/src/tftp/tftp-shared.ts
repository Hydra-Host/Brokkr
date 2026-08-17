export const MIN_BLKSIZE = 8;
export const DEF_BLKSIZE = 512;
export const MAX_BLKSIZE = 65536;
export const SOCK_TIMEOUT = 5;
export const MAX_DUPS = 20;
export const DEF_TIMEOUT_RETRIES = 3;
export const DEF_TFTP_PORT = 69;

export class TftpException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TftpException';
  }
}

export class TftpTimeout extends TftpException {
  constructor(message: string) {
    super(message);
    this.name = 'TftpTimeout';
  }
}

export class TftpTimeoutExpectACK extends TftpTimeout {
  constructor(message: string) {
    super(message);
    this.name = 'TftpTimeoutExpectACK';
  }
}

export class TftpFileNotFoundError extends TftpException {
  constructor(message: string) {
    super(message);
    this.name = 'TftpFileNotFoundError';
  }
}

export const TftpErrors = {
  NotDefined: 0,
  FileNotFound: 1,
  AccessViolation: 2,
  DiskFull: 3,
  IllegalTftpOp: 4,
  UnknownTID: 5,
  FileAlreadyExists: 6,
  NoSuchUser: 7,
  FailedNegotiation: 8,
} as const;

export function tftpassert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new TftpException(message);
  }
}
