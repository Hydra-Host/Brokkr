import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

import { run } from '../../../exec';
import { matchMemoryDmesgErrors, runMemoryDiagnostic } from '../memory';

const runMock = vi.mocked(run);

function ok(stdout: string) {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function fail() {
  return { stdout: '', stderr: 'no edac', exit_code: 1, duration_ms: 0 };
}

beforeEach(() => {
  runMock.mockReset();
});

describe('diagnostic.memory', () => {
  it('returns memory namespace when edac-util is unavailable', async () => {
    runMock.mockResolvedValue(fail());

    const result = (await runMemoryDiagnostic()) as { memory: { status: string } };

    expect(result).toHaveProperty('memory');
    expect(typeof result.memory.status).toBe('string');
  });

  it('parses edac-util -s output without throwing', async () => {
    runMock.mockImplementation(async (cmd, args) => {
      if (cmd === '/bin/sh' && args && args[1] === 'edac-util -s') {
        return ok('edac-util: No errors to report.\n');
      }
      return fail();
    });

    const result = (await runMemoryDiagnostic()) as { memory: { status: string } };

    expect(result.memory.status).toBeDefined();
  });
});

describe('matchMemoryDmesgErrors', () => {
  it('ignores benign EDAC/DIMM init and enumeration lines on a healthy ECC host', () => {
    const benign = [
      'EDAC MC0: Giving out device to module skx_edac controller Skylake',
      'EDAC sbridge: Seeking for: PCI ID 8086:2042',
      'EDAC amd64: Node 0: DRAM ECC enabled',
      'EDAC MC: Ver: 3.0.0',
      'mce: CPU0: Machine check polling timer interval set',
      'DIMM_A1: populated, 32768 MB DDR4',
      'ECC enabled, registered',
    ].join('\n');

    const { errors, critical } = matchMemoryDmesgErrors(benign);

    expect(errors).toEqual([]);
    expect(critical).toEqual([]);
  });

  it('flags genuine corrected and uncorrected ECC errors, escalating the uncorrected one', () => {
    const real = [
      'EDAC MC0: 1 CE memory read error on CPU_SrcID#0_MC#0_Chan#0_DIMM#0',
      'EDAC MC0: 1 UE uncorrectable error on CPU_SrcID#0_MC#0',
      'mce: [Hardware Error]: Machine check error logged for memory',
    ].join('\n');

    const { errors, critical } = matchMemoryDmesgErrors(real);

    expect(errors).toHaveLength(3);
    expect(critical.some((l) => l.includes('UE uncorrectable'))).toBe(true);
    expect(critical.some((l) => l.includes('Machine check error'))).toBe(true);
  });

  it('detects the bare "Machine check events logged" MCE line that carries no error/exception token', () => {
    const mce = [
      'mce: [Hardware Error]: Machine check events logged',
      'mce: CPU0: Machine check polling timer interval set',
    ].join('\n');

    const { errors } = matchMemoryDmesgErrors(mce);

    expect(errors).toEqual(['mce: [Hardware Error]: Machine check events logged']);
  });

  it('matches plural error lines (errors / failures), not just the singular token', () => {
    const plural = [
      'Memory errors detected on node 0',
      'EDAC MC0: 5 correctable errors',
      'EDAC MC1: 2 uncorrectable errors',
    ].join('\n');

    const { errors, critical } = matchMemoryDmesgErrors(plural);

    expect(errors).toHaveLength(3);
    expect(critical.some((l) => l.includes('uncorrectable errors'))).toBe(true);
  });
});
