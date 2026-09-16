import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LogLineEventSchema, parseSseEvent, StreamDoneEventSchema, streamPaths, WS_TOKEN_PROTOCOL } from './streams';

describe('streamPaths', () => {
  it('builds each SSE/WS path', () => {
    expect(streamPaths.run('r0')).toBe('/api/runs/r0/stream');
    expect(streamPaths.fleetProcessLogs()).toBe('/api/fleet/process-logs/stream');
    expect(streamPaths.testEvents('r3')).toBe('/api/tests/runs/r3/events/stream');
    expect(streamPaths.fleetShell('cpu-1')).toBe('/api/fleet/shell?node=cpu-1');
    expect(streamPaths.stackInitLog('hub:init')).toBe('/api/stack/init/hub%3Ainit/log');
  });

  it('url-encodes interpolated params', () => {
    expect(streamPaths.fleetShell('a b/c')).toBe('/api/fleet/shell?node=a%20b%2Fc');
    expect(streamPaths.run('a/b')).toBe('/api/runs/a%2Fb/stream');
    expect(streamPaths.testEvents('a/b')).toBe('/api/tests/runs/a%2Fb/events/stream');
    expect(streamPaths.stackInitLog('../../etc/passwd')).toBe('/api/stack/init/..%2F..%2Fetc%2Fpasswd/log');
  });
});

describe('WS_TOKEN_PROTOCOL', () => {
  it('is the marker the lab and the browser both offer on a ws upgrade', () => {
    expect(WS_TOKEN_PROTOCOL).toBe('lab.token');
  });
});

describe('StreamDoneEventSchema', () => {
  it('parses the sentinel and stays disjoint from log frames', () => {
    expect(parseSseEvent(StreamDoneEventSchema, JSON.stringify({ done: true }))).toEqual({ done: true });
    expect(parseSseEvent(StreamDoneEventSchema, JSON.stringify({ done: false }))).toBeNull();
    expect(parseSseEvent(StreamDoneEventSchema, JSON.stringify({ line: 'x' }))).toBeNull();
    expect(parseSseEvent(LogLineEventSchema, JSON.stringify({ done: true }))).toBeNull();
  });
});

describe('parseSseEvent', () => {
  it('parses a valid log frame', () => {
    expect(parseSseEvent(LogLineEventSchema, JSON.stringify({ line: 'hi' }))).toEqual({ line: 'hi' });
  });

  it('returns null for non-JSON or a non-conforming frame', () => {
    expect(parseSseEvent(LogLineEventSchema, 'not json')).toBeNull();
    expect(parseSseEvent(LogLineEventSchema, JSON.stringify({ line: 42 }))).toBeNull();
    expect(parseSseEvent(LogLineEventSchema, JSON.stringify({ other: 'x' }))).toBeNull();
  });

  it('works with an arbitrary frame schema', () => {
    const schema = z.object({ id: z.number() });
    expect(parseSseEvent(schema, JSON.stringify({ id: 7 }))).toEqual({ id: 7 });
    expect(parseSseEvent(schema, JSON.stringify({ id: 'nope' }))).toBeNull();
  });
});
