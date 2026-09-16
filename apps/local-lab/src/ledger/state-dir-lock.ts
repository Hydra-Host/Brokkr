import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getErrorMessage } from '@repo/utils';
import { labStateDir } from '../common/lab-state';

function lockPath(): string {
  return join(labStateDir(), 'lab', 'lab.pid');
}

function liveHolder(path: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** LAB_PORT is configurable while the ledger is keyed by LOCAL_STATE, so a won port bind proves nothing
 *  about who owns these runs — this pid file does. */
@Injectable()
export class StateDirLock implements OnApplicationShutdown {
  private readonly log = new Logger(StateDirLock.name);
  private held: string | undefined;

  /** False means another live lab owns this state dir, and its running runs are not our orphans. */
  acquire(): boolean {
    const path = lockPath();
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = this.publish(path);
      if (error === null) return true;
      failure = error;
      const holder = liveHolder(path);
      if (holder !== null) {
        this.log.error(`state dir ${labStateDir()} is held by live lab pid ${holder} — skipping the orphan reconcile`);
        return false;
      }
      try {
        rmSync(path, { force: true });
      } catch (error) {
        this.log.warn(`stale lock ${path} could not be cleared: ${getErrorMessage(error)}`);
        return false;
      }
    }
    this.log.warn(`could not take the ${path} lock (${failure}) — skipping the orphan reconcile`);
    return false;
  }

  release(): void {
    if (this.held === undefined) return;
    try {
      rmSync(this.held, { force: true });
    } catch (error) {
      this.log.warn(`lock ${this.held} could not be released: ${getErrorMessage(error)}`);
    }
    this.held = undefined;
  }

  onApplicationShutdown(): void {
    this.release();
  }

  /** Linking a fully written staging file is what makes the pid readable the instant the path exists,
   *  so a rival never reads a half-written holder and mistakes it for a stale file. */
  private publish(path: string): string | null {
    const staging = `${path}.${process.pid}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(staging, `${process.pid}\n`);
      linkSync(staging, path);
      this.held = path;
      return null;
    } catch (error) {
      return getErrorMessage(error);
    } finally {
      try {
        rmSync(staging, { force: true });
      } catch (error) {
        this.log.warn(`lock staging file ${staging} could not be removed: ${getErrorMessage(error)}`);
      }
    }
  }
}
