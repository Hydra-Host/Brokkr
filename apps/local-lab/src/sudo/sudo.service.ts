import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const MAX_CONSECUTIVE_REJECTIONS = 3;
const REJECTION_COOLDOWN_MS = 30_000;
const SUDOERS_D = '/etc/sudoers.d';
const PROBE_FALLBACK = '/usr/bin/true';
const LEGACY_DROP_IN = 'brokkr-sim';

const SETUP_HINT = 'run `task sudo:setup` in a terminal (its one prompt needs a tty), then retry';

export interface SudoPreflight {
  ok: boolean;
  reason?: string;
}

/** Drop-ins are named for the helper they authorise, so sibling checkouts at other revisions never
 *  overwrite each other. Same derivation as install-sim-sudoers.sh / modules/sudo.nix. */
export function sudoersDropInName(helperBin: string): string | null {
  const store = basename(dirname(dirname(helperBin)));
  return /^[0-9a-z]{12}/.test(store) ? `brokkr-sim-${store.slice(0, 12)}` : null;
}

/** Does the host's installed policy authorise THIS checkout's helper — the one question that
 *  survives concurrent checkouts. Pure; an unknown helper or unreadable sudoers.d pins nothing. */
export function sudoersDrift(input: { helperBin: string | null; installed: string[] | null }): string | null {
  if (input.helperBin === null || input.installed === null) return null;
  const expected = sudoersDropInName(input.helperBin);
  if (expected === null) return null;
  // presence is not effect: the legacy drop-in declares Cmnd_Alias names, and sudo keeps only the
  // first file defining one, so it voids this checkout's drop-in even while that file is installed
  if (expected !== LEGACY_DROP_IN && input.installed.includes(LEGACY_DROP_IN))
    return `the legacy host-wide ${LEGACY_DROP_IN} drop-in shadows this checkout's`;
  if (input.installed.includes(expected)) return null;
  return input.installed.some((entry) => entry.startsWith('brokkr-sim'))
    ? "the installed passwordless sim sudo drop-ins authorise other checkouts' helpers, not this one"
    : 'the passwordless sim sudo drop-in has never been installed';
}

function simPrivBin(): string | null {
  return process.env.LOCAL_SIM_PRIV_BIN || null;
}

function installedDropIns(): string[] | null {
  try {
    return readdirSync(SUDOERS_D);
  } catch {
    return null;
  }
}

/** TTY-less, so a sudo prompt would hang; the supported path is the NOPASSWD drop-in (`sudo:setup`) — the `-S -v` ticket fallback is best-effort (macOS tty_tickets) and the password is never stored. */
@Injectable()
export class SudoService {
  private readonly log = new Logger(SudoService.name);
  private keepAlive?: NodeJS.Timeout;
  private rejections = 0;
  private cooldownUntil = 0;
  private attemptInFlight = false;

  /** Probes the real helper: a sibling checkout's drop-in allowlists /usr/bin/true too, so that
   *  probe answers for a policy that no longer authorises this checkout. */
  async available(): Promise<boolean> {
    const helper = simPrivBin();
    return this.exitOk(helper ? ['-n', helper, 'noop'] : ['-n', PROBE_FALLBACK]);
  }

  /** Gate for every op that reaches root from a tty-less child: a live ticket is not enough, the
   *  installed policy must still authorise this checkout's helper or the next root call fails. */
  async preflight(): Promise<SudoPreflight> {
    // drift first: a cached ticket makes `available()` pass over a policy that authorises nothing,
    // and its generic answer would send the operator to the Sudo card, which only hides that
    const drift = sudoersDrift({ helperBin: simPrivBin(), installed: installedDropIns() });
    if (drift) return { ok: false, reason: `${drift}, so the next root call would fail — ${SETUP_HINT}.` };
    if (!(await this.available()))
      return {
        ok: false,
        reason: `sudo -n is unavailable — this op reaches root from a child with no tty, which cannot answer a password prompt. Cache sudo via the Sudo card, or ${SETUP_HINT}.`,
      };
    return { ok: true };
  }

  async cache(password: string): Promise<boolean> {
    const remainingMs = this.cooldownUntil - Date.now();
    if (remainingMs > 0) {
      throw new HttpException(
        `too many rejected sudo attempts; retry in ${Math.ceil(remainingMs / 1000)}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (this.attemptInFlight) {
      throw new HttpException('a sudo attempt is already in flight', HttpStatus.TOO_MANY_REQUESTS);
    }
    // must stay await-free between the gates above and this claim, or a concurrent burst all passes
    this.attemptInFlight = true;
    try {
      const ok = await this.exitOk(['-S', '-v'], password + '\n');
      if (ok) {
        this.rejections = 0;
        this.cooldownUntil = 0;
        this.startKeepAlive();
        return true;
      }
      this.rejections += 1;
      // counter is deliberately not cleared here, so every further rejection re-arms the cooldown
      if (this.rejections >= MAX_CONSECUTIVE_REJECTIONS) this.cooldownUntil = Date.now() + REJECTION_COOLDOWN_MS;
      this.log.warn('sudo credential rejected');
      return false;
    } finally {
      this.attemptInFlight = false;
    }
  }

  private startKeepAlive(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(async () => {
      if (!(await this.exitOk(['-n', '-v']))) {
        clearInterval(this.keepAlive);
        this.keepAlive = undefined;
      }
    }, 60_000);
    this.keepAlive.unref?.();
  }

  private exitOk(args: string[], stdin?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('sudo', args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}
