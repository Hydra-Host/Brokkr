import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const LstopoInfoSchema = z
  .object({
    '@name': z.string().optional(),
    '@value': z.string().optional(),
  })
  .passthrough();

const LstopoPageTypeSchema = z
  .object({
    '@size': z.string().optional(),
    '@count': z.string().optional(),
  })
  .passthrough();

const LstopoDistancesSchema = z
  .object({
    '@nbobjs': z.string().optional(),
    '@type': z.string().optional(),
    '@indexing': z.string().optional(),
    '@kind': z.string().optional(),
    '@name': z.string().optional(),
  })
  .passthrough();

const LstopoObjectSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      '@type': z.string().optional(),
      '@os_index': z.string().optional(),
      '@gp_index': z.string().optional(),
      '@name': z.string().optional(),
      '@subtype': z.string().optional(),
      '@cpuset': z.string().optional(),
      '@complete_cpuset': z.string().optional(),
      '@nodeset': z.string().optional(),
      '@complete_nodeset': z.string().optional(),
      '@symmetric_subtree': z.string().optional(),
      '@cache_size': z.string().optional(),
      '@depth': z.string().optional(),
      '@cache_linesize': z.string().optional(),
      '@cache_associativity': z.string().optional(),
      '@cache_type': z.string().optional(),
      '@local_memory': z.string().optional(),
      '@bridge_type': z.string().optional(),
      '@bridge_pci': z.string().optional(),
      '@depth_pci': z.string().optional(),
      '@pci_busid': z.string().optional(),
      '@pci_type': z.string().optional(),
      '@pci_link_speed': z.string().optional(),
      '@domain': z.string().optional(),
      '@bus': z.string().optional(),
      '@dev': z.string().optional(),
      '@func': z.string().optional(),
      '@class_id': z.string().optional(),
      '@vendor_id': z.string().optional(),
      '@device_id': z.string().optional(),
      '@subvendor_id': z.string().optional(),
      '@subdevice_id': z.string().optional(),
      '@revision': z.string().optional(),
      '@linkspeed': z.string().optional(),
      '@osdev_type': z.string().optional(),
      info: z.union([LstopoInfoSchema, z.array(LstopoInfoSchema)]).optional(),
      page_type: z.union([LstopoPageTypeSchema, z.array(LstopoPageTypeSchema)]).optional(),
      distances: z.union([LstopoDistancesSchema, z.array(LstopoDistancesSchema)]).optional(),
      object: z.union([LstopoObjectSchema, z.array(LstopoObjectSchema)]).optional(),
    })
    .passthrough(),
);

const LstopoTopologySchema = z
  .object({
    topology: z
      .object({
        '@version': z.string().optional(),
        '@editionname': z.string().optional(),
        object: z.union([LstopoObjectSchema, z.array(LstopoObjectSchema)]).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function registerLstopoCollector(): void {
  registerOperation('collection.lstopo', async () => {
    const ls = await run('lstopo-no-graphics', ['--of', 'xml', '--whole-system', '-'], {
      timeout_ms: 30_000,
    });
    if (ls.exit_code !== 0) {
      throw new Error(`lstopo-no-graphics failed (exit=${ls.exit_code}): ${ls.stderr.trim()}`);
    }

    const jcRes = await run('jc', ['--xml'], {
      stdin: ls.stdout,
      timeout_ms: 30_000,
    });
    if (jcRes.exit_code !== 0) {
      throw new Error(`jc --xml failed (exit=${jcRes.exit_code}): ${jcRes.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jcRes.stdout);
    } catch (error) {
      throw new Error(`jc --xml emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    return { lstopo: LstopoTopologySchema.parse(parsed) };
  });
}
