import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const IpAddrInfoSchema = z
  .object({
    family: z.string().optional(),
    local: z.string().optional(),
    prefixlen: z.number().optional(),
    broadcast: z.string().optional(),
    scope: z.string().optional(),
    label: z.string().optional(),
    metric: z.number().optional(),
    dynamic: z.boolean().optional(),
    mngtmpaddr: z.boolean().optional(),
    noprefixroute: z.boolean().optional(),
    valid_life_time: z.number().optional(),
    preferred_life_time: z.number().optional(),
  })
  .passthrough();

const IpInterfaceSchema = z
  .object({
    ifindex: z.number().optional(),
    ifname: z.string().optional(),
    flags: z.array(z.string()).optional(),
    mtu: z.number().optional(),
    qdisc: z.string().optional(),
    operstate: z.string().optional(),
    group: z.string().optional(),
    txqlen: z.number().optional(),
    link_type: z.string().optional(),
    address: z.string().optional(),
    broadcast: z.string().optional(),
    altnames: z.array(z.string()).optional(),
    master: z.string().optional(),
    permaddr: z.string().optional(),
    xdp: z.record(z.unknown()).optional(),
    addr_info: z.array(IpAddrInfoSchema).optional(),
  })
  .passthrough();

const IpASchema = z.array(IpInterfaceSchema);

export function registerIpCollector(): void {
  registerOperation('collection.ip', async () => {
    const { stdout, exit_code, stderr } = await run('ip', ['--json', 'a'], {
      timeout_ms: 15_000,
    });
    if (exit_code !== 0) {
      throw new Error(`ip --json a failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`ip --json a emitted non-JSON output: ${getErrorMessage(error)}`);
    }
    return { ip_a: IpASchema.parse(parsed) };
  });
}
