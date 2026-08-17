export const TEE_FIRMWARE: Record<string, { bios: string[]; cpld?: string[] }> = {
  aivres: { bios: ['03.03.01', '03.04.01', '06.09.01'] },
  dell: { bios: ['2.7.5', '2.8.2', '2.9.4'], cpld: ['1.6.0'] },
  lenovo: { bios: ['2.20', '3.20', '3.30'] },
  supermicro: { bios: ['2.6a'] },
};

export const TEE_CPU_FAMILIES = ['6'];
export const TEE_CPU_MODELS = ['173', '175', '207'];

export const NVIDIA_ATTESTATION_URL = 'https://rim.attestation.nvidia.com/v1/rim/ids';
export const NVIDIA_ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;

export const TEE_CAP = {
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  PATCH: 'PATCH',
};
