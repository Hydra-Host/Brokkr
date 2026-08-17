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

const FioRwStats = z.object({
  iops: z.number().optional(),
  bw: z.number().optional(),
});
const FioJob = z
  .object({
    read: FioRwStats.optional(),
    write: FioRwStats.optional(),
  })
  .passthrough();
const FioOutput = z.object({
  jobs: z.array(FioJob).optional(),
});

const IperfSumStats = z.object({
  bits_per_second: z.number().optional(),
});
const IperfOutput = z.object({
  end: z
    .object({
      sum_sent: IperfSumStats.optional(),
      sum_received: IperfSumStats.optional(),
    })
    .optional(),
});

const INTENSITY_VM_PCT: Record<string, string> = {
  low: '50%',
  normal: '80%',
  high: '90%',
};

async function runCpuStress(durationMin: number, _intensity: string): Promise<SubResult> {
  try {
    const cmdTimeoutMs = (durationMin * 60 + 60) * 1000;
    const { stdout, stderr, exit_code } = await run(
      'stress-ng',
      ['--cpu', '0', '--timeout', `${durationMin}m`, '--metrics'],
      { timeout_ms: cmdTimeoutMs },
    );
    if (exit_code !== 0) {
      return { status: 'error', error: stderr.trim() || `exit=${exit_code}` };
    }
    return {
      status: 'completed',
      duration_minutes: durationMin,
      results: stdout + (stderr ? stderr : ''),
    };
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runMemoryStress(durationMin: number, intensity: string): Promise<SubResult> {
  try {
    const cmdTimeoutMs = (durationMin * 60 + 60) * 1000;
    const vmBytes = INTENSITY_VM_PCT[intensity] ?? '80%';
    const { stdout, stderr, exit_code } = await run(
      'stress-ng',
      ['--vm', '2', '--vm-bytes', vmBytes, '--timeout', `${durationMin}m`, '--metrics'],
      { timeout_ms: cmdTimeoutMs },
    );
    if (exit_code !== 0) {
      return { status: 'error', error: stderr.trim() || `exit=${exit_code}` };
    }
    return {
      status: 'completed',
      vm_bytes: vmBytes,
      duration_minutes: durationMin,
      results: stdout + (stderr ? stderr : ''),
    };
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runStorageStress(durationMin: number, _intensity: string): Promise<SubResult> {
  try {
    const runtimeSec = durationMin * 60;
    const cmdTimeoutMs = (runtimeSec + 60) * 1000;
    const { stdout, exit_code } = await run(
      'fio',
      [
        '--name=stress_test',
        '--rw=randrw',
        '--bs=4k',
        '--size=1G',
        `--runtime=${runtimeSec}`,
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
      duration_minutes: durationMin,
    };

    let fioData: unknown = null;
    try {
      fioData = JSON.parse(stdout);
    } catch (error) {
      logger.debug('fio output parse failed', { error: getErrorMessage(error) });
    }

    const fio = FioOutput.safeParse(fioData);
    const firstJob = fio.success ? fio.data.jobs?.[0] : undefined;
    if (firstJob) {
      result['read_iops'] = firstJob.read?.iops ?? 0;
      result['write_iops'] = firstJob.write?.iops ?? 0;
      result['read_bw_kib'] = firstJob.read?.bw ?? 0;
      result['write_bw_kib'] = firstJob.write?.bw ?? 0;
    } else {
      result['raw_output'] = stdout.slice(0, 2000);
    }

    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

async function runNetworkStress(durationMin: number, _intensity: string): Promise<SubResult> {
  try {
    const runtimeSec = durationMin * 60;
    const cmdTimeoutMs = (runtimeSec + 60) * 1000;
    const { stdout, exit_code } = await run(
      'sh',
      ['-c', `iperf3 -s -D -1 2>/dev/null; sleep 1; iperf3 -c localhost -t ${runtimeSec} -J 2>/dev/null`],
      { timeout_ms: cmdTimeoutMs },
    );
    if (exit_code !== 0) {
      return { status: 'error', error: `iperf3 chain exit=${exit_code}` };
    }

    const result: SubResult = {
      status: 'completed',
      duration_minutes: durationMin,
    };

    let iperfData: unknown = null;
    try {
      iperfData = JSON.parse(stdout);
    } catch (error) {
      logger.debug('iperf3 output parse failed', { error: getErrorMessage(error) });
    }

    const iperf = IperfOutput.safeParse(iperfData);
    const end = iperf.success ? iperf.data.end : undefined;
    if (end) {
      result['bits_per_second_sent'] = end.sum_sent?.bits_per_second ?? 0;
      result['bits_per_second_received'] = end.sum_received?.bits_per_second ?? 0;
    } else {
      result['raw_output'] = stdout.slice(0, 2000);
    }

    return result;
  } catch (error) {
    return { status: 'error', error: getErrorMessage(error) };
  }
}

export function registerStressTest(): void {
  registerOperation('test.stress', async ({ duration, intensity }) => {
    const durationMin = parseTestDurationMinutes(duration);
    const startTime = new Date().toISOString();

    const cpu = await runCpuStress(durationMin, intensity);
    const memory = await runMemoryStress(durationMin, intensity);
    const storage = await runStorageStress(durationMin, intensity);
    const network = await runNetworkStress(durationMin, intensity);

    const endTime = new Date().toISOString();

    const statuses = [cpu.status, memory.status, storage.status, network.status];
    let overallStatus: 'pass' | 'partial' | 'fail';
    let topStatus: 'completed' | 'failed';
    if (statuses.every((s) => s === 'completed')) {
      topStatus = 'completed';
      overallStatus = 'pass';
    } else if (statuses.some((s) => s === 'completed')) {
      topStatus = 'completed';
      overallStatus = 'partial';
    } else {
      topStatus = 'failed';
      overallStatus = 'fail';
    }

    return {
      stress: {
        test_type: 'stress_testing',
        duration_minutes: durationMin,
        intensity,
        start_time: startTime,
        status: topStatus,
        cpu_stress: cpu,
        memory_stress: memory,
        storage_stress: storage,
        network_stress: network,
        end_time: endTime,
        overall_status: overallStatus,
      },
    };
  });
}
