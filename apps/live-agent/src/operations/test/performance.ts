import { z } from 'zod';

import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';
import { makeLogger } from '../../logger';
import { parseTestDurationMinutes } from './utils';

const logger = makeLogger('test');

interface SubResult {
  status: string;
  [k: string]: unknown;
}

const FioReadStats = z.object({
  iops: z.number().optional(),
  bw: z.number().optional(),
  lat_ns: z.object({ mean: z.number().optional() }).optional(),
});
const FioPerfJob = z
  .object({
    read: FioReadStats.optional(),
  })
  .passthrough();
const FioPerfOutput = z.object({
  jobs: z.array(FioPerfJob).optional(),
});

const IperfSumStats = z.object({
  bits_per_second: z.number().optional(),
});
const IperfPerfOutput = z.object({
  end: z
    .object({
      sum_sent: IperfSumStats.optional(),
      sum_received: IperfSumStats.optional(),
    })
    .optional(),
});

async function runCpuBenchmark(durationSec: number): Promise<SubResult> {
  try {
    const cmdTimeoutMs = (durationSec + 60) * 1000;
    const { stdout, stderr, exit_code } = await run('sysbench', ['cpu', `--time=${durationSec}`, 'run'], {
      timeout_ms: cmdTimeoutMs,
    });
    if (exit_code !== 0) {
      return { status: 'error', error: stderr.trim() || `exit=${exit_code}` };
    }
    const merged = stdout + (stderr ? stderr : '');
    const result: SubResult = {
      status: 'completed',
      duration_seconds: durationSec,
    };

    for (const rawLine of merged.split('\n')) {
      const line = rawLine.trim();
      const lower = line.toLowerCase();
      if (lower.includes('events per second')) {
        const val = line.split(':').pop()?.trim();
        const num = val !== undefined ? parseFloat(val) : NaN;
        if (Number.isFinite(num)) result['events_per_second'] = num;
      } else if (lower.includes('total number of events')) {
        const val = line.split(':').pop()?.trim();
        const num = val !== undefined ? Number.parseInt(val, 10) : NaN;
        if (Number.isFinite(num)) result['total_events'] = num;
      } else if (lower.includes('avg:') && !('latency' in result)) {
        const val = line.split(':').pop()?.trim();
        const num = val !== undefined ? parseFloat(val) : NaN;
        if (Number.isFinite(num)) result['avg_latency_ms'] = num;
      }
    }

    result['raw_output'] = merged.slice(0, 2000);
    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runMemoryBenchmark(durationSec: number): Promise<SubResult> {
  try {
    const cmdTimeoutMs = (durationSec + 60) * 1000;
    const { stdout, stderr, exit_code } = await run('sysbench', ['memory', `--time=${durationSec}`, 'run'], {
      timeout_ms: cmdTimeoutMs,
    });
    if (exit_code !== 0) {
      return { status: 'error', error: stderr.trim() || `exit=${exit_code}` };
    }
    const merged = stdout + (stderr ? stderr : '');
    const result: SubResult = {
      status: 'completed',
      duration_seconds: durationSec,
    };

    for (const rawLine of merged.split('\n')) {
      const line = rawLine.trim();
      const lower = line.toLowerCase();
      if (lower.includes('transferred') && lower.includes('mib')) {
        const parts = line.split('(');
        if (parts.length > 1) {
          const throughputStr = parts[1]!.split('MiB')[0]!.trim();
          const num = parseFloat(throughputStr);
          if (Number.isFinite(num)) result['throughput_mib_per_sec'] = num;
        }
      } else if (lower.includes('total number of events')) {
        const val = line.split(':').pop()?.trim();
        const num = val !== undefined ? Number.parseInt(val, 10) : NaN;
        if (Number.isFinite(num)) result['total_events'] = num;
      }
    }

    result['raw_output'] = merged.slice(0, 2000);
    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runStorageBenchmark(durationSec: number): Promise<SubResult> {
  try {
    const cmdTimeoutMs = (durationSec + 60) * 1000;
    const { stdout, exit_code } = await run(
      'fio',
      [
        '--name=seqread',
        '--rw=read',
        '--bs=1M',
        '--size=1G',
        `--runtime=${durationSec}`,
        '--time_based',
        '--output-format=json',
      ],
      { timeout_ms: cmdTimeoutMs },
    );
    if (exit_code !== 0) {
      return { status: 'error', error: `fio exit=${exit_code}` };
    }

    const result: SubResult = {
      status: 'completed',
      duration_seconds: durationSec,
    };

    let fioData: unknown = null;
    try {
      fioData = JSON.parse(stdout);
    } catch (error) {
      logger.debug('fio output parse failed', { error: getErrorMessage(error) });
    }

    const fio = FioPerfOutput.safeParse(fioData);
    const firstJob = fio.success ? fio.data.jobs?.[0] : undefined;
    if (firstJob) {
      const readStats = firstJob.read ?? {};
      result['read_iops'] = readStats.iops ?? 0;
      result['read_bw_kib'] = readStats.bw ?? 0;
      result['read_bw_mib'] = Math.round(((readStats.bw ?? 0) / 1024) * 100) / 100;
      result['read_lat_ns_mean'] = readStats.lat_ns?.mean ?? 0;
    } else {
      result['raw_output'] = stdout.slice(0, 2000);
    }

    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runNetworkBenchmark(): Promise<SubResult> {
  try {
    const { stdout, exit_code } = await run(
      'sh',
      ['-c', 'iperf3 -s -D -1 2>/dev/null; sleep 1; iperf3 -c localhost -t 10 -J 2>/dev/null'],
      { timeout_ms: 30_000 },
    );
    if (exit_code !== 0) {
      return { status: 'error', error: `iperf3 chain exit=${exit_code}` };
    }

    const result: SubResult = {
      status: 'completed',
      duration_seconds: 10,
    };

    let iperfData: unknown = null;
    try {
      iperfData = JSON.parse(stdout);
    } catch (error) {
      logger.debug('iperf3 output parse failed', { error: getErrorMessage(error) });
    }

    const iperf = IperfPerfOutput.safeParse(iperfData);
    const end = iperf.success ? iperf.data.end : undefined;
    if (end) {
      const sent = end.sum_sent?.bits_per_second ?? 0;
      const received = end.sum_received?.bits_per_second ?? 0;
      result['bits_per_second_sent'] = sent;
      result['bits_per_second_received'] = received;
      result['gbps_sent'] = Math.round((sent / 1e9) * 100) / 100;
      result['gbps_received'] = Math.round((received / 1e9) * 100) / 100;
    } else {
      result['raw_output'] = stdout.slice(0, 2000);
    }

    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

export function registerPerformanceTest(): void {
  registerOperation('test.performance', async ({ duration }) => {
    const durationMin = parseTestDurationMinutes(duration);
    const durationSec = durationMin * 60;
    const startTime = new Date().toISOString();

    const cpu = await runCpuBenchmark(durationSec);
    const memory = await runMemoryBenchmark(durationSec);
    const storage = await runStorageBenchmark(durationSec);
    const network = await runNetworkBenchmark();

    const endTime = new Date().toISOString();

    const statuses = [cpu.status, memory.status, storage.status, network.status];
    let overallStatus: 'pass' | 'partial' | 'fail';
    if (statuses.every((s) => s === 'completed')) {
      overallStatus = 'pass';
    } else if (statuses.some((s) => s === 'completed')) {
      overallStatus = 'partial';
    } else {
      overallStatus = 'fail';
    }

    return {
      performance: {
        test_type: 'performance_benchmarking',
        duration_minutes: durationMin,
        start_time: startTime,
        cpu_benchmark: cpu,
        memory_benchmark: memory,
        storage_benchmark: storage,
        network_benchmark: network,
        end_time: endTime,
        overall_status: overallStatus,
      },
    };
  });
}
