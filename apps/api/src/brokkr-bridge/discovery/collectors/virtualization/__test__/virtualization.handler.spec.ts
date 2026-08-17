import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VirtualizationHandler } from '../virtualization.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/virtualization', `${name}.json`), 'utf8'));

describe('VirtualizationHandler', () => {
  const handler = new VirtualizationHandler();

  it('maps iommu / sriov booleans onto Device', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({ iommuEnabled: true, sriovEnabled: false });
  });

  it('accepts null probe results and writes nothing for them', async () => {
    const parsed = handler.schema.parse({
      hypervisor_enabled: null,
      iommu_groups_enabled: null,
      sriov_bios_enabled: null,
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({});
  });

  it('rejects non-boolean inputs', () => {
    expect(
      handler.schema.safeParse({ hypervisor_enabled: 'yes', iommu_groups_enabled: true, sriov_bios_enabled: false })
        .success,
    ).toBe(false);
  });
});
