import { z } from 'zod';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const INCLUDE_MAJORS = '8,9,65,66,67,68,69,70,71,128,129,130,131,132,133,134,135,259';

type LsblkNode = {
  name?: string | undefined;
  mountpoint?: string | null | undefined;
  mountpoints?: (string | null)[] | undefined;
  children?: LsblkNode[] | undefined;
};
const LsblkNode: z.ZodType<LsblkNode> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    mountpoint: z.string().nullable().optional(),
    mountpoints: z.array(z.string().nullable()).optional(),
    children: z.array(LsblkNode).optional(),
  }),
);
const LsblkOutput = z.object({
  blockdevices: z.array(LsblkNode).optional(),
});

function collectMountpoints(nodes: LsblkNode[] | undefined, out: Set<string>): void {
  if (!nodes) return;
  for (const n of nodes) {
    const mps = n.mountpoints ?? (n.mountpoint ? [n.mountpoint] : []);
    for (const mp of mps) {
      if (mp && mp !== '[SWAP]') out.add(mp);
    }
    collectMountpoints(n.children, out);
  }
}

export function registerUnmounter(): void {
  registerOperation('storage.unmountDisks', async () => {
    const lsblk = await run('lsblk', ['-J', '-o', 'NAME,MOUNTPOINTS', '-I', INCLUDE_MAJORS], {
      timeout_ms: 30_000,
    });
    if (lsblk.exit_code !== 0) {
      throw new Error(`lsblk failed (exit=${lsblk.exit_code}): ${lsblk.stderr.trim()}`);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(lsblk.stdout);
    } catch (error) {
      throw new Error(`lsblk emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    const parsed = LsblkOutput.parse(rawJson);
    const mountpoints = new Set<string>();
    collectMountpoints(parsed.blockdevices, mountpoints);

    const ordered = [...mountpoints].sort((a, b) => b.length - a.length);

    const unmounted: string[] = [];
    for (const mp of ordered) {
      const check = await run('mountpoint', ['-q', mp], { timeout_ms: 5_000, quiet_nonzero: true });
      if (check.exit_code !== 0) continue;

      const umount = await run('umount', [mp], { timeout_ms: 30_000 });
      if (umount.exit_code !== 0) {
        throw new Error(`umount ${mp} failed (exit=${umount.exit_code}): ${umount.stderr.trim()}`);
      }
      unmounted.push(mp);
    }

    return { unmounted_paths: unmounted };
  });
}
