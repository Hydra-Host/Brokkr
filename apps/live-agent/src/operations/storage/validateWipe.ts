import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { waitForReadReady } from './wipe';

const logger = makeLogger('storage.validateWipe');

const VALIDATION_SAMPLE_COUNT = 1000;

// Crypto-erase destroys keys but may leave stale ciphertext (DLFEAT-dependent); residual bytes are expected, not a failure.
const CRYPTO_ERASE_METHODS = new Set<string>([
  'NVMe Sanitize Crypto Erase (Purge)',
  'NVMe Format SES=2 Crypto Erase (Purge)',
  'ATA Sanitize Crypto Scramble (Purge)',
]);

// Overwrite-class methods leave NON-zero data by design, so the pass criterion is "sector differs from its pre-wipe marker", never zero-reads.
const OVERWRITE_METHODS = new Set<string>(['Random data overwrite (Clear)', 'ATA Sanitize Overwrite (Purge)']);

const MAX_UNREADABLE_FRACTION = 0.1;

export type ValidationStatus = 'pass' | 'fail' | 'pass_crypto_erase' | 'skipped';

// marker is hex-encoded to survive the agent protocol; the bytes verify overwrite-class methods actually changed the sector.
export interface ValidationMarker {
  sector: number;
  marker: string;
}

export interface ValidationResult {
  method: 'sector_sampling';
  sample_count: number;
  sectors_checked: number;
  sectors_zeroed: number;
  sectors_failed: number;
  sectors_unreadable: number;
  result: ValidationStatus;
  note?: string;
}

export function computeSampleSectors(totalSectors: number, sampleCount = VALIDATION_SAMPLE_COUNT): number[] {
  if (!Number.isFinite(totalSectors) || totalSectors < 2 * sampleCount) {
    return [];
  }
  const step = Math.floor((totalSectors - 200) / sampleCount);
  const sectors: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sectors.push(100 + i * step);
  }
  return sectors;
}

export function classifyValidationResult(
  failedCount: number,
  method: string,
): Extract<ValidationStatus, 'pass' | 'pass_crypto_erase' | 'fail'> {
  if (failedCount === 0) return 'pass';
  return CRYPTO_ERASE_METHODS.has(method) ? 'pass_crypto_erase' : 'fail';
}

export function classifyDiskWipe(args: {
  technique: string;
  validationResult: ValidationStatus | 'not_validated';
  isDevRotationalSkip: boolean;
}): 'pass' | 'fail' | 'pass_crypto_erase' {
  const { technique, validationResult, isDevRotationalSkip } = args;
  if (validationResult === 'fail') return 'fail';
  if (validationResult === 'pass_crypto_erase') return 'pass_crypto_erase';
  if (validationResult === 'pass') return 'pass';
  if (technique === 'unknown') return 'fail';
  if (isDevRotationalSkip) return 'pass';
  return 'fail';
}

export async function writeValidationMarkers(diskName: string): Promise<ValidationMarker[]> {
  const diskPath = `/dev/${diskName}`;

  const { stdout, exit_code } = await run('blockdev', ['--getsz', diskPath], {
    timeout_ms: 10_000,
  });
  if (exit_code !== 0) return [];
  const totalSectors = Number.parseInt(stdout.trim(), 10);
  const sectors = computeSampleSectors(totalSectors);
  if (sectors.length === 0) return [];

  const markers: ValidationMarker[] = [];
  const handle = await open(diskPath, 'r+');
  try {
    for (const s of sectors) {
      const bytes = randomBytes(512);
      await handle.write(bytes, 0, 512, s * 512);
      markers.push({ sector: s, marker: bytes.toString('hex') });
    }
  } finally {
    await handle.close();
  }

  return markers;
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

async function openForValidation(diskName: string, diskPath: string): Promise<FileHandle | null> {
  try {
    return await open(diskPath, 'r');
  } catch (err) {
    if (errnoCode(err) !== 'EIO') {
      logger.error('validation open() failed with a non-EIO error', {
        disk: diskName,
        code: errnoCode(err),
        err: getErrorMessage(err),
      });
      return null;
    }
    logger.warn('validation open() hit EIO; waiting out the restricted-read window before retry', {
      disk: diskName,
      err: getErrorMessage(err),
    });
  }
  try {
    await waitForReadReady(diskName);
  } catch (err) {
    logger.warn('waitForReadReady did not confirm read-ready; attempting a final open anyway', {
      disk: diskName,
      err: getErrorMessage(err),
    });
  }
  try {
    return await open(diskPath, 'r');
  } catch (err) {
    logger.error('validation open() still failing after read-ready wait; recording disk as unreadable', {
      disk: diskName,
      err: getErrorMessage(err),
    });
    return null;
  }
}

export async function validateWipe(
  diskName: string,
  markers: ValidationMarker[],
  method: string,
): Promise<ValidationResult> {
  if (markers.length === 0) {
    return {
      method: 'sector_sampling',
      sample_count: 0,
      sectors_checked: 0,
      sectors_zeroed: 0,
      sectors_failed: 0,
      sectors_unreadable: 0,
      result: 'skipped',
    };
  }

  const diskPath = `/dev/${diskName}`;
  const isOverwrite = OVERWRITE_METHODS.has(method);

  // EIO sectors count as `unreadable`, never as zeros, so a mostly-dead drive can't score a false pass.
  const failed: Array<{ sector: number }> = [];
  let zeroed = 0;
  let unreadable = 0;
  const buf = Buffer.alloc(512);
  const handle = await openForValidation(diskName, diskPath);
  if (handle === null) {
    unreadable = markers.length;
  } else {
    try {
      for (const { sector, marker } of markers) {
        try {
          await handle.read(buf, 0, 512, sector * 512);
        } catch (err: unknown) {
          logger.debug('sector read failed during validation', {
            disk: diskName,
            sector,
            err: getErrorMessage(err),
          });
          unreadable += 1;
          continue;
        }
        let nonzero = 0;
        for (const byte of buf) if (byte !== 0) nonzero++;
        if (nonzero === 0) zeroed++;

        if (isOverwrite) {
          const markerBuf = Buffer.from(marker, 'hex');
          if (buf.equals(markerBuf)) failed.push({ sector });
        } else {
          if (nonzero > 0) failed.push({ sector });
        }
      }
    } finally {
      await handle.close();
    }
  }

  const tooManyUnreadable = unreadable > 0 && unreadable / markers.length >= MAX_UNREADABLE_FRACTION;
  const classification: ValidationStatus = tooManyUnreadable ? 'fail' : classifyValidationResult(failed.length, method);

  const result: ValidationResult = {
    method: 'sector_sampling',
    sample_count: VALIDATION_SAMPLE_COUNT,
    sectors_checked: markers.length,
    sectors_zeroed: zeroed,
    sectors_failed: failed.length,
    sectors_unreadable: unreadable,
    result: classification,
  };

  if (tooManyUnreadable) {
    const pct = ((unreadable / markers.length) * 100).toFixed(1);
    result.note =
      `${unreadable}/${markers.length} (${pct}%) sampled sectors returned ` +
      `read errors; attestation requires < ${(MAX_UNREADABLE_FRACTION * 100).toFixed(0)}% ` +
      'unreadable sectors';
  } else if (classification === 'pass_crypto_erase') {
    result.note =
      'Crypto-erase destroys encryption keys; non-zero reads are expected (stale ciphertext, drive DLFEAT dependent)';
  } else if (isOverwrite && classification === 'pass') {
    result.note =
      'Overwrite wipe verified by marker diff: every sampled sector differs from its pre-wipe marker (non-zero residue is the expected post-overwrite state)';
  } else if (isOverwrite && classification === 'fail') {
    result.note = `${failed.length}/${markers.length} sampled sectors still match their pre-wipe marker (not overwritten)`;
  }

  return result;
}

export function registerWriteValidationMarkers(): void {
  registerOperation('storage.writeValidationMarkers', async ({ disk_name }: { disk_name: string }) => {
    const markers = await writeValidationMarkers(disk_name);
    return { markers };
  });
}

export function registerValidateWipe(): void {
  registerOperation(
    'storage.validateWipe',
    async ({ disk_name, markers, method }: { disk_name: string; markers: ValidationMarker[]; method: string }) => {
      return validateWipe(disk_name, markers, method);
    },
  );
}
