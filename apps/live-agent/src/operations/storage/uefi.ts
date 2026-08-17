import { access } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';

export function registerUefiDetector(): void {
  registerOperation('storage.detectUefiMode', async () => {
    try {
      await access('/sys/firmware/efi');
      return { uefi_mode: true };
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return { uefi_mode: false };
      }
      return { uefi_mode: true };
    }
  });
}
