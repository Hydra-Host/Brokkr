import type { AgentPluginContext } from '@hydrahost/plugin-sdk';
import type { CollectionResult, WorkProgress, WorkRequest, WorkResponse } from '@repo/bridge-agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { dispatch } from '../../dispatch/dispatcher';
import { clearOperationsForTests, getHandler } from '../../dispatch/registry';
import { registerAgentPlugins } from '../register-plugins';

type OutMsg = WorkResponse | WorkProgress | CollectionResult;

function makeReq(operation: string, input: unknown): WorkRequest {
  return { type: 'work.request', work_id: 'w-plugin', operation, input };
}

afterEach(() => {
  clearOperationsForTests();
});

describe('registerAgentPlugins', () => {
  it('namespaces operations under the plugin id and serves them through dispatch', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('ping', z.object({ message: z.string() }), z.object({ echo: z.string() }), (input) => ({
              echo: input.message,
            }));
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('demo.ping')).toBeDefined();
    expect(getHandler('ping')).toBeUndefined();

    const sent: OutMsg[] = [];
    await dispatch(makeReq('demo.ping', { message: 'hi' }), async (msg) => {
      sent.push(msg);
    });

    expect(sent).toEqual([{ type: 'work.response', work_id: 'w-plugin', status: 'success', output: { echo: 'hi' } }]);
  });

  it('applies zod transforms exactly once (dispatcher parse only)', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation(
              'len',
              z.object({ value: z.string().transform((s) => s.length) }),
              z.object({ length: z.number() }),
              (input) => ({ length: input.value }),
            );
          },
        },
        enabled: true,
      },
    ]);

    const sent: OutMsg[] = [];
    await dispatch(makeReq('demo.len', { value: 'hello' }), async (msg) => {
      sent.push(msg);
    });

    expect(sent).toEqual([{ type: 'work.response', work_id: 'w-plugin', status: 'success', output: { length: 5 } }]);
  });

  it('rejects plugins whose id fails the namespace shape', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'Bad Id',
          setup({ registerOperation }) {
            registerOperation('ping', z.object({}), z.object({}), () => ({}));
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('Bad Id.ping')).toBeUndefined();
  });

  it('skips disabled plugins', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('ping', z.object({}), z.object({}), () => ({}));
          },
        },
        enabled: false,
      },
    ]);

    expect(getHandler('demo.ping')).toBeUndefined();
  });

  it("registers none of a plugin's operations when setup throws after staging some", async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('one', z.object({}), z.object({}), () => ({}));
            throw new Error('boom after staging');
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('demo.one')).toBeUndefined();
  });

  it('registers nothing when a plugin stages a duplicate operation name', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('one', z.object({}), z.object({}), () => ({}));
            registerOperation('one', z.object({}), z.object({}), () => ({}));
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('demo.one')).toBeUndefined();
  });

  it('fails a plugin wholesale when it collides with an already-registered plugin', async () => {
    const entry = (id: string) => ({
      plugin: {
        id,
        setup({ registerOperation }: AgentPluginContext) {
          registerOperation('ping', z.object({}), z.object({}), () => ({}));
        },
      },
      enabled: true,
    });

    await registerAgentPlugins([entry('demo'), entry('demo')]);

    expect(getHandler('demo.ping')).toBeDefined();
  });

  it('continues past a plugin whose setup throws', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'broken',
          setup() {
            throw new Error('boom');
          },
        },
        enabled: true,
      },
      {
        plugin: {
          id: 'healthy',
          setup({ registerOperation }) {
            registerOperation('ping', z.object({}), z.object({}), () => ({}));
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('broken.ping')).toBeUndefined();
    expect(getHandler('healthy.ping')).toBeDefined();
  });

  it('rejects operation names outside the allowed shape', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('Bad Name', z.object({}), z.object({}), () => ({}));
          },
        },
        enabled: true,
      },
    ]);

    expect(getHandler('demo.Bad Name')).toBeUndefined();
  });

  it('surfaces plugin schema validation through the dispatcher', async () => {
    await registerAgentPlugins([
      {
        plugin: {
          id: 'demo',
          setup({ registerOperation }) {
            registerOperation('ping', z.object({ message: z.string() }), z.object({ echo: z.string() }), (input) => ({
              echo: input.message,
            }));
          },
        },
        enabled: true,
      },
    ]);

    const sent: OutMsg[] = [];
    await dispatch(makeReq('demo.ping', { message: 42 }), async (msg) => {
      sent.push(msg);
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'work.response', status: 'failure', error: { code: 'INVALID_INPUT' } });
  });
});
