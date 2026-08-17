import { describe, expect, it } from 'vitest';

import { resolveOtlpTracesTarget } from '../otlp-target';

describe('resolveOtlpTracesTarget', () => {
  it('returns undefined with no endpoint configured', () => {
    expect(resolveOtlpTracesTarget({})).toBeUndefined();
  });

  it('returns undefined when the SDK is disabled', () => {
    expect(
      resolveOtlpTracesTarget({
        OTEL_SDK_DISABLED: 'TRUE',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
    ).toBeUndefined();
  });

  it('returns undefined on the console exporter (no HTTP target)', () => {
    expect(resolveOtlpTracesTarget({ OTEL_TRACES_EXPORTER: 'console' })).toBeUndefined();
  });

  it('appends /v1/traces to the base endpoint, trailing-slash safe', () => {
    expect(resolveOtlpTracesTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toEqual({
      url: 'http://localhost:4318/v1/traces',
      headers: {},
    });
    expect(resolveOtlpTracesTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/' })?.url).toBe(
      'http://localhost:4318/v1/traces',
    );
  });

  it('uses the per-signal traces endpoint verbatim (Sentry-style non-standard path)', () => {
    const target = resolveOtlpTracesTarget({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://oXX.ingest.sentry.io/api/1/integration/otlp/v1/traces',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://ignored:4318',
    });
    expect(target?.url).toBe('https://oXX.ingest.sentry.io/api/1/integration/otlp/v1/traces');
  });

  it('parses per-signal headers, falling back to base headers', () => {
    expect(
      resolveOtlpTracesTarget({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-sentry-auth=sentry sentry_key%3Dabc, x-other = v ',
      })?.headers,
    ).toEqual({ 'x-sentry-auth': 'sentry sentry_key=abc', 'x-other': 'v' });

    expect(
      resolveOtlpTracesTarget({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer t0k3n',
      })?.headers,
    ).toEqual({ authorization: 'Bearer t0k3n' });
  });

  it('skips malformed header pairs and keeps raw values that are not percent-encoded', () => {
    expect(
      resolveOtlpTracesTarget({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'novalue,=orphan,ok=100%valid',
      })?.headers,
    ).toEqual({ ok: '100%valid' });
  });

  it('treats empty-string env values as unset', () => {
    expect(
      resolveOtlpTracesTarget({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' }),
    ).toBeUndefined();
  });
});
