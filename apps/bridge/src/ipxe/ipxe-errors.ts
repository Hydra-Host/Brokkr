export class IpxeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'iPXEServiceError';
  }
}

export class IpxeServerTokenUnavailableError extends IpxeServiceError {}
