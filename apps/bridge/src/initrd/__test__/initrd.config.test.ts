import { describe, expect, it } from 'vitest';

import { buildInitrdConfig } from '../initrd.config.js';

describe('buildInitrdConfig grpcExternalPort', () => {
  it('defaults to the internal gRPC port when insecure and no explicit external port', () => {
    const cfg = buildInitrdConfig({ GRPC_INSECURE: 'true' });
    expect(cfg.grpcExternalPort).toBe(9082);
    expect(cfg.grpcInsecure).toBe(true);
  });

  it('follows a custom internal port when insecure', () => {
    const cfg = buildInitrdConfig({ GRPC_INSECURE: 'true', GRPC_INTERNAL_PORT: '9090' });
    expect(cfg.grpcExternalPort).toBe(9090);
  });

  it('honors an explicit external port even when insecure', () => {
    const cfg = buildInitrdConfig({ GRPC_INSECURE: 'true', GRPC_EXTERNAL_PORT: '8443' });
    expect(cfg.grpcExternalPort).toBe(8443);
  });

  it('defaults to 443 under TLS (not insecure, no explicit external port)', () => {
    const cfg = buildInitrdConfig({ GRPC_INSECURE: 'false' });
    expect(cfg.grpcExternalPort).toBe(443);
  });

  it('treats local simulation as insecure for the port default', () => {
    const cfg = buildInitrdConfig({ LOCAL_SIMULATION_ENABLED: 'true' });
    expect(cfg.grpcExternalPort).toBe(9082);
  });

  it('honors an explicit external port under TLS', () => {
    const cfg = buildInitrdConfig({ GRPC_EXTERNAL_PORT: '8443' });
    expect(cfg.grpcExternalPort).toBe(8443);
  });
});
