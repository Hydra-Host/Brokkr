import { operations } from '@repo/bridge-agent-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearOperationsForTests, getHandler, type HandlerContext } from '../../../dispatch/registry';
import { registerPublicIpCollector } from '../public-ip';

const CTX: HandlerContext = {
  work_id: 'test',
  signal: new AbortController().signal,
  reportProgress: () => {},
  emit: async () => {},
  resultDelivered: Promise.resolve(),
};

async function runCollector(): Promise<unknown> {
  registerPublicIpCollector();
  const reg = getHandler('collection.public_ip');
  if (!reg) throw new Error('collection.public_ip not registered');
  return reg.handler({}, CTX);
}

describe('collection.public_ip in local simulation', () => {
  const prior = process.env.LOCAL_SIMULATION_ENABLED;
  beforeEach(() => clearOperationsForTests());
  afterEach(() => {
    if (prior === undefined) delete process.env.LOCAL_SIMULATION_ENABLED;
    else process.env.LOCAL_SIMULATION_ENABLED = prior;
  });

  it('skips the external probe and reports null IPs', async () => {
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    const result = await runCollector();
    expect(operations['collection.public_ip'].output.parse(result)).toEqual({
      public_ip: { ipv4: null, ipv6: null, check_url: 'local-simulation' },
    });
  });
});
