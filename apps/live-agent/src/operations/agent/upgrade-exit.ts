import { run } from '../../exec';
import { makeLogger } from '../../logger';
const logger = makeLogger('agent');

export async function daemonReload(): Promise<void> {
  const res = await run('systemctl', ['daemon-reload'], { timeout_ms: 5_000 });
  if (res.exit_code !== 0) {
    logger.warn('systemctl daemon-reload non-zero exit', {
      exit_code: res.exit_code,
      stderr: res.stderr,
    });
  }
}

// Await drain so the bridge sees success before exit; on delivery failure DO NOT exit — staying on old code lets version-drift detection re-dispatch, and the on-disk write is idempotent.
export function scheduleExit(unitReplaced: boolean, drain: Promise<void>): void {
  void (async () => {
    try {
      await drain;
    } catch (err) {
      logger.warn('result delivery failed; staying on old bundle for bridge-driven retry', {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    logger.info('upgrade applied, exiting for systemd restart', { unitReplaced });
    if (unitReplaced) {
      try {
        await daemonReload();
      } catch (error) {
        logger.warn('daemon-reload failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
    process.exit(0);
  })();
}
