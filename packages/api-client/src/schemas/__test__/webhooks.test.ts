import { CreateWebhookRequestSchema, WebhookStatsSchema } from '../webhooks';

function withEndpoint(endpoint: string) {
  return CreateWebhookRequestSchema.safeParse({
    endpoint,
    events: ['DEVICE_LISTING_UPDATED'],
  });
}

describe('webhook endpoint SSRF guard', () => {
  it('accepts a public HTTPS URL', () => {
    expect(withEndpoint('https://example.com/hooks').success).toBe(true);
    expect(withEndpoint('https://hooks.example.org:8443/path').success).toBe(true);
    expect(withEndpoint('https://[2606:2800:220:1:248:1893:25c8:1946]/hooks').success).toBe(true);
    expect(withEndpoint('https://[::ffff:5db8:d822]/hooks').success).toBe(true);
  });

  it.each([
    ['plain http', 'http://example.com/hooks'],
    ['ftp scheme', 'ftp://example.com/hooks'],
    ['not a url', 'not-a-url'],
    ['localhost', 'https://localhost/hooks'],
    ['*.localhost', 'https://api.localhost/hooks'],
    ['*.local', 'https://printer.local/hooks'],
    ['loopback ipv4', 'https://127.0.0.1/hooks'],
    ['private 10.x', 'https://10.0.0.5/hooks'],
    ['private 192.168.x', 'https://192.168.1.10/hooks'],
    ['private 172.16.x', 'https://172.16.0.1/hooks'],
    ['ipv6 loopback', 'https://[::1]/hooks'],
    ['ipv6 unspecified', 'https://[::]/hooks'],
    ['ipv6 ULA fc00::', 'https://[fc00::1]/hooks'],
    ['ipv6 ULA fd00::', 'https://[fd00::1]/hooks'],
    ['ipv6 link-local fe80::', 'https://[fe80::1]/hooks'],
    ['ipv6-mapped private (hex)', 'https://[::ffff:c0a8:0101]/hooks'],
  ])('rejects %s', (_label, endpoint) => {
    expect(withEndpoint(endpoint).success).toBe(false);
  });
});

describe('WebhookStatsSchema.recentDeliveries', () => {
  const INTERNAL_FIELDS = ['idempotencyKey', 'processingLockedBy', 'processingLockedAt', 'processingLockExpires'];

  it('strips internal queue/worker fields from deliveries', () => {
    const parsed = WebhookStatsSchema.parse({
      total: 1,
      active: 1,
      failed: 0,
      recentDeliveries: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          webhookId: '22222222-2222-4222-8222-222222222222',
          eventType: 'DEVICE_LISTING_UPDATED',
          payload: { a: 1 },
          status: 'SUCCESS',
          httpStatus: 200,
          responseBody: 'ok',
          errorMessage: null,
          attempts: 1,
          nextRetryAt: null,
          createdAt: new Date(),
          deliveredAt: new Date(),
          idempotencyKey: 'idem-1',
          processingLockedBy: 'worker-1',
          processingLockedAt: new Date(),
          processingLockExpires: new Date(),
        },
      ],
    });

    for (const field of INTERNAL_FIELDS) {
      expect(parsed.recentDeliveries[0]).not.toHaveProperty(field);
    }
  });
});
