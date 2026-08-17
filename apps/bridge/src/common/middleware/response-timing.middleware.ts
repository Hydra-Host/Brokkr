import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, type NestMiddleware } from '@nestjs/common';

interface ResponseTimingStore {
  startNs: bigint;
}

const storage = new AsyncLocalStorage<ResponseTimingStore>();

type NextFn = (err?: unknown) => void;

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / factor;
}

export function getResponseTimingDuration(): number {
  const start = storage.getStore()?.startNs;
  if (start === undefined) return roundHalfEven(0, 2);
  const elapsedSeconds = Number(nowNs() - start) / 1e9;
  return roundHalfEven(elapsedSeconds, 2);
}

@Injectable()
export class ResponseTimingMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: NextFn): void {
    storage.run({ startNs: nowNs() }, () => next());
  }
}
