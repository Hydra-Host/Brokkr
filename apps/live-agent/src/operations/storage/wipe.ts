import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('storage.wipe');

const ATA_TEMP_PASSWORD = 'brokkr';

export interface WipeCommand {
  cmd: string;
  args: string[];
  trackProgress?: boolean;
}

export interface WipeMethod {
  // NIST technique label; must match CRYPTO_ERASE_METHODS in validateWipe.ts.
  name: string;
  commands: WipeCommand[];
}

const NVME_NAMESPACE_RE = /^(nvme\d+)(n\d+)?$/;
export function nvmeController(name: string): string {
  const m = name.match(NVME_NAMESPACE_RE);
  return m ? m[1]! : name;
}

// One `nvme sanitize /dev/nvmeX` erases every namespace; all other NVMe methods are namespace-scoped, so dedup must inspect the ACTUAL method used before letting a sibling inherit the wipe.
const NVME_CONTROLLER_WIDE_METHODS = new Set<string>([
  'NVMe Sanitize Crypto Erase (Purge)',
  'NVMe Sanitize Block Erase (Purge)',
]);
export function isControllerWideNvmeSanitize(method: string): boolean {
  return NVME_CONTROLLER_WIDE_METHODS.has(method);
}

export function wipeStrategies(
  disk_name: string,
  disk_type: 'nvme' | 'ssd' | 'rotational',
  is_raid: boolean,
  environment: 'production' | 'development',
  controllerHasPreservedSibling = false,
): WipeMethod[] {
  const disk = `/dev/${disk_name}`;

  if (disk_type === 'nvme') {
    const ctrl = `/dev/${nvmeController(disk_name)}`;
    const controllerWide: WipeMethod[] = controllerHasPreservedSibling
      ? []
      : [
          {
            name: 'NVMe Sanitize Crypto Erase (Purge)',
            commands: [{ cmd: 'nvme', args: ['sanitize', ctrl, '--sanact=4', '--ause'] }],
          },
          {
            name: 'NVMe Sanitize Block Erase (Purge)',
            commands: [{ cmd: 'nvme', args: ['sanitize', ctrl, '--sanact=2', '--ause'] }],
          },
        ];
    return [
      ...controllerWide,
      {
        name: 'NVMe Format SES=2 Crypto Erase (Purge)',
        commands: [{ cmd: 'nvme', args: ['format', disk, '--ses=2', '--force'] }],
      },
      {
        name: 'NVMe Format SES=1 (user-data erase, Clear)',
        commands: [{ cmd: 'nvme', args: ['format', disk, '--ses=1', '--force'] }],
      },
      {
        name: 'blkdiscard (best-effort, not standards-classified)',
        commands: [{ cmd: 'blkdiscard', args: ['-f', disk] }],
      },
    ];
  }

  if (disk_type === 'ssd') {
    // ATA commands hang indefinitely on RAID HBAs; blkdiscard only.
    if (is_raid) {
      return [
        {
          name: 'blkdiscard (best-effort, not standards-classified)',
          commands: [{ cmd: 'blkdiscard', args: ['-f', disk] }],
        },
      ];
    }

    return [
      {
        name: 'ATA Sanitize Crypto Scramble (Purge)',
        commands: [{ cmd: 'hdparm', args: ['--sanitize-crypto-scramble-ext', disk] }],
      },
      {
        name: 'ATA Sanitize Block Erase (Purge)',
        commands: [{ cmd: 'hdparm', args: ['--sanitize-block-erase-ext', disk] }],
      },
      {
        name: 'ATA Secure Erase Enhanced (Purge, legacy)',
        commands: [
          {
            cmd: 'hdparm',
            args: ['--user-master', 'u', '--security-set-pass', ATA_TEMP_PASSWORD, disk],
          },
          {
            cmd: 'hdparm',
            args: ['--user-master', 'u', '--security-erase-enhanced', ATA_TEMP_PASSWORD, disk],
          },
        ],
      },
      {
        name: 'blkdiscard (best-effort, not standards-classified)',
        commands: [{ cmd: 'blkdiscard', args: ['-f', disk] }],
      },
    ];
  }

  if (environment === 'development') {
    return [
      {
        name: 'Partition table wipe (development mode)',
        commands: [{ cmd: 'dd', args: ['if=/dev/zero', `of=${disk}`, 'bs=1M', 'count=1'] }],
      },
    ];
  }

  const ddRandom: WipeMethod = {
    name: 'Random data overwrite (Clear)',
    commands: [
      {
        cmd: 'dd',
        args: ['if=/dev/urandom', `of=${disk}`, 'bs=1M', 'status=progress'],
        trackProgress: true,
      },
    ],
  };

  if (is_raid) {
    return [ddRandom];
  }

  return [
    {
      name: 'ATA Sanitize Overwrite (Purge)',
      commands: [{ cmd: 'hdparm', args: ['--sanitize-overwrite-ext', disk] }],
    },
    {
      name: 'ATA Secure Erase Enhanced (Purge, legacy)',
      commands: [
        {
          cmd: 'hdparm',
          args: ['--user-master', 'u', '--security-set-pass', ATA_TEMP_PASSWORD, disk],
        },
        {
          cmd: 'hdparm',
          args: ['--user-master', 'u', '--security-erase-enhanced', ATA_TEMP_PASSWORD, disk],
        },
      ],
    },
    {
      name: 'ATA Secure Erase (Clear, legacy)',
      commands: [
        {
          cmd: 'hdparm',
          args: ['--user-master', 'u', '--security-set-pass', ATA_TEMP_PASSWORD, disk],
        },
        {
          cmd: 'hdparm',
          args: ['--user-master', 'u', '--security-erase', ATA_TEMP_PASSWORD, disk],
        },
      ],
    },
    ddRandom,
  ];
}

const LONG_WIPE_TIMEOUT_MS = 8 * 3600 * 1000;

const DD_PROGRESS_RE = /^(\d+)\s+bytes/;

// Some NVMe controllers (e.g. Kioxia KCD6XLUL) report Sanitize "complete" before internal verify finishes; reads in that NODMMAS window return EIO.
export async function waitForReadReady(diskName: string): Promise<void> {
  const maxAttempts = 60;
  const sleepMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await run(
      'dd',
      [`if=/dev/${diskName}`, 'of=/dev/null', 'bs=4096', 'count=1', 'iflag=direct', 'status=none'],
      { timeout_ms: 10_000, quiet_nonzero: true },
    );
    if (probe.exit_code === 0) {
      if (attempt > 1) {
        logger.info('drive became read-ready', {
          disk: diskName,
          attempts: attempt,
          elapsed_ms: (attempt - 1) * sleepMs,
        });
      }
      return;
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  throw new Error(
    `/dev/${diskName} did not exit restricted-read state within ${(maxAttempts * sleepMs) / 1000}s ` +
      `after sanitize — drive controller still rejecting reads`,
  );
}

async function getDiskSizeBytes(diskPath: string): Promise<number> {
  const { stdout, exit_code } = await run('blockdev', ['--getsize64', diskPath], {
    timeout_ms: 10_000,
  });
  if (exit_code !== 0) return 0;
  const n = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// ATA secure-erase sets a password before erasing; if the erase then fails, the drive is left SEC-locked, poisoning every later strategy and retry.
function isAtaSecurityMethod(method: WipeMethod): boolean {
  return method.commands.some((c) => c.args.includes('--security-set-pass'));
}

const SECURITY_ERASE_FLAGS = ['--security-erase', '--security-erase-enhanced'];

// Nonzero exit when security isn't set; a frozen drive needs a power cycle we can't do here.
async function securityDisable(disk: string): Promise<void> {
  try {
    await run('hdparm', ['--user-master', 'u', '--security-disable', ATA_TEMP_PASSWORD, disk], {
      timeout_ms: 60_000,
      quiet_nonzero: true,
    });
  } catch (err) {
    logger.debug('security-disable recovery failed (tolerated)', { disk, message: getErrorMessage(err) });
  }
}

export async function runMethod(
  method: WipeMethod,
  disk: string,
  onProgress?: (ratio: number, message: string) => void,
  totalBytesForProgress?: number,
): Promise<boolean> {
  const ata = isAtaSecurityMethod(method);
  // Clear a leftover password from a prior interrupted run so set-pass doesn't fail with "security password already set".
  if (ata) await securityDisable(disk);

  try {
    for (const step of method.commands) {
      const trackProgress = step.trackProgress && onProgress && (totalBytesForProgress ?? 0) > 0;
      const isLongErase = step.args.some((a) => SECURITY_ERASE_FLAGS.includes(a));
      let lastReported = 0;
      const result = await run(step.cmd, step.args, {
        timeout_ms: step.trackProgress || isLongErase ? LONG_WIPE_TIMEOUT_MS : 600_000,
        onStderrLine: trackProgress
          ? (line) => {
              const match = line.trim().match(DD_PROGRESS_RE);
              if (!match) return;
              const bytes = Number.parseInt(match[1]!, 10);
              const ratio = Math.min(1, bytes / totalBytesForProgress!);
              if (ratio - lastReported >= 0.05 || ratio >= 1) {
                lastReported = ratio;
                onProgress(ratio, `${method.name}: ${bytes} / ${totalBytesForProgress} bytes`);
              }
            }
          : undefined,
      });
      if (result.exit_code !== 0) {
        if (ata) await securityDisable(disk);
        return false;
      }
    }
    return true;
  } catch (err) {
    if (ata) await securityDisable(disk);
    throw err;
  }
}

export function registerDiskWiper(): void {
  registerOperation(
    'storage.wipeDisk',
    async ({ disk_name, disk_type, is_raid_controller, environment, controller_has_preserved_sibling }, ctx) => {
      const disk = `/dev/${disk_name}`;

      const strategies = wipeStrategies(
        disk_name,
        disk_type,
        is_raid_controller,
        environment,
        controller_has_preserved_sibling,
      );
      const needsTotalBytes = strategies.some((m) => m.commands.some((c) => c.trackProgress));
      const totalBytes = needsTotalBytes ? await getDiskSizeBytes(disk) : 0;

      let methodUsed = '';
      for (const method of strategies) {
        const ok = await runMethod(method, disk, (ratio, message) => ctx.reportProgress(ratio, message), totalBytes);
        if (ok) {
          methodUsed = method.name;
          break;
        }
      }

      if (!methodUsed) {
        throw new Error(`all wipe methods failed for /dev/${disk_name}`);
      }

      if (disk_type === 'nvme') {
        await waitForReadReady(disk_name);
      }

      return { method_used: methodUsed };
    },
  );
}
