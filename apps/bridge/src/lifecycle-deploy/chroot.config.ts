export interface ChrootConfig {
  mountTimeout: number;
  unmountTimeout: number;
  commandTimeout: number;
  enabledMountpoints: readonly (readonly [string, string])[];
}

export function buildChrootConfig(): ChrootConfig {
  return {
    mountTimeout: 30,
    unmountTimeout: 30,
    commandTimeout: 300,
    enabledMountpoints: [
      ['dev', 'mount --bind /dev'],
      ['proc', 'mount -t proc proc'],
      ['sys', 'mount -t sysfs sys'],
      ['run', 'mount --bind /run'],
      ['dev/pts', 'mount --bind /dev/pts'],
      ['sys/firmware/efi/efivars', 'mount --bind /sys/firmware/efi/efivars'],
    ],
  };
}

let cached: ChrootConfig | null = null;

export function getChrootConfig(): ChrootConfig {
  if (cached === null) {
    cached = buildChrootConfig();
  }
  return cached;
}

export function resetChrootConfigForTests(): void {
  cached = null;
}
