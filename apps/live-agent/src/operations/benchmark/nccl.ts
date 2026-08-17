import { access } from 'node:fs/promises';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

export interface NcclSizeResult {
  size_bytes: number;
  out_of_place_busbw_gbs: number;
  in_place_busbw_gbs: number;
  out_of_place_errors: number;
  in_place_errors: number;
}

export interface ParsedNcclOutput {
  avg_bus_bandwidth_gbs: number | null;
  out_of_bounds_errors: number;
  total_errors: number;
  peak_busbw_gbs: number;
  min_latency_us: number | null;
  gpu_count: number;
  message_sizes: number[];
  results_by_size: NcclSizeResult[];
  parsing_error?: string;
}

const DATA_ROW_RE =
  /^\s*(\d+)\s+(\d+)\s+\w+\s+\w+\s+[-\d]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+|N\/A)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+|N\/A)/;

export function parseNcclOutput(stdout: string): ParsedNcclOutput {
  const out: ParsedNcclOutput = {
    avg_bus_bandwidth_gbs: null,
    out_of_bounds_errors: 0,
    total_errors: 0,
    peak_busbw_gbs: 0,
    min_latency_us: null,
    gpu_count: 0,
    message_sizes: [],
    results_by_size: [],
  };

  try {
    const lines = stdout.trim().split('\n');

    out.gpu_count = lines.filter((l) => l.includes('device') && l.includes('Rank')).length;

    for (const line of lines) {
      const m = /Avg bus bandwidth\s*:\s*([\d.]+)/.exec(line);
      if (m) {
        out.avg_bus_bandwidth_gbs = parseFloat(m[1]!);
        break;
      }
    }

    for (const line of lines) {
      const m = /Out of bounds values\s*:\s*(\d+)/.exec(line);
      if (m) {
        out.out_of_bounds_errors = Number.parseInt(m[1]!, 10);
        break;
      }
    }

    for (const line of lines) {
      const m = DATA_ROW_RE.exec(line);
      if (!m) continue;
      const sizeBytes = Number.parseInt(m[1]!, 10);
      if (sizeBytes === 0) continue;

      const oopTime = parseFloat(m[3]!);
      const oopBusbw = parseFloat(m[5]!);
      const oopWrong = m[6] === 'N/A' ? 0 : Number.parseInt(m[6]!, 10);
      const ipTime = parseFloat(m[7]!);
      const ipBusbw = parseFloat(m[9]!);
      const ipWrong = m[10] === 'N/A' ? 0 : Number.parseInt(m[10]!, 10);

      out.total_errors += oopWrong + ipWrong;
      out.message_sizes.push(sizeBytes);
      out.results_by_size.push({
        size_bytes: sizeBytes,
        out_of_place_busbw_gbs: oopBusbw,
        in_place_busbw_gbs: ipBusbw,
        out_of_place_errors: oopWrong,
        in_place_errors: ipWrong,
      });

      if (ipBusbw > out.peak_busbw_gbs) out.peak_busbw_gbs = ipBusbw;

      const minTime = Math.min(oopTime, ipTime);
      if (out.min_latency_us === null || minTime < out.min_latency_us) {
        out.min_latency_us = minTime;
      }
    }
  } catch (error) {
    out.parsing_error = getErrorMessage(error);
  }

  return out;
}

const BANDWIDTH_THRESHOLDS: Record<number, number> = {
  1: 0,
  2: 10,
  4: 20,
  8: 40,
};

export function thresholdForGpuCount(gpuCount: number): number {
  let t = 0;
  for (const count of Object.keys(BANDWIDTH_THRESHOLDS)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (count <= gpuCount) t = BANDWIDTH_THRESHOLDS[count]!;
  }
  return t;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveNcclBinary(): Promise<string | null> {
  const candidates = ['/opt/brokkr/all_reduce_perf', '/opt/nccl-tests/build/all_reduce_perf'];
  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  const { stdout, exit_code } = await run('which', ['all_reduce_perf'], {
    timeout_ms: 10_000,
  });
  if (exit_code === 0 && stdout.trim()) return stdout.trim();
  return null;
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

export interface NcclResult {
  test_passed: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  gpu_count?: number;
  avg_bus_bandwidth_gbs?: number | null;
  peak_busbw_gbs?: number;
  min_latency_us?: number | null;
  out_of_bounds_errors?: number;
  total_errors?: number;
  bandwidth_threshold_gbs?: number;
  results_by_size?: NcclSizeResult[];
  raw_output?: string;
}

const NCCL_TIMEOUT_MS = 3600 * 1000;

export async function runNccl(): Promise<NcclResult> {
  const { count: gpuCount, exit_code: smiExit } = await detectGpuCount();
  if (smiExit !== 0 && gpuCount === 0) {
    if (smiExit === 6) {
      return { test_passed: true, skipped: true, reason: 'No GPUs detected' };
    }
    return {
      test_passed: false,
      error: `nvidia-smi failed with exit code ${smiExit}`,
    };
  }
  if (gpuCount === 0) {
    return { test_passed: true, skipped: true, reason: 'No GPUs detected' };
  }
  if (gpuCount < 2) {
    return {
      test_passed: true,
      gpu_count: gpuCount,
      skipped: true,
      reason: 'Single GPU — NCCL multi-GPU test not applicable',
    };
  }

  const binary = await resolveNcclBinary();
  if (!binary) {
    return { test_passed: false, error: 'all_reduce_perf binary not found' };
  }

  const { stdout, stderr, exit_code } = await run(
    binary,
    ['-b', '512M', '-e', '8G', '-f', '2', '-g', String(gpuCount)],
    { timeout_ms: NCCL_TIMEOUT_MS },
  );

  if (exit_code !== 0 && !stdout.trim()) {
    return {
      test_passed: false,
      gpu_count: gpuCount,
      error: stderr.trim() || 'nccl exited non-zero',
    };
  }

  const rawOutput = stdout;
  const parsed = parseNcclOutput(rawOutput);

  const threshold = thresholdForGpuCount(gpuCount);
  const avgBw = parsed.avg_bus_bandwidth_gbs;
  const passed = avgBw !== null && avgBw > threshold && parsed.out_of_bounds_errors === 0 && parsed.total_errors === 0;

  return {
    test_passed: passed,
    gpu_count: parsed.gpu_count || gpuCount,
    avg_bus_bandwidth_gbs: avgBw,
    peak_busbw_gbs: parsed.peak_busbw_gbs,
    min_latency_us: parsed.min_latency_us,
    out_of_bounds_errors: parsed.out_of_bounds_errors,
    total_errors: parsed.total_errors,
    bandwidth_threshold_gbs: threshold,
    results_by_size: parsed.results_by_size,
    raw_output: rawOutput,
  };
}
