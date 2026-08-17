import type { HttpService } from '@nestjs/axios';
import { TeeCapability } from '@repo/database';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorContext } from '../../collectors/collector.types';
import { TeeComposer } from '../tee.composer';

const makeCtx = (
  rawBundle: Record<string, unknown>,
  priorTeeCapable: TeeCapability = TeeCapability.UNVERIFIED,
): CollectorContext =>
  ({
    runId: 'run-1',
    deviceId: 'dev-1',
    device: { server: { teeCapable: priorTeeCapable } } as any,
    rawBundle: rawBundle as any,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  }) as CollectorContext;

const mockHttp = (ids: string[] = []) =>
  ({
    get: vi.fn(() => of({ data: { ids } })),
  }) as unknown as HttpService;

const capableBundle = (vbios = 'DEADBEEF') => ({
  lscpu: { total_cpu_sockets: 2, total_cpu_cores: 64, total_cpu_threads: 128, cpu_family: '6', cpu_model: '173' },
  ghw_bios: { bios: { vendor: 'Supermicro Corp', version: '2.6a', date: '2024' } },
  kernel_params: { current_cmdline: 'x' },
  nvidia: {
    count: 1,
    model: 'NVIDIA H200',
    gpus: [{ index: 0, name: 'NVIDIA H200', uuid: 'GPU-x', vbios }],
  },
});

describe('TeeComposer', () => {
  let composer: TeeComposer;

  beforeEach(() => {
    composer = new TeeComposer(mockHttp());
  });

  it('writes FALSE when CPU family/model is not TEE-capable', async () => {
    const ctx = makeCtx({
      lscpu: { total_cpu_sockets: 1, total_cpu_cores: 4, total_cpu_threads: 8, cpu_family: '6', cpu_model: '1' },
    });
    const mutation = await composer.compose(ctx);
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.FALSE });
  });

  it('writes PATCH when the CPU is capable but no recognized TEE vendor is found', async () => {
    const bundle = capableBundle();
    bundle.ghw_bios.bios.vendor = 'Unknown Vendor Inc';
    const mutation = await composer.compose(makeCtx(bundle));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('writes PATCH when a CPLD-rule vendor (Dell) has a mismatching CPLD version', async () => {
    const base = capableBundle();
    base.ghw_bios.bios.vendor = 'Dell Inc.';
    base.ghw_bios.bios.version = '2.7.5';
    const bundle = {
      ...base,
      kernel_params: { current_cmdline: 'x', hardware_analysis: { system_manufacturer: 'dell inc.' } },
      cpld: { cpld: { version: '9.9.9' } },
    };
    const mutation = await composer.compose(makeCtx(bundle));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('writes PATCH when the CPU is capable but vendor BIOS is not known-good', async () => {
    const bundle = capableBundle();
    bundle.ghw_bios.bios.version = '9.9.9';
    const mutation = await composer.compose(makeCtx(bundle));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('writes TRUE when attestation matches the vBIOS', async () => {
    composer = new TeeComposer(mockHttp(['NV_GPU_VBIOS_H200_80G_SXM_DEADBEEF']));
    const mutation = await composer.compose(makeCtx(capableBundle('DEADBEEF')));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.TRUE });
  });

  it('writes PATCH when attestation does not contain the vBIOS', async () => {
    composer = new TeeComposer(mockHttp(['NV_GPU_VBIOS_H100_80G_SXM_OTHERSTRING']));
    const mutation = await composer.compose(makeCtx(capableBundle('DEADBEEF')));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('preserves TRUE when nvidia is empty (CC-mode hides GPUs)', async () => {
    const bundle = capableBundle();
    const mutation = await composer.compose(makeCtx({ ...bundle, nvidia: {} }, TeeCapability.TRUE));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.TRUE });
  });

  it('downgrades to PATCH in CC-mode when prior is UNVERIFIED', async () => {
    const bundle = capableBundle();
    const mutation = await composer.compose(makeCtx({ ...bundle, nvidia: {} }));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('keeps PATCH in CC-mode when prior is PATCH', async () => {
    const bundle = capableBundle();
    const mutation = await composer.compose(makeCtx({ ...bundle, nvidia: {} }, TeeCapability.PATCH));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('preserves TRUE when the nvidia bundle is unparseable (bad/partial discovery, not just empty {})', async () => {
    const bundle = capableBundle();
    const mutation = await composer.compose(
      makeCtx({ ...bundle, nvidia: { count: 0, model: '' } }, TeeCapability.TRUE),
    );
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.TRUE });
  });

  it('downgrades to PATCH on an unparseable nvidia bundle when prior is not TRUE', async () => {
    const bundle = capableBundle();
    const mutation = await composer.compose(makeCtx({ ...bundle, nvidia: { count: 0, model: '' } }));
    expect(mutation.serverUpdate).toEqual({ teeCapable: TeeCapability.PATCH });
  });

  it('caches attestation — HTTP called once across successive runs', async () => {
    const http = mockHttp(['NV_GPU_VBIOS_H200_80G_SXM_DEADBEEF']);
    composer = new TeeComposer(http);
    await composer.compose(makeCtx(capableBundle()));
    await composer.compose(makeCtx(capableBundle()));
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('swallows attestation fetch failures and keeps prior cache', async () => {
    const http = {
      get: vi
        .fn()
        .mockReturnValueOnce(of({ data: { ids: ['NV_GPU_VBIOS_H200_80G_SXM_DEADBEEF'] } }))
        .mockReturnValueOnce(throwError(() => new Error('network'))),
    } as unknown as HttpService;
    composer = new TeeComposer(http);

    const first = await composer.compose(makeCtx(capableBundle()));
    expect(first.serverUpdate).toEqual({ teeCapable: TeeCapability.TRUE });

    (composer as unknown as { attestationFetchedAt: number }).attestationFetchedAt = 0;
    const second = await composer.compose(makeCtx(capableBundle()));
    expect(second.serverUpdate).toEqual({ teeCapable: TeeCapability.TRUE });
  });
});
