import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KernelParamsHandler } from '../kernel_params.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/kernel_params', `${name}.json`), 'utf8'));

describe('KernelParamsHandler', () => {
  const handler = new KernelParamsHandler();

  it('writes current_cmdline onto Server.kernelCmdline', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.serverUpdate?.kernelCmdline).toBe(parsed.current_cmdline);
    expect(mutation.warnings).toBeUndefined();
  });

  it('surfaces issues_detected as warnings', async () => {
    const parsed = handler.schema.parse({
      current_cmdline: 'x',
      issues_detected: ['iommu disabled in BIOS', { type: 'missing_param', param: 'cgroup_enable' }],
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.warnings).toHaveLength(2);
    expect(mutation.warnings?.[0]).toMatch(/iommu disabled/);
  });

  it('rejects empty current_cmdline', () => {
    expect(handler.schema.safeParse({ current_cmdline: '' }).success).toBe(false);
  });
});
