import { describe, expect, it, vi } from 'vitest';

import {
  PrometheusMonitoringService,
  createPrometheusMonitoringService,
  type DnsLookup,
  type PrometheusFetcher,
  type SnappyCompressor,
} from '../prometheus.service';

const SCRAPE_TEXT = `# HELP up Was the last scrape successful.
# TYPE up gauge
up{job="x"} 1
node_load1 0.42
`;

function makeFetcher(opts: {
  get?: (url: string, t: number) => Promise<{ status: number; text: () => Promise<string> }>;
  post?: (
    url: string,
    body: Uint8Array,
    headers: Record<string, string>,
    t: number,
  ) => Promise<{ status: number; text: () => Promise<string> }>;
}): PrometheusFetcher {
  return {
    get: opts.get ?? (async () => ({ status: 200, text: async () => '' })),
    post: opts.post ?? (async () => ({ status: 204, text: async () => '' })),
  };
}

const identitySnappy: SnappyCompressor = { compress: (input) => input };

function dnsTo(ip: string, family: 4 | 6 = 4): DnsLookup {
  return async () => [{ address: ip, family }];
}

function build(
  fetcher: PrometheusFetcher | null,
  dns?: DnsLookup,
  snappy?: SnappyCompressor,
): PrometheusMonitoringService {
  return createPrometheusMonitoringService('test', undefined, fetcher ?? undefined, snappy, dns);
}

describe('scrapeMetrics', () => {
  it('happy path returns raw text', async () => {
    const calls: string[] = [];
    const fetcher = makeFetcher({
      get: async (url) => {
        calls.push(url);
        return { status: 200, text: async () => SCRAPE_TEXT };
      },
    });
    const svc = build(fetcher);
    const text = await svc.scrapeMetrics({ targetIp: '10.0.0.1', port: 9100, metricsPath: '/metrics' });
    expect(text).toBe(SCRAPE_TEXT);
    expect(calls[0]).toBe('http://10.0.0.1:9100/metrics');
  });

  it('https + custom path in URL', async () => {
    const calls: string[] = [];
    const fetcher = makeFetcher({
      get: async (url) => {
        calls.push(url);
        return { status: 200, text: async () => 'ok' };
      },
    });
    const svc = build(fetcher);
    await svc.scrapeMetrics({
      targetIp: 'h.example',
      port: 9443,
      metricsPath: '/probe',
      protocol: 'https',
    });
    expect(calls[0]).toBe('https://h.example:9443/probe');
  });

  it('404 raises PrometheusMonitoringError', async () => {
    const fetcher = makeFetcher({ get: async () => ({ status: 404, text: async () => 'not found' }) });
    await expect(
      build(fetcher).scrapeMetrics({ targetIp: '10.0.0.1', port: 9100, metricsPath: '/metrics' }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('500 raises PrometheusMonitoringError', async () => {
    const fetcher = makeFetcher({ get: async () => ({ status: 500, text: async () => 'boom' }) });
    await expect(
      build(fetcher).scrapeMetrics({ targetIp: '10.0.0.1', port: 9100, metricsPath: '/metrics' }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('connection error is wrapped', async () => {
    const fetcher = makeFetcher({
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(
      build(fetcher).scrapeMetrics({ targetIp: '10.0.0.1', port: 9100, metricsPath: '/metrics' }),
    ).rejects.toThrow(/Connection error/);
  });

  it('empty body returns empty string', async () => {
    const fetcher = makeFetcher({ get: async () => ({ status: 200, text: async () => '' }) });
    expect(await build(fetcher).scrapeMetrics({ targetIp: '10.0.0.1', port: 9100, metricsPath: '/metrics' })).toBe('');
  });
});

describe('verifyRemoteWriteTarget SSRF guard', () => {
  it.each<[string, 4 | 6, string]>([
    ['127.0.0.1', 4, 'loopback ipv4'],
    ['::1', 6, 'loopback ipv6'],
    ['10.5.6.7', 4, 'rfc1918 /8'],
    ['192.168.1.10', 4, 'rfc1918 192.168'],
    ['172.20.0.1', 4, 'rfc1918 172.16'],
    ['169.254.169.254', 4, 'link-local ipv4'],
    ['fe80::1', 6, 'link-local ipv6'],
    ['240.0.0.1', 4, 'reserved'],
  ])('rejects %s (%s)', async (ip, family) => {
    const svc = build(null, dnsTo(ip, family));
    await expect(svc.verifyRemoteWriteTarget('https://x.example/api/v1/write')).rejects.toThrow(/private\/reserved/);
  });

  it('public ipv4 passes', async () => {
    const svc = build(null, dnsTo('8.8.8.8'));
    await expect(svc.verifyRemoteWriteTarget('https://thanos.example/api/v1/write')).resolves.toBeUndefined();
  });

  it('ipv4-mapped ipv6 private rejected after unwrap', async () => {
    const svc = build(null, dnsTo('::ffff:10.0.0.1', 6));
    await expect(svc.verifyRemoteWriteTarget('https://x.example/api/v1/write')).rejects.toThrow(/private\/reserved/);
  });

  it('dns failure raises with "Cannot resolve"', async () => {
    const svc = build(null, async () => {
      throw new Error('Name or service not known');
    });
    await expect(svc.verifyRemoteWriteTarget('https://nope.invalid/api/v1/write')).rejects.toThrow(/Cannot resolve/);
  });

  it('url without hostname is a no-op (no dns call)', async () => {
    const dns = vi.fn(dnsTo('8.8.8.8'));
    const svc = build(null, dns);
    await svc.verifyRemoteWriteTarget('not-a-url');
    expect(dns).not.toHaveBeenCalled();
  });

  it('multiple resolved ips - any private rejects', async () => {
    const svc = build(null, async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(svc.verifyRemoteWriteTarget('https://mixed.example/api/v1/write')).rejects.toThrow(
      /private\/reserved/,
    );
  });
});

describe('scrapeAndPush', () => {
  it('happy path pushes and reports success', async () => {
    const posted: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = [];
    let scrapeCalls = 0;
    const fetcher: PrometheusFetcher = {
      get: async () => {
        scrapeCalls += 1;
        return { status: 200, text: async () => SCRAPE_TEXT };
      },
      post: async (url, body, headers) => {
        posted.push({ url, headers, body });
        return { status: 204, text: async () => '' };
      },
    };
    const svc = build(fetcher, dnsTo('8.8.8.8'), identitySnappy);
    const result = await svc.scrapeAndPush({
      targetIp: '10.0.0.1',
      port: 9100,
      metricsPath: '/metrics',
      protocol: 'http',
      timeout: 15,
      remoteWriteUrl: 'https://thanos.example/api/v1/write',
      hostName: 'SW-42',
    });
    expect(result.result).toBe('success');
    expect(result.metrics_pushed).toBe(2);
    expect(result.host_name).toBe('SW-42');
    expect(scrapeCalls).toBe(1);
    expect(posted.length).toBe(1);
    expect(posted[0].url).toBe('https://thanos.example/api/v1/write');
    expect(posted[0].headers['Content-Type']).toBe('application/x-protobuf');
    expect(posted[0].headers['Content-Encoding']).toBe('snappy');
    expect(posted[0].headers['X-Prometheus-Remote-Write-Version']).toBe('0.1.0');
    expect('Authorization' in posted[0].headers).toBe(false);
  });

  it('basic auth header when creds provided', async () => {
    const posted: Array<{ headers: Record<string, string> }> = [];
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 200, text: async () => SCRAPE_TEXT }),
      post: async (_url, _body, headers) => {
        posted.push({ headers });
        return { status: 200, text: async () => '' };
      },
    };
    const svc = build(fetcher, dnsTo('8.8.8.8'), identitySnappy);
    await svc.scrapeAndPush({
      targetIp: '10.0.0.1',
      port: 9100,
      metricsPath: '/metrics',
      protocol: 'http',
      timeout: 15,
      remoteWriteUrl: 'https://thanos.example/api/v1/write',
      remoteWriteUsername: 'alice',
      remoteWritePassword: 's3cret',
    });
    expect(posted[0].headers.Authorization).toBe('Basic YWxpY2U6czNjcmV0');
  });

  it('scrape failure propagates and skips push', async () => {
    let postCount = 0;
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 500, text: async () => 'exporter crashed' }),
      post: async () => {
        postCount += 1;
        return { status: 204, text: async () => '' };
      },
    };
    const svc = build(fetcher, dnsTo('8.8.8.8'), identitySnappy);
    await expect(
      svc.scrapeAndPush({
        targetIp: '10.0.0.1',
        port: 9100,
        metricsPath: '/metrics',
        protocol: 'http',
        timeout: 15,
        remoteWriteUrl: 'https://thanos.example/api/v1/write',
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(postCount).toBe(0);
  });

  it('push non-2xx returns failure result', async () => {
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 200, text: async () => SCRAPE_TEXT }),
      post: async () => ({ status: 503, text: async () => 'thanos overloaded' }),
    };
    const svc = build(fetcher, dnsTo('8.8.8.8'), identitySnappy);
    const result = await svc.scrapeAndPush({
      targetIp: '10.0.0.1',
      port: 9100,
      metricsPath: '/metrics',
      protocol: 'http',
      timeout: 15,
      remoteWriteUrl: 'https://thanos.example/api/v1/write',
    });
    expect(result.result).toBe('failure');
    expect(result.metrics_pushed).toBe(0);
    expect(result.error).toContain('503');
  });

  it('push connection error returns failure result', async () => {
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 200, text: async () => SCRAPE_TEXT }),
      post: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const svc = build(fetcher, dnsTo('8.8.8.8'), identitySnappy);
    const result = await svc.scrapeAndPush({
      targetIp: '10.0.0.1',
      port: 9100,
      metricsPath: '/metrics',
      protocol: 'http',
      timeout: 15,
      remoteWriteUrl: 'https://thanos.example/api/v1/write',
    });
    expect(result.result).toBe('failure');
    expect(result.error?.toLowerCase()).toContain('connection');
  });

  it('empty scrape short-circuits with zero pushed (no dns, no post)', async () => {
    let postCount = 0;
    const dns = vi.fn(dnsTo('8.8.8.8'));
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 200, text: async () => '' }),
      post: async () => {
        postCount += 1;
        return { status: 204, text: async () => '' };
      },
    };
    const svc = build(fetcher, dns, identitySnappy);
    const result = await svc.scrapeAndPush({
      targetIp: '10.0.0.1',
      port: 9100,
      metricsPath: '/metrics',
      protocol: 'http',
      timeout: 15,
      remoteWriteUrl: 'https://thanos.example/api/v1/write',
      hostName: 'SW-empty',
    });
    expect(result).toEqual({ result: 'success', metrics_pushed: 0, host_name: 'SW-empty' });
    expect(postCount).toBe(0);
    expect(dns).not.toHaveBeenCalled();
  });

  it('remote-write SSRF block prevents push', async () => {
    let postCount = 0;
    const fetcher: PrometheusFetcher = {
      get: async () => ({ status: 200, text: async () => SCRAPE_TEXT }),
      post: async () => {
        postCount += 1;
        return { status: 204, text: async () => '' };
      },
    };
    const svc = build(fetcher, dnsTo('10.0.0.1'), identitySnappy);
    await expect(
      svc.scrapeAndPush({
        targetIp: '10.0.0.1',
        port: 9100,
        metricsPath: '/metrics',
        protocol: 'http',
        timeout: 15,
        remoteWriteUrl: 'https://attacker.example/api/v1/write',
      }),
    ).rejects.toThrow(/private\/reserved/);
    expect(postCount).toBe(0);
  });
});
