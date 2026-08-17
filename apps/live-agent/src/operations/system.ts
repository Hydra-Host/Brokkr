import { z } from 'zod';
import { callHandler } from '../dispatch/call-handler';
import { registerOperation } from '../dispatch/registry';
import { getErrorMessage } from '../errors';
import { run } from '../exec';

const EfiBootMenuSchema = z.object({
  boot_current: z.string().optional(),
  boot_order: z.array(z.string()).optional(),
  boot_options: z
    .array(
      z
        .object({
          boot_option_reference: z.string(),
          display_name: z.string(),
        })
        .passthrough(),
    )
    .optional(),
  boot_next: z.string().optional(),
});

const OS_BOOT_ENTRY_KEYWORDS = ['ubuntu', 'debian', 'proxmox', 'ipxe disk'];

export function registerSystemOperations(): void {
  registerOperation('system.getArchitecture', async () => {
    const { stdout, exit_code, stderr } = await run('uname', ['-m']);
    if (exit_code !== 0) {
      throw new Error(`uname -m failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    const raw = stdout.trim();
    const arch = raw === 'x86_64' ? 'x86_64' : raw === 'aarch64' ? 'aarch64' : 'unknown';
    return { arch, raw };
  });

  registerOperation('system.getEfiBootMenu', async () => {
    const { stdout, exit_code, stderr } = await run('sh', ['-c', 'efibootmgr | jc --efibootmgr'], {
      timeout_ms: 15_000,
    });
    if (exit_code !== 0) {
      throw new Error(`efibootmgr failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    let parsed: z.infer<typeof EfiBootMenuSchema>;
    try {
      parsed = EfiBootMenuSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new Error(`invalid boot menu JSON: ${getErrorMessage(error)}`);
    }
    return {
      boot_current: parsed.boot_current ?? null,
      boot_order: parsed.boot_order ?? null,
      boot_options: parsed.boot_options ?? null,
      boot_next: parsed.boot_next ?? null,
    };
  });

  registerOperation('system.removeEfiBootEntry', async ({ boot_id }) => {
    const { exit_code, stderr } = await run('efibootmgr', ['-B', '-b', boot_id], { timeout_ms: 15_000 });
    return { success: exit_code === 0 && !stderr.toLowerCase().includes('error') };
  });

  registerOperation('system.cleanupOsBootEntries', async (_input, ctx) => {
    const menu = await callHandler('system.getEfiBootMenu', {}, ctx);
    const removed: string[] = [];

    for (const entry of menu.boot_options ?? []) {
      const name = (entry.display_name ?? '').toLowerCase();
      if (!OS_BOOT_ENTRY_KEYWORDS.some((kw) => name.includes(kw))) continue;

      const ref = entry.boot_option_reference ?? '';
      const bootId = ref.startsWith('Boot') ? ref.slice(4) : ref;
      if (!bootId) continue;

      const { success } = await callHandler('system.removeEfiBootEntry', { boot_id: bootId }, ctx);
      if (success) removed.push(entry.display_name);
    }

    return { removed, count: removed.length };
  });

  registerOperation('system.forceBootDevice', async (_input, ctx) => {
    const menu = await callHandler('system.getEfiBootMenu', {}, ctx);
    const { boot_current, boot_order } = menu;

    if (!boot_current || !boot_order || boot_order.length === 0) {
      return { boot_current, boot_order, entries_removed: 0 };
    }

    let entriesRemoved = 0;
    for (const id of boot_order) {
      if (id === boot_current) continue;
      const { success } = await callHandler('system.removeEfiBootEntry', { boot_id: id }, ctx);
      if (success) entriesRemoved += 1;
    }

    return { boot_current, boot_order, entries_removed: entriesRemoved };
  });
}
