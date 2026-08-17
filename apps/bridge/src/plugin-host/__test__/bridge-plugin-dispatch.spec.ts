import { describe, expect, it } from 'vitest';

import type { DispatchOptions } from '../../agent/dispatch/dispatcher.service.js';

import { PrefixedBridgeAgentDispatch } from '../bridge-plugin-dispatch.js';

interface RecordedCall {
  deviceId: string;
  operation: string;
  input: unknown;
  options: DispatchOptions | undefined;
}

describe('PrefixedBridgeAgentDispatch', () => {
  it('prefixes operations with the plugin id and forwards options', async () => {
    const calls: RecordedCall[] = [];
    const dispatch = new PrefixedBridgeAgentDispatch(
      {
        dispatch: async (deviceId, operation, input, options) => {
          calls.push({ deviceId, operation, input, options });
          return { pong: true };
        },
      },
      'demo',
    );

    const signal = new AbortController().signal;
    const result = await dispatch.dispatch('dev-9', 'ping', { message: 'hi' }, { timeoutS: 5, signal });

    expect(result).toEqual({ pong: true });
    expect(calls).toEqual([
      { deviceId: 'dev-9', operation: 'demo.ping', input: { message: 'hi' }, options: { timeoutS: 5, signal } },
    ]);
  });

  it('defaults the timeout to null when unset', async () => {
    let captured: DispatchOptions | undefined;
    const dispatch = new PrefixedBridgeAgentDispatch(
      {
        dispatch: async (_deviceId, _operation, _input, options) => {
          captured = options;
          return null;
        },
      },
      'demo',
    );

    await dispatch.dispatch('dev-9', 'ping', {});

    expect(captured).toEqual({ timeoutS: null });
  });
});
