import { readdir, readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('collection');

const NVIDIA_SMI_QUERY = 'index,name,serial,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,memory.free';

interface GpuRow {
  index: number;
  name: string;
  serial?: string;
  uuid: string;
  'temperature.gpu': number | null;
  'utilization.gpu': number | null;
  'memory.used': number | null;
  'memory.total': number | null;
  'memory.free': number | null;
  vbios?: string;
}

function parseIntOrNull(s: string): number | null {
  const trimmed = s.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function parseNvidiaSmi(csv: string): GpuRow[] {
  const rows: GpuRow[] = [];
  for (const rawLine of csv.trim().split('\n')) {
    const parts = rawLine.split(',').map((p) => p.trim());
    if (parts.length < 9) continue;
    rows.push({
      index: Number.parseInt(parts[0] ?? '0', 10),
      name: parts[1] ?? '',
      serial: parts[2] ?? '',
      uuid: parts[3] ?? '',
      'temperature.gpu': parseIntOrNull(parts[4] ?? ''),
      'utilization.gpu': parseIntOrNull(parts[5] ?? ''),
      'memory.used': parseIntOrNull(parts[6] ?? ''),
      'memory.total': parseIntOrNull(parts[7] ?? ''),
      'memory.free': parseIntOrNull(parts[8] ?? ''),
    });
  }
  return rows;
}

async function readVbiosMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  let gpuDirs: string[];
  try {
    gpuDirs = await readdir('/proc/driver/nvidia/gpus');
  } catch {
    return map;
  }

  for (const dir of gpuDirs) {
    try {
      const content = await readFile(`/proc/driver/nvidia/gpus/${dir}/information`, 'utf8');
      let currentUuid: string | null = null;
      for (const match of content.matchAll(/(BIOS|UUID):\s+(\S+)/g)) {
        const [, key, value] = match;
        if (!key || !value) continue;
        if (key === 'UUID') {
          currentUuid = value;
        } else if (key === 'BIOS' && currentUuid) {
          map[currentUuid] = value.replace(/[.:]/g, '');
          currentUuid = null;
        }
      }
    } catch (error) {
      logger.trace('nvidia gpu information read failed', { dir, error: String(error) });
    }
  }

  return map;
}

export function registerNvidiaCollector(): void {
  registerOperation('collection.nvidia', async () => {
    let list;
    try {
      list = await run('nvidia-smi', ['-L'], { timeout_ms: 10_000 });
    } catch (error) {
      throw new Error(`nvidia-smi unavailable: ${String(error)}`);
    }
    if (list.exit_code !== 0 || !list.stdout.includes('GPU')) {
      throw new Error('no GPU detected by nvidia-smi -L');
    }

    const res = await run('nvidia-smi', [`--query-gpu=${NVIDIA_SMI_QUERY}`, '--format=csv,noheader,nounits'], {
      timeout_ms: 30_000,
    });
    if (res.exit_code !== 0) {
      throw new Error(`nvidia-smi query-gpu exit ${res.exit_code}`);
    }

    const gpus = parseNvidiaSmi(res.stdout);
    if (gpus.length === 0) {
      throw new Error('nvidia-smi listed GPUs but --query-gpu parse yielded zero rows');
    }

    const vbiosMap = await readVbiosMap();
    for (const gpu of gpus) {
      const vbios = vbiosMap[gpu.uuid];
      if (vbios !== undefined) gpu.vbios = vbios;
    }

    return {
      nvidia: {
        count: gpus.length,
        model: gpus[0]?.name ?? null,
        gpus,
      },
    };
  });
}
