import type { Response } from 'express';
import type { EventLogExportSink } from './event-log-export.service';

/** Adapts Express onto the export sink. Backpressure is real here: 50,000 rows outrun a slow client,
 *  and an unawaited write queue would buffer the whole file in process memory. */
export function toExportSink(res: Response): EventLogExportSink {
  const isDead = () => res.destroyed || res.writableEnded;

  return {
    get headersSent() {
      return res.headersSent;
    },
    get destroyed() {
      return isDead();
    },
    status: (code) => res.status(code),
    setHeader: (name, value) => res.setHeader(name, value),
    json: (body) => res.json(body),
    write: (chunk) => res.write(chunk),
    // A dead stream will never emit again, so waiting on one suspends the handler forever. The two
    // live listeners cancel each other: `once` only removes the event that actually fired.
    drain: () =>
      isDead()
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const onDrain = () => {
              res.off('close', onClose);
              resolve();
            };
            const onClose = () => {
              res.off('drain', onDrain);
              resolve();
            };
            res.once('drain', onDrain);
            res.once('close', onClose);
          }),
    end: () => res.end(),
    destroy: (error) => res.destroy(error),
  };
}
