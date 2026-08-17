import { z } from 'zod';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const INCLUDE_MAJORS = '8,9,65,66,67,68,69,70,71,128,129,130,131,132,133,134,135,259';

const RawLsblkDevice = z.object({
  name: z.string().optional(),
  rota: z.boolean().optional(),
  type: z.string().optional(),
  size: z.number().optional(),
  ro: z.boolean().optional(),
  model: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  wwn: z.string().nullable().optional(),
  tran: z.string().nullable().optional(),
  mountpoints: z.array(z.string().nullable()).optional(),
});

const LsblkOutput = z.object({
  blockdevices: z.array(RawLsblkDevice).optional(),
});

export function registerDiskDiscoverer(): void {
  registerOperation('storage.discoverDisks', async () => {
    const { stdout, exit_code, stderr } = await run(
      'lsblk',
      ['-J', '-b', '-o', 'NAME,ROTA,TYPE,SIZE,RO,MODEL,SERIAL,WWN,TRAN,MOUNTPOINTS', '-I', INCLUDE_MAJORS],
      { timeout_ms: 30_000 },
    );
    if (exit_code !== 0) {
      throw new Error(`lsblk failed (exit=${exit_code}): ${stderr.trim()}`);
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`lsblk emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    const parsed = LsblkOutput.parse(rawJson);

    const blockdevices = (parsed.blockdevices ?? [])
      .filter((d) => {
        if ((d.tran ?? '').toLowerCase() === 'usb') return false;
        if ((d.size ?? 0) <= 0) return false;
        if ((d.model ?? '').toLowerCase().includes('floppy')) return false;
        return true;
      })
      .map((d) => ({
        name: d.name ?? '',
        rota: d.rota ?? false,
        type: d.type ?? 'disk',
        size: d.size ?? 0,
        ro: d.ro ?? false,
        model: d.model ?? null,
        serial: d.serial ?? null,
        ...(d.wwn != null ? { wwn: d.wwn } : {}),
        tran: d.tran ?? null,
        mountpoints: d.mountpoints,
      }));

    return { blockdevices };
  });
}
