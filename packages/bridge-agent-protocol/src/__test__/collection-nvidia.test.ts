import { describe, expect, it } from 'vitest';

import { operations } from '../operations/index.js';

const GPU = {
  index: 0,
  name: 'NVIDIA H200',
  serial: '1654224209825',
  uuid: 'GPU-1f84c8ce-0986-599c-9216-75ade9cc2415',
  'temperature.gpu': 26,
  'utilization.gpu': 0,
  'memory.used': 0,
  'memory.total': 143771,
  'memory.free': 143156,
};

describe('collection.nvidia contract', () => {
  it('keeps the per-GPU serial, which an undeclared field would silently strip on the way out', () => {
    const parsed = operations['collection.nvidia'].output.parse({
      nvidia: { count: 1, model: 'NVIDIA H200', gpus: [GPU] },
    });

    expect(parsed.nvidia).toMatchObject({ gpus: [{ serial: '1654224209825' }] });
  });
});
