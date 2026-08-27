import { getErrorMessage } from '../../errors';

import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

const DETAILED_QUERY = [
  'index',
  'gpu_bus_id',
  'name',
  'serial',
  'vbios_version',
  'driver_version',
  'pstate',
  'temperature.gpu',
  'power.draw',
  'clocks.gr',
  'clocks.mem',
  'pcie.link.gen.current',
  'pcie.link.width.current',
  'memory.total',
  'memory.free',
].join(',');

function parseNvidiaCsv(text: string): Record<string, string>[] {
  const lines = text
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = (lines[0] ?? '').split(',').map((s) => s.trim());
  return lines.slice(1).map((row) => {
    const values = row.split(',').map((s) => s.trim());
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i] ?? ''] = values[i] ?? '';
    }
    return obj;
  });
}

async function getDetailedGpuInfo(): Promise<Record<string, string>[]> {
  try {
    const res = await run('nvidia-smi', [`--query-gpu=${DETAILED_QUERY}`, '--format=csv'], { timeout_ms: 60_000 });
    if (res.exit_code !== 0) return [];
    return parseNvidiaCsv(res.stdout);
  } catch {
    return [];
  }
}

async function getPcieLinkStatus(
  count: number,
): Promise<{ index: number; 'pcie.link.gen.current': string; 'pcie.link.gen.max': string }[]> {
  const results: { index: number; 'pcie.link.gen.current': string; 'pcie.link.gen.max': string }[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const res = await run(
        'nvidia-smi',
        ['-i', String(i), '--query-gpu=pcie.link.gen.current,pcie.link.gen.max', '--format=csv'],
        { timeout_ms: 15_000 },
      );
      const rows = parseNvidiaCsv(res.stdout);
      const first = rows[0];
      results.push({
        index: i,
        'pcie.link.gen.current': first?.['pcie.link.gen.current'] ?? 'N/A',
        'pcie.link.gen.max': first?.['pcie.link.gen.max'] ?? 'N/A',
      });
    } catch {
      results.push({
        index: i,
        'pcie.link.gen.current': 'N/A',
        'pcie.link.gen.max': 'N/A',
      });
    }
  }
  return results;
}

interface LspciRow {
  bus_id: string;
  device?: string | null;
  link_cap_speed?: string | null;
  link_cap_width?: string | null;
  link_sta_speed?: string | null;
  link_sta_width?: string | null;
  trans_pending?: boolean | null;
  error?: string;
}

async function getLspciStatus(busIds: string[]): Promise<LspciRow[]> {
  const results: LspciRow[] = [];
  for (const bus_id of busIds) {
    try {
      const parts = bus_id.split(':');
      const lspciAddr = parts.slice(1).join(':').toLowerCase();

      const res = await run('sudo', ['lspci', '-vvv', '-s', lspciAddr], { timeout_ms: 15_000 });
      const out = res.stdout;

      const deviceMatch = out.match(/^\S+\s+.*?:\s+(.+?)(?:\s+\(rev|$)/m);
      const lnkCap = out.match(/LnkCap:.*?Speed (\S+),.*?Width (x\d+)/);
      const lnkSta = out.match(/LnkSta:.*?Speed (\S+).*?Width (x\d+)/);
      const transPend = out.match(/TransPend([+-])/);

      results.push({
        bus_id,
        device: deviceMatch?.[1]?.trim() ?? null,
        link_cap_speed: lnkCap?.[1] ?? null,
        link_cap_width: lnkCap?.[2] ?? null,
        link_sta_speed: lnkSta?.[1] ?? null,
        link_sta_width: lnkSta?.[2] ?? null,
        trans_pending: transPend ? transPend[1] === '+' : null,
      });
    } catch (error) {
      results.push({ bus_id, error: getErrorMessage(error) });
    }
  }
  return results;
}

export function registerNvidiaDetailedCollector(): void {
  registerOperation('collection.nvidia_detailed', async () => {
    let list;
    try {
      list = await run('nvidia-smi', ['-L'], { timeout_ms: 10_000 });
    } catch (error) {
      throw new Error(`nvidia-smi unavailable: ${getErrorMessage(error)}`);
    }
    if (list.exit_code !== 0 || !list.stdout.includes('GPU')) {
      throw new Error('no GPU detected by nvidia-smi -L');
    }

    const gpus = await getDetailedGpuInfo();
    if (gpus.length === 0) {
      throw new Error('nvidia-smi --query-gpu returned no rows');
    }

    const count = gpus.length;
    const pcie = await getPcieLinkStatus(count);
    const busIds = gpus.map((g) => g['pci.bus_id']).filter((v): v is string => typeof v === 'string' && v.length > 0);
    const lspci = await getLspciStatus(busIds);

    return {
      nvidia_detailed: {
        count,
        model: gpus[0]?.name ?? null,
        gpus,
        pcie,
        lspci,
      },
    };
  });
}
