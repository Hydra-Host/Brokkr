import { EventEmitter } from 'events';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { toExportSink } from '../event-log-export.sink';

function fakeResponse(state: { destroyed?: boolean; writableEnded?: boolean } = {}) {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    destroyed: state.destroyed ?? false,
    writableEnded: state.writableEnded ?? false,
    headersSent: false,
  });

  return { res: res as unknown as Response, emitter };
}

describe('event-log export sink drain', () => {
  it('removes the close listener once a drain resolves the wait', async () => {
    const { res, emitter } = fakeResponse();
    const sink = toExportSink(res);

    const waiting = sink.drain();
    emitter.emit('drain');
    await waiting;

    expect(emitter.listenerCount('drain')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('removes the drain listener once a close resolves the wait', async () => {
    const { res, emitter } = fakeResponse();
    const sink = toExportSink(res);

    const waiting = sink.drain();
    emitter.emit('close');
    await waiting;

    expect(emitter.listenerCount('drain')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('holds no listeners after many backpressure cycles', async () => {
    const { res, emitter } = fakeResponse();
    const sink = toExportSink(res);

    for (let cycle = 0; cycle < 50; cycle += 1) {
      const waiting = sink.drain();
      emitter.emit('drain');
      await waiting;
    }

    expect(emitter.listenerCount('close')).toBe(0);
    expect(emitter.listenerCount('drain')).toBe(0);
  });

  it('resolves without listening when the response is already destroyed', async () => {
    const { res, emitter } = fakeResponse({ destroyed: true });
    const sink = toExportSink(res);

    await sink.drain();

    expect(emitter.listenerCount('drain')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('resolves without listening when the response already ended', async () => {
    const { res, emitter } = fakeResponse({ writableEnded: true });
    const sink = toExportSink(res);

    await sink.drain();

    expect(emitter.listenerCount('drain')).toBe(0);
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('reports a destroyed or ended response as destroyed', () => {
    expect(toExportSink(fakeResponse().res).destroyed).toBe(false);
    expect(toExportSink(fakeResponse({ destroyed: true }).res).destroyed).toBe(true);
    expect(toExportSink(fakeResponse({ writableEnded: true }).res).destroyed).toBe(true);
  });
});
