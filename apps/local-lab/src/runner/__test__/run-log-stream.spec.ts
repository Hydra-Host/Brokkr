import { Subject } from 'rxjs';

import { runLogFrames } from '../run-log-stream';

describe('runLogFrames', () => {
  const collect = (backlog: string, live$: Subject<string>) => {
    const frames: unknown[] = [];
    let completed = false;
    runLogFrames({ backlog, live$ }).subscribe({
      next: (f) => frames.push(f.data),
      complete: () => {
        completed = true;
      },
    });
    return { frames, isCompleted: () => completed };
  };

  it('emits backlog, live lines, then {done:true} as the final frame', () => {
    const live$ = new Subject<string>();
    const { frames, isCompleted } = collect('B', live$);
    live$.next('l1');
    expect(isCompleted()).toBe(false);
    live$.complete();
    expect(frames).toEqual([{ line: 'B' }, { line: 'l1' }, { done: true }]);
    expect(isCompleted()).toBe(true);
  });

  it('closes an already-finished run with backlog + done', () => {
    const live$ = new Subject<string>();
    live$.complete();
    const { frames, isCompleted } = collect('B', live$);
    expect(frames).toEqual([{ line: 'B' }, { done: true }]);
    expect(isCompleted()).toBe(true);
  });
});
