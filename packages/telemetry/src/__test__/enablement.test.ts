import { describe, expect, it } from 'vitest';
import { resolveEnablement } from '../enablement';

describe('resolveEnablement', () => {
  it('is disabled by default with no env', () => {
    const decision = resolveEnablement({});
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('no OTLP endpoint');
  });

  it('treats empty and whitespace values as unset', () => {
    const decision = resolveEnablement({
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '   ',
    });
    expect(decision.enabled).toBe(false);
  });

  it('enables otlp export when the base endpoint is set', () => {
    const decision = resolveEnablement({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
    expect(decision).toMatchObject({ enabled: true, exporter: 'otlp' });
  });

  it('enables otlp export when only the per-signal traces endpoint is set (Sentry shape)', () => {
    const decision = resolveEnablement({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://o1.ingest.sentry.io/api/1/integration/otlp/v1/traces',
    });
    expect(decision).toMatchObject({ enabled: true, exporter: 'otlp' });
  });

  it('honors OTEL_SDK_DISABLED case-insensitively, matching sdk-node', () => {
    const decision = resolveEnablement({
      OTEL_SDK_DISABLED: 'TRUE',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });
    expect(decision.enabled).toBe(false);
  });

  it('honors the OTEL_SDK_DISABLED kill switch over everything else', () => {
    const decision = resolveEnablement({
      OTEL_SDK_DISABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_TRACES_EXPORTER: 'console',
    });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('OTEL_SDK_DISABLED=true');
  });

  it('supports the console exporter without an endpoint (debug/smoke)', () => {
    const decision = resolveEnablement({ OTEL_TRACES_EXPORTER: 'console' });
    expect(decision).toMatchObject({ enabled: true, exporter: 'console' });
  });

  it('disables on OTEL_TRACES_EXPORTER=none even with an endpoint', () => {
    const decision = resolveEnablement({
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });
    expect(decision.enabled).toBe(false);
  });

  it('disables on an unsupported exporter name rather than guessing', () => {
    const decision = resolveEnablement({ OTEL_TRACES_EXPORTER: 'zipkin' });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('zipkin');
  });

  it('disables when OTEL_TRACES_EXPORTER=otlp is set but no endpoint is configured', () => {
    const decision = resolveEnablement({ OTEL_TRACES_EXPORTER: 'otlp' });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('no OTLP endpoint');
  });

  it('accepts OTEL_TRACES_EXPORTER=otlp with an endpoint', () => {
    const decision = resolveEnablement({
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    });
    expect(decision).toMatchObject({ enabled: true, exporter: 'otlp' });
  });
});
