export class RedisConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConnectionError';
  }
}

export class RedisOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisOperationError';
  }
}

export class RedisEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisEncryptionError';
  }
}
