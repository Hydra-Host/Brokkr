import { access } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function registerEfiCollector(): void {
  registerOperation('collection.efi', async () => {
    const detected = await fileExists('/sys/firmware/efi');
    return {
      firmware_type: detected ? ('efi' as const) : ('bios' as const),
      efi: { detected },
    };
  });
}
