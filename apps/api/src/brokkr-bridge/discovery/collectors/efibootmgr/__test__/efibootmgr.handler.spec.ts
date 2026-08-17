import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EfibootmgrHandler } from '../efibootmgr.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/efibootmgr', `${name}.json`), 'utf8'));

describe('EfibootmgrHandler', () => {
  const handler = new EfibootmgrHandler();

  it('strips Boot prefix, marks current, and indexes in order', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    const entries = mutation.upserts!.uefiBootEntries!;
    expect(entries).toHaveLength(4);

    const current = entries.find((e) => e.bootOptionReference === '0008');
    expect(current).toMatchObject({ isCurrent: true, bootOrderIndex: 0, enabled: true });

    const orphan = entries.find((e) => e.bootOptionReference === '000F');
    expect(orphan).toMatchObject({ isCurrent: false, bootOrderIndex: null, enabled: false });
  });

  it('handles missing boot_order and boot_current gracefully', async () => {
    const parsed = handler.schema.parse({
      boot_options: [{ boot_option_reference: 'Boot0000', display_name: 'X', boot_option_enabled: true }],
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.uefiBootEntries).toEqual([
      {
        bootOptionReference: '0000',
        displayName: 'X',
        uefiDevicePath: null,
        enabled: true,
        bootOrderIndex: null,
        isCurrent: false,
      },
    ]);
  });
});
