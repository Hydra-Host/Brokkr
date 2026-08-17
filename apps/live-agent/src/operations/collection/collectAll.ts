import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_COLLECTORS } from '@repo/bridge-agent-protocol';
import { getHandler, registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
const logger = makeLogger('collection');

let dirReady: Promise<unknown> | null = null;

function ensureCollectionsDir(dir: string): Promise<unknown> {
  if (dirReady === null) {
    dirReady = mkdir(dir, { recursive: true, mode: 0o700 }).catch((err) => {
      dirReady = null;
      throw err;
    });
  }
  return dirReady;
}

async function saveCollectorSnapshot(dir: string, collector: string, data: unknown): Promise<void> {
  try {
    await ensureCollectionsDir(dir);
    await writeFile(join(dir, `${collector}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.warn('collector snapshot write failed', { collector, message: getErrorMessage(err) });
  }
}

export function registerCollectAll(snapshotDir: string): void {
  registerOperation('collection.collectAll', async (input, ctx) => {
    const requested = input.collectors && input.collectors.length > 0 ? input.collectors : [...DEFAULT_COLLECTORS];

    const startAll = Date.now();
    let successes = 0;
    let failures = 0;

    logger.info('collection.collectAll starting', {
      work_id: ctx.work_id,
      collectors: requested.length,
    });

    await Promise.all(
      requested.map(async (name) => {
        const opName = `collection.${name}`;
        const reg = getHandler(opName);
        const start = Date.now();

        if (!reg) {
          failures += 1;
          logger.warn('collector has no registered handler', {
            collector: name,
            work_id: ctx.work_id,
          });
          if (ctx.signal.aborted) return;
          ctx
            .emit({
              type: 'collection.result',
              work_id: ctx.work_id,
              collector: name,
              status: 'failure',
              error: {
                code: 'UNKNOWN_COLLECTOR',
                message: `no handler registered for '${opName}'`,
              },
              duration_ms: Date.now() - start,
            })
            .catch((err: unknown) =>
              logger.warn('failure-result emit delivery dropped', {
                collector: name,
                work_id: ctx.work_id,
                err: getErrorMessage(err),
              }),
            );
          return;
        }

        if (ctx.signal.aborted) {
          failures += 1;
          logger.debug('collector skipped — dispatch aborted', {
            collector: name,
            work_id: ctx.work_id,
          });
          return;
        }

        logger.debug('collector starting', { collector: name, work_id: ctx.work_id });

        try {
          const data = await reg.handler({}, ctx);
          const parsed = reg.output.safeParse(data);
          if (!parsed.success) {
            failures += 1;
            logger.error('collector returned invalid output', {
              collector: name,
              work_id: ctx.work_id,
              issues: parsed.error.format(),
              duration_ms: Date.now() - start,
            });
            if (ctx.signal.aborted) return;
            ctx
              .emit({
                type: 'collection.result',
                work_id: ctx.work_id,
                collector: name,
                status: 'failure',
                error: {
                  code: 'INTERNAL_ERROR',
                  message: `collector '${name}' returned output that failed schema validation`,
                },
                duration_ms: Date.now() - start,
              })
              .catch((err: unknown) =>
                logger.warn('failure-result emit delivery dropped', {
                  collector: name,
                  work_id: ctx.work_id,
                  err: getErrorMessage(err),
                }),
              );
            return;
          }

          await saveCollectorSnapshot(snapshotDir, name, parsed.data);
          logger.debug('collector complete', {
            collector: name,
            work_id: ctx.work_id,
            duration_ms: Date.now() - start,
          });
          // Late success-emit would overwrite results:collection:data:{device_id} for a subsequent work (dispatch_meta outlives the work TTL).
          if (ctx.signal.aborted) {
            failures += 1;
            return;
          }
          try {
            await Promise.resolve(
              ctx.emit({
                type: 'collection.result',
                work_id: ctx.work_id,
                collector: name,
                status: 'success',
                data: parsed.data,
                duration_ms: Date.now() - start,
              }),
            );
            successes += 1;
          } catch (deliveryErr) {
            failures += 1;
            logger.warn('partial-result delivery failed — counting as collector failure', {
              collector: name,
              work_id: ctx.work_id,
              message: getErrorMessage(deliveryErr),
              duration_ms: Date.now() - start,
            });
          }
        } catch (error) {
          failures += 1;
          logger.warn('collector failed', {
            collector: name,
            work_id: ctx.work_id,
            message: getErrorMessage(error),
            duration_ms: Date.now() - start,
          });
          if (ctx.signal.aborted) return;
          ctx
            .emit({
              type: 'collection.result',
              work_id: ctx.work_id,
              collector: name,
              status: 'failure',
              error: {
                code: 'OPERATION_FAILED',
                message: getErrorMessage(error),
              },
              duration_ms: Date.now() - start,
            })
            .catch((err: unknown) =>
              logger.warn('failure-result emit delivery dropped', {
                collector: name,
                work_id: ctx.work_id,
                err: getErrorMessage(err),
              }),
            );
        }
      }),
    );

    logger.info('collection.collectAll complete', {
      work_id: ctx.work_id,
      successes,
      failures,
      duration_ms: Date.now() - startAll,
    });

    return {
      collectors_run: requested,
      successes,
      failures,
      total_duration_ms: Date.now() - startAll,
    };
  });
}
