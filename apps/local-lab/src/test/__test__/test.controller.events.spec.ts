import { EMPTY } from 'rxjs';

import { TestController } from '../test.controller';

import type { TestEvent } from '../../contract';
import type { TestService } from '../test.service';

describe('TestController.eventStream done sentinel', () => {
  it('replays the backlog then closes with {done:true} for a finished run', () => {
    const evt: TestEvent = { id: 1, runId: 'r1', timestamp: 1, source: 'lab', level: 'info', message: 'm' };
    const tests = { eventStream: () => ({ backlog: [evt], live$: EMPTY }) };
    const frames: unknown[] = [];
    let completed = false;
    new TestController(tests as unknown as TestService).eventStream('r1').subscribe({
      next: (f) => frames.push(f.data),
      complete: () => {
        completed = true;
      },
    });
    expect(frames).toEqual([evt, { done: true }]);
    expect(completed).toBe(true);
  });
});
