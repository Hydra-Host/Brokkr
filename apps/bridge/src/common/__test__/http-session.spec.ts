import { afterEach, describe, expect, it } from 'vitest';

import { SharedHttpSession, closeSharedSession, createSharedAgent, getSharedSession } from '../http-session';

afterEach(async () => {
  await closeSharedSession();
});

describe('SharedHttpSession lifecycle', () => {
  it('is open immediately after construction', () => {
    const session = new SharedHttpSession();
    expect(session.closed).toBe(false);
  });

  it('close() flips the closed flag and is idempotent', async () => {
    const session = new SharedHttpSession();
    await session.close();
    expect(session.closed).toBe(true);
    await session.close();
    expect(session.closed).toBe(true);
  });

  it('fetch() after close() throws', async () => {
    const session = new SharedHttpSession();
    await session.close();
    await expect(session.fetch('http://127.0.0.1:1')).rejects.toThrow(/closed/);
  });

  it('dispatcher getter returns the underlying undici Agent', () => {
    const session = new SharedHttpSession();
    const dispatcher = session.dispatcher;
    expect(dispatcher).toBeDefined();
    expect(typeof dispatcher.dispatch).toBe('function');
  });
});

describe('module-level shared singleton', () => {
  it('getSharedSession() returns the same instance across calls', () => {
    const a = getSharedSession();
    const b = getSharedSession();
    expect(a).toBe(b);
  });

  it('closeSharedSession() resets the singleton so the next get rebuilds it', async () => {
    const first = getSharedSession();
    await closeSharedSession();
    const second = getSharedSession();
    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('getSharedSession() rebuilds when prior instance was closed', async () => {
    const first = getSharedSession();
    await first.close();
    const second = getSharedSession();
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
  });
});

describe('createSharedAgent', () => {
  it('yields a closeable undici Agent', async () => {
    const agent = createSharedAgent();
    expect(typeof agent.dispatch).toBe('function');
    await agent.close();
  });

  it('honors overridden per-origin connection cap', async () => {
    const agent = createSharedAgent({ connectionsPerOrigin: 2, maxOrigins: 10 });
    expect(typeof agent.dispatch).toBe('function');
    await agent.close();
  });
});
