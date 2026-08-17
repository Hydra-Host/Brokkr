import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';

const StackEntrySchema = z
  .object({
    slot: z.number(),
    checkout: z.string(),
    pcSock: z.string().optional(),
    pcDaemonPid: z.number().optional(),
    state: z.string().optional(),
  })
  .passthrough();
export type StackEntry = z.infer<typeof StackEntrySchema>;

const defaultRegistryDir = (): string =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'brokkr-local', 'stacks');

const processComposeAnswers = (sock: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      process.env.PROCESS_COMPOSE_BIN || 'process-compose',
      ['-U', '-u', sock, 'process', 'list', '-o', 'json'],
      { timeout: 2_000 },
      (error) => resolve(!error),
    );
  });

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Read-only view of the host slot registry (devenv/lib/stack-registry.sh). Read-only by design: the
 *  claim's own GC reaps stale entries on the next bring-up, so staleness only discounts an entry here. */
@Injectable()
export class StackRegistryClient {
  private readonly log = new Logger(StackRegistryClient.name);

  constructor(
    private readonly dir: string = defaultRegistryDir(),
    private readonly socketAnswers: (sock: string) => Promise<boolean> = processComposeAnswers,
  ) {}

  list(): StackEntry[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => /^stack-\d+\.json$/.test(f));
    } catch {
      return [];
    }
    const entries: StackEntry[] = [];
    for (const file of files) {
      try {
        const parsed = StackEntrySchema.safeParse(JSON.parse(readFileSync(join(this.dir, file), 'utf8')));
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid');
        entries.push(parsed.data);
      } catch (error) {
        this.log.warn(`ignoring unparseable registry entry ${file}: ${getErrorMessage(error)}`);
      }
    }
    return entries.sort((a, b) => a.slot - b.slot);
  }

  /** The checkout owning `slot`, or null when free/held only by a stale entry. Stale mirrors the registry's
   *  own GC rule (checkout gone, or recorded pid + socket both dead); a pid-0 entry is the pre-supervisor window. */
  async ownerOfSlot(slot: number): Promise<string | null> {
    const entry = this.list().find((e) => e.slot === slot);
    if (!entry) return null;
    if (!existsSync(entry.checkout)) return null;
    const pid = entry.pcDaemonPid ?? 0;
    if (pid !== 0 && !pidAlive(pid)) {
      const sock = entry.pcSock ?? '';
      if (!sock || !existsSync(sock) || !(await this.socketAnswers(sock))) return null;
    }
    return entry.checkout;
  }
}
