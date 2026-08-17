import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CollectorContext } from '../../collector.types';
import { GhwCpuHandler } from '../ghw_cpu.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_cpu', `${name}.json`), 'utf8'));

function fakeCtx(rawBundle: CollectorContext['rawBundle']): CollectorContext {
  return {
    runId: 'run-1',
    deviceId: 'device-1',
    device: {} as CollectorContext['device'],
    rawBundle,
    logger: {} as CollectorContext['logger'],
  };
}

describe('GhwCpuHandler', () => {
  const handler = new GhwCpuHandler();

  it('emits a Cpu upsert per processor with per-socket fidelity', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);

    expect(mutation.upserts?.cpus).toHaveLength(2);
    expect(mutation.upserts?.cpus).toEqual([
      {
        socketIndex: 0,
        model: 'Intel(R) Xeon(R) 6767P',
        vendor: 'GenuineIntel',
        coreCount: 64,
        threadCount: 128,
        capabilities: ['fpu', 'vme', 'vmx', 'tdx_guest'],
      },
      {
        socketIndex: 1,
        model: 'Intel(R) Xeon(R) 6767P',
        vendor: 'GenuineIntel',
        coreCount: 64,
        threadCount: 128,
        capabilities: ['fpu', 'vme', 'vmx', 'tdx_guest'],
      },
    ]);
  });

  it('pulls architecture from the sibling architecture collector when present', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed, fakeCtx({ architecture: { machine: 'x86_64' } }));

    expect(mutation.upserts?.cpus?.every((c) => c.architecture === 'x86_64')).toBe(true);
  });

  it('omits architecture from the upsert when the sibling collector is missing', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed, fakeCtx({}));

    for (const cpu of mutation.upserts?.cpus ?? []) {
      expect(cpu).not.toHaveProperty('architecture');
    }
  });

  it('omits architecture when the architecture collector payload is malformed', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed, fakeCtx({ architecture: { not_machine: 'x86_64' } }));

    for (const cpu of mutation.upserts?.cpus ?? []) {
      expect(cpu).not.toHaveProperty('architecture');
    }
  });

  it('omits vendor when ghw_cpu does not provide it', async () => {
    const parsed = handler.schema.parse({
      cpu: {
        total_cores: 4,
        total_threads: 8,
        processors: [{ id: 0, model: 'Some CPU', total_cores: 4, total_threads: 8 }],
      },
    });
    const mutation = await handler.handle(parsed);

    expect(mutation.upserts?.cpus?.[0]).not.toHaveProperty('vendor');
  });

  it('skips sockets where hardwareString() normalised the model to null', async () => {
    const parsed = handler.schema.parse({
      cpu: {
        total_cores: 64,
        total_threads: 128,
        processors: [
          {
            id: 0,
            model: 'Intel(R) Xeon(R) 6767P',
            vendor: 'GenuineIntel',
            total_cores: 32,
            total_threads: 64,
          },
          {
            id: 1,
            model: 'To Be Filled By O.E.M.',
            vendor: 'GenuineIntel',
            total_cores: 32,
            total_threads: 64,
          },
        ],
      },
    });
    const mutation = await handler.handle(parsed);

    expect(mutation.upserts?.cpus).toHaveLength(1);
    expect(mutation.upserts?.cpus?.[0].socketIndex).toBe(0);
    expect(mutation.upserts?.cpus?.[0].model).toBe('Intel(R) Xeon(R) 6767P');
  });

  it('rejects empty processors array', () => {
    expect(handler.schema.safeParse({ cpu: { total_cores: 1, total_threads: 1, processors: [] } }).success).toBe(false);
  });

  it('emits no cpus when the first processor has no model', async () => {
    const parsed = handler.schema.parse({
      cpu: { total_cores: 1, total_threads: 1, processors: [{ id: 0, model: '' }] },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts).toBeUndefined();
  });
});
