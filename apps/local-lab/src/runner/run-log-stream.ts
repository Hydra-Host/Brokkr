import { concat, map, Observable, of } from 'rxjs';

import type { StreamDoneEvent } from '../contract';

export type RunLogFrame = { data: { line: string } | StreamDoneEvent };

// terminal frame of a finite run stream — concat emits it once live$ completes (run finalized), so
// the client's reconnect classifier can tell a completed stream from a dropped connection.
export const DONE_FRAME: { data: StreamDoneEvent } = { data: { done: true } };

export function runLogFrames(stream: { backlog: string; live$: Observable<string> }): Observable<RunLogFrame> {
  return concat(
    of({ data: { line: stream.backlog } }),
    stream.live$.pipe(map((line) => ({ data: { line } }))),
    of(DONE_FRAME),
  );
}
