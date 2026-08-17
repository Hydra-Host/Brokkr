import { readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';

export function registerBdiCollector(): void {
  registerOperation('collection.bdi', async () => {
    const cmdline = await readFile('/proc/cmdline', 'utf8');
    const params: Record<string, string> = {};

    for (const token of cmdline.trim().split(/\s+/)) {
      if (!token.startsWith('bdi.')) continue;
      const eqIndex = token.indexOf('=');
      if (eqIndex === -1) {
        params[token.slice(4)] = '';
      } else {
        params[token.slice(4, eqIndex)] = token.slice(eqIndex + 1);
      }
    }

    return { bdi: params };
  });
}
