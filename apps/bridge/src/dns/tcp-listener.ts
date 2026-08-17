import { getErrorMessage } from '../common/error-utils.js';

import { TCP_LENGTH_PREFIX_BYTES, deframe, frameMessage } from './tcp-framing.js';

interface TcpListenerLogger {
  warn(message: string, context: { jobId: string }): void;
}

export interface TcpConn {
  localAddress?: string;
  remoteAddress?: string;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'timeout', listener: () => void): unknown;
  write(buffer: Buffer): unknown;
  destroy(err?: Error): unknown;
  setTimeout(ms: number, callback?: () => void): unknown;
}

export interface TcpServer {
  on(event: 'connection', listener: (conn: TcpConn) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  listen(port: number, host: string, backlog: number, callback: () => void): unknown;
  close(callback?: (err?: Error) => void): unknown;
}

export interface TcpConnDeps {
  resolve: (query: Buffer, listenIp: string) => Promise<Buffer | null>;
  listenIp: string;
  maxMessageBytes: number;
  idleTimeoutMs: number;
  maxQueriesPerConn: number;
  logger: TcpListenerLogger;
  jobId: string;
}

export function handleTcpConnection(conn: TcpConn, deps: TcpConnDeps): void {
  let chunks: Buffer[] = [];
  let bufferedLength = 0;
  let queryCount = 0;
  let destroyed = false;
  // Distinct from `destroyed` (false until the deferred teardown runs so queued replies flush): draining short-circuits the data handler so new bytes can't race a second teardown ahead of that flush.
  let draining = false;
  let processing: Promise<void> = Promise.resolve();

  const teardown = (err?: Error): void => {
    if (destroyed) return;
    destroyed = true;
    conn.destroy(err);
  };

  // net.Socket.setTimeout(ms, cb) appends a one-time 'timeout' listener per call — register teardown once and re-arm without a callback so listeners don't stack.
  conn.on('timeout', () => {
    teardown();
  });
  const armIdleTimer = (): void => {
    conn.setTimeout(deps.idleTimeoutMs);
  };
  armIdleTimer();

  const processMessage = (message: Buffer): void => {
    processing = processing.then(async () => {
      if (destroyed) return;
      if (message.length === 0) {
        teardown();
        return;
      }
      if (message.length > deps.maxMessageBytes) {
        teardown();
        return;
      }
      if (queryCount >= deps.maxQueriesPerConn) {
        teardown();
        return;
      }
      let response: Buffer | null;
      try {
        response = await deps.resolve(message, deps.listenIp);
      } catch (error) {
        deps.logger.warn(`DNS TCP resolve failed: ${getErrorMessage(error)}`, { jobId: deps.jobId });
        teardown();
        return;
      }
      if (response === null) {
        teardown();
        return;
      }
      if (destroyed) return;
      try {
        conn.write(frameMessage(response));
      } catch (error) {
        deps.logger.warn(`DNS TCP write failed: ${getErrorMessage(error)}`, { jobId: deps.jobId });
        teardown();
        return;
      }
      queryCount += 1;
    });
  };

  const headDeclaredLength = (): number | null => {
    if (bufferedLength < TCP_LENGTH_PREFIX_BYTES) {
      return null;
    }
    if (chunks[0].length < TCP_LENGTH_PREFIX_BYTES) {
      chunks = [Buffer.concat(chunks)];
    }
    return chunks[0].readUInt16BE(0);
  };

  conn.on('data', (chunk: Buffer) => {
    // Invariant: draining implies imminent teardown; letting draining clear without destroying would wedge the connection here.
    if (destroyed || draining) return;
    armIdleTimer();
    chunks.push(chunk);
    bufferedLength += chunk.length;

    const headLen = headDeclaredLength();
    if (headLen === null) {
      return;
    }
    if (headLen > deps.maxMessageBytes) {
      draining = true;
      void processing.finally(teardown);
      return;
    }
    if (bufferedLength < TCP_LENGTH_PREFIX_BYTES + headLen) {
      return;
    }

    const { messages, remainder } = deframe(Buffer.concat(chunks));
    chunks = remainder.length > 0 ? [remainder] : [];
    bufferedLength = remainder.length;

    for (const message of messages) {
      processMessage(message);
    }

    const nextHeadLen = headDeclaredLength();
    if (nextHeadLen !== null && nextHeadLen > deps.maxMessageBytes) {
      // A synchronous teardown would race ahead of the just-queued async replies and drop them.
      draining = true;
      void processing.finally(teardown);
      return;
    }
  });

  conn.on('end', () => {
    processing
      .then(() => {
        teardown();
      })
      .catch(() => {
        teardown();
      });
  });

  conn.on('error', (error: Error) => {
    deps.logger.warn(`DNS TCP connection error: ${getErrorMessage(error)}`, { jobId: deps.jobId });
    teardown();
  });

  conn.on('close', () => {
    teardown();
  });
}
