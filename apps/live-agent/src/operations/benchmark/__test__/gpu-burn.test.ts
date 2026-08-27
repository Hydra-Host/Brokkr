import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn() };
});

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { access } from 'node:fs/promises';
import { run } from '../../../exec';
import { parseDurationSeconds, parseGpuBurnOutput, runGpuBurn } from '../gpu-burn';

const accessMock = vi.mocked(access);
const runMock = vi.mocked(run);

function result(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function onDisk(...present: string[]) {
  accessMock.mockImplementation(async (path) => {
    if (!present.includes(String(path))) throw new Error('ENOENT');
  });
}

let computeCap: string;

beforeEach(() => {
  accessMock.mockReset();
  runMock.mockReset();
  computeCap = '9.0';
  runMock.mockImplementation(async (command, args) => {
    if (command === 'nvidia-smi' && args?.[0] === '-L') return result('GPU 0: NVIDIA H100\n');
    if (command === 'nvidia-smi') return result(computeCap);
    return result('GPU 0: NVIDIA H100 (UUID: GPU-1)\nGPU 0: OK');
  });
});

describe('parseDurationSeconds', () => {
  it('parses bare minutes (default unit)', () => {
    expect(parseDurationSeconds('30')).toBe(1800);
    expect(parseDurationSeconds('30m')).toBe(1800);
  });
  it('parses hours and seconds', () => {
    expect(parseDurationSeconds('1h')).toBe(3600);
    expect(parseDurationSeconds('90s')).toBe(90);
  });
  it('throws on invalid input', () => {
    expect(() => parseDurationSeconds('forever')).toThrow();
    expect(() => parseDurationSeconds('')).toThrow();
  });
});

describe('parseGpuBurnOutput', () => {
  it('extracts per-GPU stats from a passing 2-GPU run', () => {
    const sample = `
GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-abc-1)
GPU 1: NVIDIA H100 80GB HBM3 (UUID: GPU-abc-2)
Initialized device 0 with 81559 MB of memory
Initialized device 1 with 81559 MB of memory
100.0%  proc'd: 952 (18376 Gflop/s) 1023 (18400 Gflop/s)   errors: 0 - 0   temps: 62 C - 51 C
Tested 2 GPUs:
	GPU 0: OK
	GPU 1: OK
`.trim();

    const out = parseGpuBurnOutput(sample);
    expect(out.gpu_count).toBe(2);
    expect(out.test_passed).toBe(true);
    expect(out.total_gflops).toBe(18376 + 18400);
    expect(out.max_temp).toBe(62);
    expect(out.gpus).toHaveLength(2);
    expect(out.gpus[0]).toMatchObject({
      gpu_id: 0,
      gpu_name: 'NVIDIA H100 80GB HBM3',
      uuid: 'GPU-abc-1',
      gflops: 18376,
      temperature_celsius: 62,
      errors: 0,
      result: 'ok',
    });
  });

  it('flags a FAULTY GPU as failing', () => {
    const sample = `
GPU 0: NVIDIA H100 80GB HBM3 (UUID: GPU-abc-1)
GPU 1: NVIDIA H100 80GB HBM3 (UUID: GPU-abc-2)
100.0%  proc'd: 952 (18376 Gflop/s) 0 (0 Gflop/s)   errors: 0 - 42   temps: 62 C - 89 C
Tested 2 GPUs:
	GPU 0: OK
	GPU 1: FAULTY
`.trim();

    const out = parseGpuBurnOutput(sample);
    expect(out.test_passed).toBe(false);
    expect(out.gpus[1]?.result).toBe('faulty');
    expect(out.gpus[1]?.errors).toBe(42);
  });

  it('returns empty result on totally unparseable input', () => {
    const out = parseGpuBurnOutput('this is not gpu_burn output');
    expect(out.gpu_count).toBe(0);
    expect(out.test_passed).toBe(false);
    expect(out.gpus).toEqual([]);
  });

  it('handles output with only stats line (no verdict section)', () => {
    const sample = `
GPU 0: NVIDIA A100 (UUID: GPU-xyz-1)
45.2%  proc'd: 500 (15000 Gflop/s)   errors: 0   temps: 58 C
`.trim();

    const out = parseGpuBurnOutput(sample);
    expect(out.gpu_count).toBe(1);
    expect(out.gpus[0]?.gflops).toBe(15000);
    expect(out.gpus[0]?.result).toBeUndefined();
    expect(out.test_passed).toBe(true);
  });
});

describe('GPU burn compare kernel resolution', () => {
  it('prefers an architecture kernel over a generic kernel', async () => {
    onDisk(
      '/opt/brokkr/gpu_burn',
      '/opt/brokkr/compare.fatbin',
      '/opt/gpu-burn/compare_sm90.cubin',
    );

    await runGpuBurn('1s');

    expect(runMock).toHaveBeenCalledWith(
      '/opt/brokkr/gpu_burn',
      ['-c', '/opt/gpu-burn/compare_sm90.cubin', '1'],
      expect.any(Object),
    );
  });

  it('prefers fatbin over ptx and cubin', async () => {
    onDisk(
      '/opt/brokkr/gpu_burn',
      '/opt/brokkr/compare_sm90.fatbin',
      '/opt/brokkr/compare_sm90.ptx',
      '/opt/brokkr/compare_sm90.cubin',
    );

    await runGpuBurn('1s');

    expect(runMock).toHaveBeenCalledWith(
      '/opt/brokkr/gpu_burn',
      ['-c', '/opt/brokkr/compare_sm90.fatbin', '1'],
      expect.any(Object),
    );
  });

  it('prefers the binary directory over another install directory', async () => {
    onDisk(
      '/opt/gpu-burn/gpu_burn',
      '/opt/gpu-burn/compare_sm90.ptx',
      '/opt/brokkr/compare_sm90.fatbin',
    );

    await runGpuBurn('1s');

    expect(runMock).toHaveBeenCalledWith(
      '/opt/gpu-burn/gpu_burn',
      ['-c', '/opt/gpu-burn/compare_sm90.ptx', '1'],
      expect.any(Object),
    );
  });

  it('searches only generic kernels when the architecture is null', async () => {
    computeCap = '';
    onDisk('/opt/brokkr/gpu_burn', '/opt/brokkr/compare.ptx');

    await runGpuBurn('1s');

    expect(runMock).toHaveBeenCalledWith(
      '/opt/brokkr/gpu_burn',
      ['-c', '/opt/brokkr/compare.ptx', '1'],
      expect.any(Object),
    );
    const probes = accessMock.mock.calls.map(([path]) => String(path));
    expect(probes.some((path) => path.includes('compare_sm'))).toBe(false);
  });

  it('does not probe the binary directory twice', async () => {
    onDisk('/opt/gpu-burn/gpu_burn');

    await runGpuBurn('1s');

    const probes = accessMock.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.includes('/compare'));
    expect(probes).toHaveLength(12);
    expect(new Set(probes).size).toBe(probes.length);
  });

  it('omits -c when no compare kernel exists', async () => {
    onDisk('/opt/brokkr/gpu_burn');

    await runGpuBurn('1s');

    expect(runMock).toHaveBeenCalledWith('/opt/brokkr/gpu_burn', ['1'], expect.any(Object));
  });
});
