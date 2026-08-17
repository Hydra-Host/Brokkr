import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

export interface ParsedGpuStats {
  gpu_id: number;
  gpu_name?: string;
  uuid?: string;
  gflops?: number;
  temperature_celsius?: number | null;
  errors?: number;
  result?: string;
}

export interface ParsedGpuBurnOutput {
  gpus: ParsedGpuStats[];
  total_gflops: number;
  gpu_count: number;
  max_temp: number | null;
  test_passed: boolean;
  parsing_error?: string;
}

export function parseGpuBurnOutput(stdout: string): ParsedGpuBurnOutput {
  try {
    const gpus = new Map<number, ParsedGpuStats>();
    const lines = stdout.trim().split(/[\r\n]+/);

    for (const line of lines) {
      const m = /GPU (\d+):\s*([^(]+)\(UUID:\s*([^)]+)\)/.exec(line);
      if (!m) continue;
      const gpuId = Number.parseInt(m[1]!, 10);
      gpus.set(gpuId, {
        gpu_id: gpuId,
        gpu_name: m[2]!.trim(),
        uuid: m[3]!.trim(),
      });
    }

    const numGpus = gpus.size > 0 ? gpus.size : 8;

    let lastStatsLine: string | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (l.includes("proc'd:") && l.includes('Gflop/s')) {
        lastStatsLine = l;
        break;
      }
    }

    if (lastStatsLine) {
      const gflopsMatches = [...lastStatsLine.matchAll(/\d+ \((\d+) Gflop\/s\)/g)]
        .slice(0, numGpus)
        .map((m) => Number.parseInt(m[1]!, 10));

      const tempSection = /temps:\s*([\d\s\-C]+)/.exec(lastStatsLine);
      const temps: number[] = tempSection
        ? [...tempSection[1]!.matchAll(/(\d+)\s*C/g)].slice(0, numGpus).map((m) => Number.parseInt(m[1]!, 10))
        : [];

      const errSection = /errors:\s*([\d\s-]+?)(?:\s+temps:|$)/.exec(lastStatsLine);
      const errors: number[] = errSection
        ? errSection[1]!
            .trim()
            .split('-')
            .map((e) => e.trim())
            .filter((e) => e.length > 0)
            .map((e) => Number.parseInt(e, 10))
            .slice(0, numGpus)
        : [];

      gflopsMatches.forEach((g, i) => {
        const existing = gpus.get(i) ?? { gpu_id: i };
        existing.gflops = g;
        existing.temperature_celsius = i < temps.length ? temps[i]! : null;
        existing.errors = i < errors.length ? errors[i]! : 0;
        gpus.set(i, existing);
      });
    }

    for (const line of lines) {
      const m = /GPU (\d+):\s+(OK|FAULTY)/.exec(line);
      if (!m) continue;
      const gpuId = Number.parseInt(m[1]!, 10);
      const existing = gpus.get(gpuId);
      if (existing) existing.result = m[2]!.toLowerCase();
    }

    const gpuList = [...gpus.values()].sort((a, b) => a.gpu_id - b.gpu_id);
    const totalGflops = gpuList.reduce((sum, g) => sum + (g.gflops ?? 0), 0);

    if (gpuList.length === 0) {
      return { gpus: [], total_gflops: 0, gpu_count: 0, max_temp: null, test_passed: false };
    }

    const allPassed = gpuList.every((g) => (g.errors ?? 0) === 0 && (g.result ?? 'ok') === 'ok');
    const temps = gpuList.map((g) => g.temperature_celsius).filter((t): t is number => typeof t === 'number');
    const maxTemp = temps.length > 0 ? Math.max(...temps) : null;

    return {
      gpus: gpuList,
      total_gflops: totalGflops,
      gpu_count: gpuList.length,
      max_temp: maxTemp,
      test_passed: allPassed,
    };
  } catch (error) {
    return {
      gpus: [],
      total_gflops: 0,
      gpu_count: 0,
      max_temp: null,
      test_passed: false,
      parsing_error: getErrorMessage(error),
    };
  }
}

export function parseDurationSeconds(duration: string): number {
  const m = /^(\d+)([smh]?)$/i.exec(duration.trim());
  if (!m) throw new Error(`invalid duration: ${duration}`);
  const n = Number.parseInt(m[1]!, 10);
  const unit = (m[2] || 'm').toLowerCase();
  switch (unit) {
    case 's':
      return n;
    case 'h':
      return n * 3600;
    case 'm':
    default:
      return n * 60;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectGpuCount(): Promise<{ count: number; exit_code: number }> {
  try {
    const { stdout, exit_code } = await run('nvidia-smi', ['-L'], { timeout_ms: 30_000 });
    const count = stdout.split('\n').filter((l) => l.startsWith('GPU ')).length;
    return { count, exit_code };
  } catch {
    return { count: 0, exit_code: 6 };
  }
}

async function detectComputeCap(): Promise<string | null> {
  const { stdout, exit_code } = await run('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'], {
    timeout_ms: 30_000,
  });
  if (exit_code !== 0 || !stdout.trim()) return null;
  const first = stdout.trim().split('\n')[0]!.trim();
  const parts = first.split('.');
  if (parts.length !== 2) return null;
  const major = Number.parseInt(parts[0]!, 10);
  const minor = Number.parseInt(parts[1]!, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return major >= 10 ? `${major}0` : `${major}${minor}`;
}

const INSTALL_DIRS = ['/opt/brokkr', '/opt/gpu-burn'];

async function resolveGpuBurnBinary(): Promise<string | null> {
  for (const dir of INSTALL_DIRS) {
    const binary = `${dir}/gpu_burn`;
    if (await fileExists(binary)) return binary;
  }
  return null;
}

const COMPARE_EXTENSIONS = ['fatbin', 'ptx', 'cubin'];

export async function resolveCompareKernel(binary: string, arch: string | null): Promise<string | null> {
  const directories = [...new Set([dirname(binary), ...INSTALL_DIRS])];
  const names = arch ? [`compare_sm${arch}`, 'compare'] : ['compare'];

  for (const name of names) {
    for (const directory of directories) {
      for (const extension of COMPARE_EXTENSIONS) {
        const kernel = `${directory}/${name}.${extension}`;
        if (await fileExists(kernel)) return kernel;
      }
    }
  }
  return null;
}

export interface GpuBurnResult {
  test_passed: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  gpu_count?: number;
  duration_seconds?: number;
  max_temp?: number | null;
  total_gflops?: number;
  gpus?: ParsedGpuStats[];
  errors?: { gpu_id?: number; error_count: number; result: string }[];
  start_time?: string;
  end_time?: string;
  raw_output?: string;
}

export async function runGpuBurn(duration: string): Promise<GpuBurnResult> {
  const durationSeconds = parseDurationSeconds(duration);

  const gpuInfo = await detectGpuCount();
  if (gpuInfo.exit_code !== 0 && gpuInfo.count === 0) {
    if (gpuInfo.exit_code === 6) {
      return { test_passed: true, skipped: true, reason: 'No GPUs detected' };
    }
    return {
      test_passed: false,
      error: `nvidia-smi failed with exit code ${gpuInfo.exit_code}`,
    };
  }
  if (gpuInfo.count === 0) {
    return { test_passed: true, skipped: true, reason: 'No GPUs detected' };
  }

  const gpuCount = gpuInfo.count;
  const arch = await detectComputeCap();

  const binary = await resolveGpuBurnBinary();
  if (!binary) {
    return { test_passed: false, error: 'GPU burn binary not found' };
  }

  const args: string[] = [];
  const compare = await resolveCompareKernel(binary, arch);
  if (compare) args.push('-c', compare);
  args.push(String(durationSeconds));

  const startTime = new Date();
  const burnTimeoutMs = (durationSeconds + 300) * 1000;
  const { stdout } = await run(binary, args, {
    timeout_ms: burnTimeoutMs,
  });
  const endTime = new Date();

  const rawOutput = stdout;
  const parsed = parseGpuBurnOutput(rawOutput);

  const errorEntries = parsed.gpus
    .filter((g) => (g.errors ?? 0) > 0 || (g.result ?? 'ok') !== 'ok')
    .map((g) => ({
      gpu_id: g.gpu_id,
      error_count: g.errors ?? 0,
      result: g.result ?? 'unknown',
    }));

  return {
    test_passed: parsed.test_passed,
    gpu_count: parsed.gpu_count || gpuCount,
    duration_seconds: durationSeconds,
    max_temp: parsed.max_temp,
    total_gflops: parsed.total_gflops,
    errors: errorEntries,
    gpus: parsed.gpus,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    raw_output: rawOutput,
  };
}
