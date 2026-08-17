import { describe, expect, it } from 'vitest';
import { parseNcclOutput, thresholdForGpuCount } from '.././nccl';

describe('thresholdForGpuCount', () => {
  it('returns exact threshold when count matches a key', () => {
    expect(thresholdForGpuCount(1)).toBe(0);
    expect(thresholdForGpuCount(2)).toBe(10);
    expect(thresholdForGpuCount(4)).toBe(20);
    expect(thresholdForGpuCount(8)).toBe(40);
  });
  it('falls back to closest lower key for intermediate counts', () => {
    expect(thresholdForGpuCount(3)).toBe(10);
    expect(thresholdForGpuCount(6)).toBe(20);
    expect(thresholdForGpuCount(16)).toBe(40);
  });
  it('returns 0 when below all thresholds', () => {
    expect(thresholdForGpuCount(0)).toBe(0);
  });
});

describe('parseNcclOutput', () => {
  it('parses a passing 2-GPU run', () => {
    const sample = `
#
# nThread 1 nGpus 2 minBytes 536870912 maxBytes 8589934592 step: 2(factor) warmup iters: 5 iters: 20 agg iters: 1 validation: 1 graph: 0
#
# Using devices
#  Rank  0 Group  0 Pid 1234 on node-a device  0 [0000:17:00.0] NVIDIA H100
#  Rank  1 Group  0 Pid 1234 on node-a device  1 [0000:1a:00.0] NVIDIA H100
#
#                                                              out-of-place                       in-place
#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong
#        (B)    (elements)                               (us)  (GB/s)  (GB/s)            (us)  (GB/s)  (GB/s)
   536870912     134217728     float     sum      -1   1200.5  447.21  447.21      0   1190.2  451.08  451.08      0
  1073741824     268435456     float     sum      -1   2380.0  451.15  451.15      0   2370.0  452.99  452.99      0
  2147483648     536870912     float     sum      -1   4750.0  452.10  452.10      0   4740.0  453.10  453.10      0
# Out of bounds values : 0 OK
# Avg bus bandwidth    : 450.85
#
`.trim();

    const out = parseNcclOutput(sample);
    expect(out.gpu_count).toBe(2);
    expect(out.avg_bus_bandwidth_gbs).toBeCloseTo(450.85);
    expect(out.out_of_bounds_errors).toBe(0);
    expect(out.total_errors).toBe(0);
    expect(out.message_sizes).toEqual([536870912, 1073741824, 2147483648]);
    expect(out.peak_busbw_gbs).toBeCloseTo(453.1);
    expect(out.results_by_size).toHaveLength(3);
    expect(out.results_by_size[0]).toMatchObject({
      size_bytes: 536870912,
      out_of_place_busbw_gbs: 447.21,
      in_place_busbw_gbs: 451.08,
    });
    expect(out.min_latency_us).toBeCloseTo(1190.2);
  });

  it('counts #wrong errors from both in-place and out-of-place columns', () => {
    const sample = `
#  Rank  0 Group  0 Pid 1 on nodeA device  0 [0000:17:00.0] H100
#  Rank  1 Group  0 Pid 1 on nodeA device  1 [0000:1a:00.0] H100
   536870912     134217728     float     sum      -1   1200.5  447.21  447.21      3   1190.2  451.08  451.08      5
# Out of bounds values : 2
# Avg bus bandwidth    : 449.14
`.trim();

    const out = parseNcclOutput(sample);
    expect(out.out_of_bounds_errors).toBe(2);
    expect(out.total_errors).toBe(8);
  });

  it('skips the size=0 row and handles N/A #wrong values', () => {
    const sample = `
#  Rank  0 Group  0 Pid 1 on nodeA device  0 [0000:17:00.0] H100
           0             0     float     sum      -1      0.0    0.00    0.00    N/A      0.0    0.00    0.00    N/A
   536870912     134217728     float     sum      -1   1200.5  447.21  447.21    N/A   1190.2  451.08  451.08    N/A
# Avg bus bandwidth    : 449.14
`.trim();

    const out = parseNcclOutput(sample);
    expect(out.message_sizes).toEqual([536870912]);
    expect(out.total_errors).toBe(0);
    expect(out.results_by_size).toHaveLength(1);
  });

  it('returns baseline on unparseable input', () => {
    const out = parseNcclOutput('not nccl output');
    expect(out.avg_bus_bandwidth_gbs).toBeNull();
    expect(out.gpu_count).toBe(0);
    expect(out.results_by_size).toEqual([]);
  });
});
