import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorPolicy } from '../../common/authz/operator-policy';
import { ContextService } from '../../common/context/context.service';
import type { LoggerService } from '../../logger/logger.service';
import { HostPluginEventBus } from '../host-plugin-event-bus';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrEventMap {
    'test.ping': { value: number };
    'test.pong': { message: string };
  }
}

describe('HostPluginEventBus', () => {
  function createBus(context?: ContextService) {
    const emitter = new EventEmitter2({ wildcard: true, maxListeners: 20 });
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };
    return { bus: new HostPluginEventBus(emitter, logger as unknown as LoggerService, context), emitter, logger };
  }

  it('delivers emitted events to registered handlers', () => {
    const { bus } = createBus();
    const handler = vi.fn();
    bus.on('test.ping', handler);

    bus.emit('test.ping', { value: 42 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('delivers a single event to every subscriber', () => {
    const { bus } = createBus();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    bus.on('test.ping', handlerA);
    bus.on('test.ping', handlerB);

    bus.emit('test.ping', { value: 1 });

    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  it('isolates handler errors — a throw in one handler does not skip siblings', () => {
    const { bus } = createBus();
    const errorHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const okHandler = vi.fn();

    bus.on('test.ping', errorHandler);
    bus.on('test.ping', okHandler);

    expect(() => bus.emit('test.ping', { value: 1 })).not.toThrow();
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(okHandler).toHaveBeenCalledOnce();
  });

  it('logs async handler rejections without surfacing them to the emitter', async () => {
    const { bus } = createBus();
    const failingHandler = vi.fn().mockRejectedValue(new Error('async boom'));
    const okHandler = vi.fn();

    bus.on('test.ping', failingHandler);
    bus.on('test.ping', okHandler);

    expect(() => bus.emit('test.ping', { value: 1 })).not.toThrow();
    expect(failingHandler).toHaveBeenCalledOnce();
    expect(okHandler).toHaveBeenCalledOnce();

    await new Promise((resolve) => setImmediate(resolve));
  });

  it('unsubscribe function returned by on() removes the handler', () => {
    const { bus } = createBus();
    const handler = vi.fn();
    const off = bus.on('test.ping', handler);

    bus.emit('test.ping', { value: 1 });
    expect(handler).toHaveBeenCalledOnce();

    off();
    bus.emit('test.ping', { value: 2 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('off() removes the handler', () => {
    const { bus } = createBus();
    const handler = vi.fn();
    bus.on('test.ping', handler);

    bus.emit('test.ping', { value: 1 });
    expect(handler).toHaveBeenCalledOnce();

    bus.off('test.ping', handler);
    bus.emit('test.ping', { value: 2 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('off() on an unknown handler is a no-op', () => {
    const { bus } = createBus();
    const handler = vi.fn();

    expect(() => bus.off('test.ping', handler)).not.toThrow();
  });

  it('does not cross-deliver between different event names', () => {
    const { bus } = createBus();
    const pingHandler = vi.fn();
    const pongHandler = vi.fn();
    bus.on('test.ping', pingHandler);
    bus.on('test.pong', pongHandler);

    bus.emit('test.ping', { value: 1 });

    expect(pingHandler).toHaveBeenCalledOnce();
    expect(pongHandler).not.toHaveBeenCalled();
  });

  it('logs sync handler throws with pluginId and requestId', () => {
    const { bus, logger } = createBus({ requestId: 'req-123' } as ContextService);
    bus.on(
      'test.ping',
      () => {
        throw new Error('boom');
      },
      { pluginId: 'acme.billing' },
    );

    bus.emit('test.ping', { value: 1 });

    expect(logger.error).toHaveBeenCalledOnce();
    const [message] = logger.error.mock.calls[0]!;
    expect(message).toContain('pluginId=acme.billing');
    expect(message).toContain('requestId=req-123');
    expect(message).not.toContain('value');
  });

  it('logs async handler rejections with pluginId and requestId', async () => {
    const { bus, logger } = createBus({ requestId: 'req-456' } as ContextService);
    bus.on('test.ping', () => Promise.reject(new Error('async boom')), { pluginId: 'acme.notify' });

    bus.emit('test.ping', { value: 7 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledOnce();
    const [message] = logger.error.mock.calls[0]!;
    expect(message).toContain('pluginId=acme.notify');
    expect(message).toContain('requestId=req-456');
  });

  it('resolves the requestId from the real ALS context inside an async handler rejection', async () => {
    const context = new ContextService({} as OperatorPolicy);
    const { bus, logger } = createBus(context);
    bus.on('test.ping', () => Promise.reject(new Error('async boom')), { pluginId: 'acme.notify' });

    context.run({ requestId: 'req-als' }, () => bus.emit('test.ping', { value: 1 }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledOnce();
    const [message] = logger.error.mock.calls[0]!;
    expect(message).toContain('requestId=req-als');
    expect(message).toContain('pluginId=acme.notify');
  });

  it('falls back to unknown/none when pluginId and request context are absent', () => {
    const { bus, logger } = createBus();
    bus.on('test.ping', () => {
      throw new Error('boom');
    });

    bus.emit('test.ping', { value: 1 });

    const [message] = logger.error.mock.calls[0]!;
    expect(message).toContain('pluginId=unknown');
    expect(message).toContain('requestId=none');
  });

  it('registering the same handler twice on one event: each off() removes exactly one listener', () => {
    const { bus, emitter } = createBus();
    const handler = vi.fn();

    const offA = bus.on('test.ping', handler);
    const offB = bus.on('test.ping', handler);
    expect(emitter.listenerCount('test.ping')).toBe(2);

    bus.emit('test.ping', { value: 1 });
    expect(handler).toHaveBeenCalledTimes(2);

    offA();
    expect(emitter.listenerCount('test.ping')).toBe(1);

    handler.mockClear();
    bus.emit('test.ping', { value: 2 });
    expect(handler).toHaveBeenCalledTimes(1);

    offB();
    expect(emitter.listenerCount('test.ping')).toBe(0);

    handler.mockClear();
    bus.emit('test.ping', { value: 3 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on()-returned unsub is registration-specific: unsub of the 2nd registration leaves the 1st live', () => {
    const { bus, emitter } = createBus();
    const handler = vi.fn();

    const unsub1 = bus.on('test.ping', handler);
    const unsub2 = bus.on('test.ping', handler);
    expect(emitter.listenerCount('test.ping')).toBe(2);

    unsub2();
    expect(emitter.listenerCount('test.ping')).toBe(1);

    bus.emit('test.ping', { value: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    handler.mockClear();
    unsub1();
    expect(emitter.listenerCount('test.ping')).toBe(0);

    bus.emit('test.ping', { value: 2 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on()-returned unsub is idempotent: calling it twice removes at most its own listener', () => {
    const { bus, emitter } = createBus();
    const handler = vi.fn();

    const unsub1 = bus.on('test.ping', handler);
    const unsub2 = bus.on('test.ping', handler);
    expect(emitter.listenerCount('test.ping')).toBe(2);

    unsub2();
    unsub2();
    expect(emitter.listenerCount('test.ping')).toBe(1);

    bus.emit('test.ping', { value: 1 });
    expect(handler).toHaveBeenCalledTimes(1);

    handler.mockClear();
    unsub1();
    expect(emitter.listenerCount('test.ping')).toBe(0);

    bus.emit('test.ping', { value: 2 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('same handler on two events: off() one leaves the other intact with no orphaned listener', () => {
    const { bus, emitter } = createBus();
    const handler = vi.fn();

    bus.on('test.ping', handler);
    bus.on('test.pong', handler);
    expect(emitter.listenerCount('test.ping')).toBe(1);
    expect(emitter.listenerCount('test.pong')).toBe(1);

    bus.off('test.ping', handler);

    expect(emitter.listenerCount('test.ping')).toBe(0);
    expect(emitter.listenerCount('test.pong')).toBe(1);

    bus.emit('test.ping', { value: 1 });
    expect(handler).not.toHaveBeenCalled();

    bus.emit('test.pong', { message: 'still here' });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ message: 'still here' });
  });
});
