import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NvidiaHandler } from '../nvidia.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/nvidia', `${name}.json`), 'utf8'));

describe('NvidiaHandler', () => {
  const handler = new NvidiaHandler();

  it('parses happy fixture and writes Gpu upserts', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.gpus).toHaveLength(2);
    expect(mutation.upserts!.gpus![0]).toMatchObject({
      index: 0,
      model: 'NVIDIA RTX PRO 6000 Blackwell Server Edition',
      vendor: 'NVIDIA',
      uuid: 'GPU-daf80822-3f20-4f71-9842-ac5073bb2d43',
      vbiosVersion: '970088000f',
      serial: '1650724000001',
      memoryTotalMb: 183359,
    });
  });

  it('maps GPU serial when present and null when absent', async () => {
    const parsed = handler.schema.parse({
      count: 1,
      model: 'NVIDIA B200',
      gpus: [{ index: 0, name: 'NVIDIA B200', uuid: 'GPU-x' }],
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts!.gpus![0]!.serial).toBeNull();
  });

  it('preserves existing rows when collector empty (CC-mode)', async () => {
    const parsed = handler.schema.parse(fixture('empty'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toBeUndefined();
    expect(mutation.upserts).toBeUndefined();
    expect(mutation.warnings?.[0]).toMatch(/preserving existing/);
  });

  it('rejects a half-populated shape (count without gpus)', () => {
    expect(handler.schema.safeParse({ count: 1, model: 'X' }).success).toBe(false);
  });
});
