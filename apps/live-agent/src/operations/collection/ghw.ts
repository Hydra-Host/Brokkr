import { access, constants, readFile } from 'node:fs/promises';
import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const GHW_FACTS = ['baseboard', 'bios', 'block', 'chassis', 'cpu', 'gpu', 'memory', 'net', 'pci', 'product'] as const;

const GhwBaseboardSchema = z
  .object({
    asset_tag: z.string().optional(),
    serial_number: z.string().optional(),
    vendor: z.string().optional(),
    version: z.string().optional(),
    product: z.string().optional(),
  })
  .passthrough();

const GhwBiosSchema = z
  .object({
    vendor: z.string().optional(),
    version: z.string().optional(),
    date: z.string().optional(),
  })
  .passthrough();

const GhwChassisSchema = z
  .object({
    asset_tag: z.string().optional(),
    serial_number: z.string().optional(),
    type: z.string().optional(),
    type_description: z.string().optional(),
    vendor: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

const GhwProductSchema = z
  .object({
    family: z.string().optional(),
    name: z.string().optional(),
    vendor: z.string().optional(),
    serial_number: z.string().optional(),
    uuid: z.string().optional(),
    sku: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

const GhwCpuCoreSchema = z
  .object({
    id: z.number().optional(),
    total_threads: z.number().optional(),
    logical_processors: z.array(z.number()).optional(),
  })
  .passthrough();

const GhwCpuProcessorSchema = z
  .object({
    id: z.number().optional(),
    total_cores: z.number().optional(),
    total_threads: z.number().optional(),
    vendor: z.string().optional(),
    model: z.string().optional(),
    capabilities: z.array(z.string()).nullable().optional(),
    cores: z.array(GhwCpuCoreSchema).nullable().optional(),
  })
  .passthrough();

const GhwCpuSchema = z
  .object({
    total_cores: z.number().optional(),
    total_threads: z.number().optional(),
    processors: z.array(GhwCpuProcessorSchema).nullable().optional(),
  })
  .passthrough();

const GhwPciDeviceSchema = z
  .object({
    driver: z.string().optional(),
    address: z.string().optional(),
    vendor: z.record(z.unknown()).optional(),
    product: z.record(z.unknown()).optional(),
    revision: z.string().optional(),
    subsystem: z.record(z.unknown()).optional(),
    class: z.record(z.unknown()).optional(),
    subclass: z.record(z.unknown()).optional(),
    programming_interface: z.record(z.unknown()).optional(),
  })
  .passthrough();

const GhwGpuCardSchema = z
  .object({
    address: z.string().optional(),
    index: z.number().optional(),
    pci: GhwPciDeviceSchema.nullable().optional(),
    node: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();

const GhwGpuSchema = z
  .object({
    cards: z.array(GhwGpuCardSchema).nullable().optional(),
  })
  .passthrough();

const GhwMemorySchema = z
  .object({
    total_physical_bytes: z.number().optional(),
    total_usable_bytes: z.number().optional(),
    supported_page_sizes: z.array(z.number()).nullable().optional(),
    modules: z.array(z.record(z.unknown())).nullable().optional(),
  })
  .passthrough();

const GhwNicCapabilitySchema = z
  .object({
    name: z.string().optional(),
    is_enabled: z.boolean().optional(),
    can_enable: z.boolean().optional(),
  })
  .passthrough();

const GhwNicSchema = z
  .object({
    name: z.string().optional(),
    mac_address: z.string().optional(),
    is_virtual: z.boolean().optional(),
    speed: z.string().optional(),
    duplex: z.string().optional(),
    pci_address: z.string().optional(),
    capabilities: z.array(GhwNicCapabilitySchema).nullable().optional(),
    supported_ports: z.array(z.string()).nullable().optional(),
    supported_link_modes: z.array(z.string()).nullable().optional(),
    advertised_link_modes: z.array(z.string()).nullable().optional(),
    supported_fec_modes: z.array(z.string()).nullable().optional(),
    advertised_fec_modes: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const GhwNetSchema = z
  .object({
    nics: z.array(GhwNicSchema).nullable().optional(),
  })
  .passthrough();

const GhwPciSchema = z
  .object({
    Devices: z.array(GhwPciDeviceSchema).nullable().optional(),
  })
  .passthrough();

const GhwPartitionSchema = z
  .object({
    name: z.string().optional(),
    label: z.string().optional(),
    mount_point: z.string().optional(),
    size_bytes: z.number().optional(),
    type: z.string().optional(),
    read_only: z.boolean().optional(),
    uuid: z.string().optional(),
    filesystem_label: z.string().optional(),
  })
  .passthrough();

const GhwDiskSchema = z
  .object({
    name: z.string().optional(),
    size_bytes: z.number().optional(),
    physical_block_size_bytes: z.number().optional(),
    drive_type: z.string().optional(),
    removable: z.boolean().optional(),
    storage_controller: z.string().optional(),
    bus_path: z.string().optional(),
    vendor: z.string().optional(),
    model: z.string().optional(),
    serial_number: z.string().optional(),
    wwn: z.string().optional(),
    partitions: z.array(GhwPartitionSchema).nullable().optional(),
  })
  .passthrough();

const GhwBlockSchema = z
  .object({
    total_size_bytes: z.number().optional(),
    disks: z.array(GhwDiskSchema).nullable().optional(),
  })
  .passthrough();

const GHW_FACT_SCHEMAS = {
  baseboard: z.object({ baseboard: GhwBaseboardSchema }).passthrough(),
  bios: z.object({ bios: GhwBiosSchema }).passthrough(),
  block: z.object({ block: GhwBlockSchema }).passthrough(),
  chassis: z.object({ chassis: GhwChassisSchema }).passthrough(),
  cpu: z.object({ cpu: GhwCpuSchema }).passthrough(),
  gpu: z.object({ gpu: GhwGpuSchema }).passthrough(),
  memory: z.object({ memory: GhwMemorySchema }).passthrough(),
  net: z.object({ network: GhwNetSchema }).passthrough(),
  pci: z.object({ pci: GhwPciSchema }).passthrough(),
  product: z.object({ product: GhwProductSchema }).passthrough(),
} as const satisfies Record<(typeof GHW_FACTS)[number], z.ZodTypeAny>;

// nvme multipath registers a hidden per-controller sibling (nvme2c2n1) next to the real namespace
// (nvme2n1); ghwc reports both, duplicating the namespace's serial/wwn and double-counting capacity.
const NVME_MULTIPATH_NAME = /^nvme\d+c\d+n\d+$/;

async function isHiddenDisk(name: string): Promise<boolean> {
  try {
    const hidden = await readFile(`/sys/block/${name}/hidden`, 'utf8');
    return hidden.trim() === '1';
  } catch {
    // no sysfs attr (older kernel, or the disk went away) — fall back to the name shape
    return NVME_MULTIPATH_NAME.test(name);
  }
}

async function dropHiddenDisks(data: unknown): Promise<unknown> {
  const parsed = GHW_FACT_SCHEMAS.block.safeParse(data);
  if (!parsed.success) return data;

  const disks = parsed.data.block.disks;
  if (!disks?.length) return data;

  const hidden = await Promise.all(disks.map((d) => isHiddenDisk(d.name ?? '')));
  if (!hidden.some(Boolean)) return data;

  const visible = disks.filter((_, i) => !hidden[i]);
  logger.info('dropped hidden block devices from ghw block fact', {
    dropped: disks.filter((_, i) => hidden[i]).map((d) => d.name),
  });
  return {
    ...parsed.data,
    block: {
      ...parsed.data.block,
      disks: visible,
      // ghwc's total sums every /sys/block entry, hidden siblings included
      total_size_bytes: visible.reduce((sum, d) => sum + (d.size_bytes ?? 0), 0),
    },
  };
}

const GHWC_CANDIDATES = ['/usr/bin/ghwc', '/usr/local/bin/ghwc'];

async function findGhwc(): Promise<string | null> {
  for (const path of GHWC_CANDIDATES) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      logger.trace('ghwc candidate not executable', { path, error: getErrorMessage(error) });
    }
  }
  return null;
}

export function registerGhwCollector(): void {
  registerOperation('collection.ghw', async () => {
    const ghwc = await findGhwc();
    if (!ghwc) {
      throw new Error('ghwc binary not found in /usr/bin or /usr/local/bin');
    }

    const results: Record<string, unknown> = {};

    for (const fact of GHW_FACTS) {
      const key = `ghw_${fact}`;
      try {
        const { stdout, exit_code, stderr } = await run(ghwc, [fact, '-f', 'json'], {
          timeout_ms: 30_000,
        });
        if (exit_code !== 0) {
          results[key] = null;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          results[key] = { raw_data: stdout };
          continue;
        }
        const check = GHW_FACT_SCHEMAS[fact].safeParse(parsed);
        if (check.success) {
          results[key] = fact === 'block' ? await dropHiddenDisks(check.data) : check.data;
        } else {
          logger.warn('ghwc output failed schema validation', {
            fact,
            issues: check.error.issues.slice(0, 5),
          });
          results[key] = parsed;
        }
        void stderr;
      } catch (error) {
        logger.warn('ghwc fact collection threw', {
          fact,
          error: getErrorMessage(error),
        });
        results[key] = null;
      }
    }

    return results;
  });
}
