import { Injectable, Logger } from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { getErrorMessage } from '@repo/utils';
import type { ShimBinding } from './vrrp-desired';

/** The constant label the bridge reconciler tags its VIP addresses with, so a restart can rediscover
 *  exactly what it owns. Anything on the interface without it belongs to the host, not to us. */
const VRRP_LABEL = 'brokkr-vrrp';

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;

const ShimEntrySchema = z.object({
  iface: z.string(),
  local: z.string(),
  prefixlen: z.number().int(),
  label: z.string().optional(),
});

@Injectable()
export class VrrpShimReaderService {
  private readonly log = new Logger(VrrpShimReaderService.name);

  private stateDir(): string | null {
    const explicit = process.env.VRRP_SIM_STATE_DIR?.trim();
    if (explicit) return explicit;
    const devenvState = process.env.DEVENV_STATE?.trim();
    return devenvState ? join(devenvState, 'vrrp-sim') : null;
  }

  /** Null means bind state is not observable here at all — the sim is off, or one bridge's state was
   *  unreadable. Never degrade to a partial list: it would read as a measurement of who holds what. */
  async bindings(): Promise<ShimBinding[] | null> {
    const dir = this.stateDir();
    if (!dir) return null;

    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return null;
    }
    if (names.length > MAX_FILES) {
      this.log.debug(`vrrp shim state ${dir} holds ${names.length} files, above the ${MAX_FILES} cap`);
      return null;
    }

    const found: ShimBinding[] = [];
    for (const name of names) {
      const entries = await this.entries(join(dir, name));
      if (entries === null) return null;
      const instanceId = name.slice(0, -'.json'.length);
      for (const entry of entries) {
        if (entry.label !== VRRP_LABEL) continue;
        found.push({ instanceId, cidr: `${entry.local}/${entry.prefixlen}` });
      }
    }
    return found;
  }

  private async entries(path: string): Promise<z.infer<typeof ShimEntrySchema>[] | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const parsed = z.array(ShimEntrySchema).safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.log.debug(`vrrp shim state ${path} unreadable: ${getErrorMessage(error)}`);
      return null;
    }
  }
}
