import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('diagnostic.write_serial_tokens');

const STTY_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 5_000;
const MAX_SETTLE_MS = 10_000;

interface WriteRequest {
  port: string;
  token: string;
  baud: number;
}

interface WriteResult {
  port: string;
  ok: boolean;
  error?: string;
}

const PORT_NAME_RE = /^tty(S|USB)\d{1,3}$/;

function devPath(port: string): string | null {
  return PORT_NAME_RE.test(port) ? `/dev/${port}` : null;
}

async function writeOne(req: WriteRequest): Promise<WriteResult> {
  const target = devPath(req.port);
  if (target === null) {
    return { port: req.port, ok: false, error: `invalid port name: ${req.port}` };
  }

  try {
    const stty = await run('stty', ['-F', target, String(req.baud), '-crtscts', '-ixon', '-ixoff', 'raw'], {
      timeout_ms: STTY_TIMEOUT_MS,
      quiet: true,
    });
    if (stty.exit_code !== 0) {
      return {
        port: req.port,
        ok: false,
        error: `stty exit=${stty.exit_code}: ${stty.stderr.trim().slice(0, 200)}`,
      };
    }
  } catch (err) {
    return { port: req.port, ok: false, error: `stty threw: ${getErrorMessage(err)}` };
  }

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const payload = Buffer.from(`\r\n${req.token}\r\n`, 'utf8');
    // O_NOCTTY: first open of a TTY otherwise becomes this process's controlling terminal, breaking agent stdio (mode 'w' doesn't set it)
    fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_NOCTTY);
    // Promise.race doesn't cancel the loser — clear the timeout or its rejection fires unhandled
    await Promise.race([
      fh.write(payload),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`write timeout after ${WRITE_TIMEOUT_MS}ms`)),
          WRITE_TIMEOUT_MS,
        );
      }),
    ]);
    return { port: req.port, ok: true };
  } catch (err) {
    return { port: req.port, ok: false, error: `write failed: ${getErrorMessage(err)}` };
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    if (fh !== null) {
      try {
        await fh.close();
      } catch (error) {
        logger.debug('serial port close failed', { port: req.port, error: getErrorMessage(error) });
      }
    }
  }
}

export function registerWriteSerialTokensDiagnostic(): void {
  registerOperation('diagnostic.write_serial_tokens', async (input, _ctx) => {
    const start = Date.now();
    logger.info('diagnostic.write_serial_tokens starting', {
      port_count: input.writes.length,
      settle_ms: input.settle_ms ?? 0,
    });

    if (input.settle_ms !== undefined && input.settle_ms > 0) {
      const settle = Math.min(input.settle_ms, MAX_SETTLE_MS);
      await new Promise((resolve) => setTimeout(resolve, settle));
    }

    const results: WriteResult[] = [];
    for (const req of input.writes) {
      results.push(await writeOne(req));
    }

    const total_duration_ms = Date.now() - start;
    const ok_count = results.filter((r) => r.ok).length;
    logger.info('diagnostic.write_serial_tokens complete', {
      ok_count,
      fail_count: results.length - ok_count,
      total_duration_ms,
    });

    return { writes: results, total_duration_ms };
  });
}
