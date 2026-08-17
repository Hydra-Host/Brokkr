export interface IPMIDevice {
  readonly ip: string;
  readonly username: string;
  readonly password: string;
  readonly port: number;
  readonly cipher: string | null;
  readonly jobId: string;
}

export interface IPMIDeviceInit {
  ip: string;
  username: string;
  password: string;
  port?: number;
  cipher?: string | null;
  jobId?: string;
}

export function createIpmiDevice(init: IPMIDeviceInit): IPMIDevice {
  return {
    ip: init.ip,
    username: init.username,
    password: init.password,
    port: init.port ?? 623,
    cipher: init.cipher ?? null,
    jobId: init.jobId ?? '',
  };
}

export function withCipher(device: IPMIDevice, cipher: string | null): IPMIDevice {
  return { ...device, cipher };
}
