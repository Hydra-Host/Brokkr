import { describe, expect, it } from 'vitest';

import { apiToForm, dnsConfigFormSchema, formToPayload } from '~/routes/_app/dcim/zones/$zoneId/dns/index';

const fullApiConfig = {
  enabled: true,
  upstreamResolvers: ['8.8.8.8', '1.1.1.1'],
  ttlSeconds: 300,
  cacheSize: 10000,
  ownedDomain: 'lan',
  upstreamTimeoutMs: 1500,
  pollMs: 2500,
  tcpMaxConnections: 100,
  tcpMaxQueriesPerConn: 50,
  tcpIdleTimeoutMs: 5000,
  tcpMaxMessageBytes: 65535,
  maxTtlSeconds: 3600,
  maxCacheTtlSeconds: 7200,
  minCacheTtlSeconds: 30,
  negTtlSeconds: 60,
};

describe('zone DNS config apiToForm', () => {
  it('maps upstream resolvers array to comma-separated text', () => {
    const form = apiToForm(fullApiConfig);
    expect(form.upstreamResolversText).toBe('8.8.8.8, 1.1.1.1');
  });

  it('maps null optional fields to undefined', () => {
    const form = apiToForm({ ...fullApiConfig, tcpMaxConnections: null, maxTtlSeconds: null });
    expect(form.tcpMaxConnections).toBeUndefined();
    expect(form.maxTtlSeconds).toBeUndefined();
  });

  it('preserves non-null optional fields', () => {
    const form = apiToForm(fullApiConfig);
    expect(form.tcpMaxConnections).toBe(100);
    expect(form.maxTtlSeconds).toBe(3600);
  });

  it('preserves the enabled flag', () => {
    const form = apiToForm(fullApiConfig);
    expect(form.enabled).toBe(true);
  });

  it('maps upstreamTimeoutMs and pollMs straight through', () => {
    const form = apiToForm(fullApiConfig);
    expect(form.upstreamTimeoutMs).toBe(1500);
    expect(form.pollMs).toBe(2500);
  });

  it('handles empty upstream resolvers', () => {
    const form = apiToForm({ ...fullApiConfig, upstreamResolvers: [] });
    expect(form.upstreamResolversText).toBe('');
  });
});

describe('zone DNS config formToPayload', () => {
  it('splits comma-separated text into array', () => {
    const payload = formToPayload({ ...apiToForm(fullApiConfig) });
    expect(payload.upstreamResolvers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('converts unset to null for optional numeric fields', () => {
    const form = apiToForm({ ...fullApiConfig, tcpMaxConnections: null, negTtlSeconds: null });
    const payload = formToPayload(form);
    expect(payload.tcpMaxConnections).toBeNull();
    expect(payload.negTtlSeconds).toBeNull();
  });

  it('preserves non-zero optional numeric fields', () => {
    const payload = formToPayload(apiToForm(fullApiConfig));
    expect(payload.tcpMaxConnections).toBe(100);
    expect(payload.negTtlSeconds).toBe(60);
  });

  it('trims whitespace from IPs', () => {
    const form = { ...apiToForm(fullApiConfig), upstreamResolversText: '  8.8.8.8 , 1.1.1.1  ' };
    const payload = formToPayload(form);
    expect(payload.upstreamResolvers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('drops empty entries from IP list', () => {
    const form = { ...apiToForm(fullApiConfig), upstreamResolversText: '8.8.8.8,, ,1.1.1.1' };
    const payload = formToPayload(form);
    expect(payload.upstreamResolvers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('returns empty array for blank input', () => {
    const form = { ...apiToForm(fullApiConfig), upstreamResolversText: '' };
    const payload = formToPayload(form);
    expect(payload.upstreamResolvers).toEqual([]);
  });
});

describe('zone DNS config round-trip', () => {
  it('round-trips full config through form and back', () => {
    const payload = formToPayload(apiToForm(fullApiConfig));
    expect(payload.enabled).toBe(fullApiConfig.enabled);
    expect(payload.upstreamResolvers).toEqual(fullApiConfig.upstreamResolvers);
    expect(payload.ttlSeconds).toBe(fullApiConfig.ttlSeconds);
    expect(payload.cacheSize).toBe(fullApiConfig.cacheSize);
    expect(payload.ownedDomain).toBe(fullApiConfig.ownedDomain);
    expect(payload.upstreamTimeoutMs).toBe(fullApiConfig.upstreamTimeoutMs);
    expect(payload.pollMs).toBe(fullApiConfig.pollMs);
    expect(payload.tcpMaxConnections).toBe(fullApiConfig.tcpMaxConnections);
    expect(payload.maxTtlSeconds).toBe(fullApiConfig.maxTtlSeconds);
    expect(payload.maxCacheTtlSeconds).toBe(fullApiConfig.maxCacheTtlSeconds);
    expect(payload.minCacheTtlSeconds).toBe(fullApiConfig.minCacheTtlSeconds);
    expect(payload.negTtlSeconds).toBe(fullApiConfig.negTtlSeconds);
  });

  it('round-trips config with all nullable fields null', () => {
    const nullConfig = {
      ...fullApiConfig,
      tcpMaxConnections: null,
      tcpMaxQueriesPerConn: null,
      tcpIdleTimeoutMs: null,
      tcpMaxMessageBytes: null,
      maxTtlSeconds: null,
      maxCacheTtlSeconds: null,
      minCacheTtlSeconds: null,
      negTtlSeconds: null,
    };
    const payload = formToPayload(apiToForm(nullConfig));
    expect(payload.tcpMaxConnections).toBeNull();
    expect(payload.tcpMaxQueriesPerConn).toBeNull();
    expect(payload.tcpIdleTimeoutMs).toBeNull();
    expect(payload.tcpMaxMessageBytes).toBeNull();
    expect(payload.maxTtlSeconds).toBeNull();
    expect(payload.maxCacheTtlSeconds).toBeNull();
    expect(payload.minCacheTtlSeconds).toBeNull();
    expect(payload.negTtlSeconds).toBeNull();
  });
});

describe('dnsConfigFormSchema validation', () => {
  const validForm = {
    enabled: true,
    upstreamResolversText: '8.8.8.8',
    ttlSeconds: 300,
    cacheSize: 1000,
    ownedDomain: 'lan',
    upstreamTimeoutMs: 1000,
    pollMs: 2000,
    tcpMaxConnections: undefined,
    tcpMaxQueriesPerConn: undefined,
    tcpIdleTimeoutMs: undefined,
    tcpMaxMessageBytes: undefined,
    maxTtlSeconds: 0,
    maxCacheTtlSeconds: 0,
    minCacheTtlSeconds: 0,
    negTtlSeconds: 0,
  };

  it('accepts valid form data', () => {
    const result = dnsConfigFormSchema.safeParse(validForm);
    expect(result.success).toBe(true);
  });

  it('rejects invalid IP in upstream resolvers', () => {
    const result = dnsConfigFormSchema.safeParse({ ...validForm, upstreamResolversText: 'not-an-ip' });
    expect(result.success).toBe(false);
  });

  it('rejects minCacheTtl > maxCacheTtl', () => {
    const result = dnsConfigFormSchema.safeParse({
      ...validForm,
      minCacheTtlSeconds: 100,
      maxCacheTtlSeconds: 50,
    });
    expect(result.success).toBe(false);
  });

  it('accepts minCacheTtl <= maxCacheTtl', () => {
    const result = dnsConfigFormSchema.safeParse({
      ...validForm,
      minCacheTtlSeconds: 50,
      maxCacheTtlSeconds: 100,
    });
    expect(result.success).toBe(true);
  });

  it('allows both cache TTLs to be zero (disabled)', () => {
    const result = dnsConfigFormSchema.safeParse({
      ...validForm,
      minCacheTtlSeconds: 0,
      maxCacheTtlSeconds: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid owned domain', () => {
    const result = dnsConfigFormSchema.safeParse({ ...validForm, ownedDomain: '-invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive upstreamTimeoutMs', () => {
    expect(dnsConfigFormSchema.safeParse({ ...validForm, upstreamTimeoutMs: 0 }).success).toBe(false);
  });

  it('rejects non-positive pollMs', () => {
    expect(dnsConfigFormSchema.safeParse({ ...validForm, pollMs: 0 }).success).toBe(false);
  });
});
