import { describe, expect, it, vi } from 'vitest';
import { EventLogModule } from '../event-log.module';

describe('EventLogModule', () => {
  it('hands the system finalizer to ContextService on init', () => {
    const setSystemIntentFinalizer = vi.fn();
    const finalizer = { finalize: vi.fn() };

    new EventLogModule({ setSystemIntentFinalizer } as never, finalizer as never).onModuleInit();

    expect(setSystemIntentFinalizer).toHaveBeenCalledWith(finalizer);
  });
});
