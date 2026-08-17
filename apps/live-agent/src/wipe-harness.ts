import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { getHandler, type HandlerContext } from './dispatch/registry';
import { ensureError, getErrorMessage } from './errors';
import { run } from './exec';
import { registerCollectionOperations } from './operations/collection/index';
import { registerStorageOperations } from './operations/storage/index';
import { registerSystemOperations } from './operations/system';

registerSystemOperations();
registerCollectionOperations('wipe-harness-0.0.0', '/tmp/brokkr-harness-snapshots');
registerStorageOperations();

const CTX: HandlerContext = {
  work_id: 'wipe-harness',
  job_id: 'wipe-harness',
  signal: new AbortController().signal,
  resultDelivered: Promise.resolve(),
  reportProgress: (pct: number, msg?: string) => {
    const bar = Math.floor(pct * 40);
    const filled = '█'.repeat(bar);
    const empty = '░'.repeat(40 - bar);
    process.stderr.write(`\r  [${filled}${empty}] ${(pct * 100).toFixed(1)}%  ${msg ?? ''}   `);
    if (pct >= 1) process.stderr.write('\n');
  },
  emit: async () => {},
};

async function dispatch(op: string, input: unknown): Promise<unknown> {
  const reg = getHandler(op);
  if (!reg) throw new Error(`op not registered: ${op}`);
  const start = Date.now();
  console.error(`\n>>> ${op}`);
  try {
    const result = await reg.handler(input, CTX);
    const dur = Date.now() - start;
    console.error(`<<< ${op} OK (${dur}ms)`);
    return result;
  } catch (error) {
    console.error(`!!! ${op} THREW: ${getErrorMessage(error)}`);
    throw error;
  }
}

const WipeResult = z.object({
  sanitization_report: z.record(z.string(), z.unknown()),
  optimal_os_disk: z.record(z.string(), z.unknown()).nullable(),
});

async function main(): Promise<void> {
  const mode = process.argv[2];
  const layoutPath = process.argv[3];

  if (mode !== 'full' && mode !== 'selective') {
    console.error('usage: wipe-harness.js <full|selective> [layout.json]');
    process.exit(2);
  }

  let disk_layouts: unknown = null;
  if (mode === 'selective') {
    if (!layoutPath) {
      console.error('selective mode requires a layout JSON path');
      process.exit(2);
    }
    disk_layouts = JSON.parse(await readFile(layoutPath, 'utf-8'));
  }

  console.error('==== NIST SP 800-88r2 disk sanitization (TS wipeDisks) ====');
  console.error(`  mode: ${mode}`);
  console.error(`  layout: ${disk_layouts ? JSON.stringify(disk_layouts, null, 2) : '(null = wipe all)'}`);
  console.error('');

  console.error('[harness-prelude] umount -R /target (cleans chroot bind mounts)');
  await run('umount', ['-R', '/target'], { timeout_ms: 30_000 });
  console.error('');

  const t0 = Date.now();
  const result = WipeResult.parse(
    await dispatch('storage.wipeDisks', {
      disk_layouts,
      environment: 'development',
      job_id: 'wipe-harness',
    }),
  );
  const totalMs = Date.now() - t0;

  const reportJson = JSON.stringify(result.sanitization_report, null, 2);
  await writeFile('/tmp/wipe-report.json', reportJson);
  await writeFile('/tmp/wipe-harness-result.json', JSON.stringify(result, null, 2));

  console.error('\n==== RESULT ====');
  console.error(`total elapsed: ${(totalMs / 1000).toFixed(1)}s`);
  console.error(`optimal os disk: ${JSON.stringify(result.optimal_os_disk)}`);
  console.error('\nsanitization_report written to /tmp/wipe-report.json');
  console.error('full result (with optimal_os_disk) written to /tmp/wipe-harness-result.json');
  console.error('\n--- REPORT JSON ---');
  console.info(reportJson);
}

main().catch((error) => {
  console.error(`\nfatal: ${ensureError(error).stack ?? getErrorMessage(error)}`);
  process.exit(1);
});
