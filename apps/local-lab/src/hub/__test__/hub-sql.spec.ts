import { describe, expect, it } from 'vitest';

import {
  DEVICE_TOKEN_EVENTS_SQL,
  LIFECYCLE_PHASE_COUNTS_SQL,
  DEVICE_TOKENS_SQL,
  deviceTokenLastUsedKey,
  DeviceTokenSqlRowSchema,
  LIFECYCLE_JOB_BY_ID_SQL,
  LIFECYCLE_JOB_EVENTS_SQL,
  LIFECYCLE_JOBS_SQL,
  WEBHOOK_DELIVERIES_SQL,
  WebhookDeliverySqlRowSchema,
} from '../hub-sql';

const ALL_SQL = [
  WEBHOOK_DELIVERIES_SQL,
  LIFECYCLE_JOBS_SQL,
  LIFECYCLE_JOB_BY_ID_SQL,
  LIFECYCLE_JOB_EVENTS_SQL,
  DEVICE_TOKENS_SQL,
  DEVICE_TOKEN_EVENTS_SQL,
];

describe('hub sql never reads a secret column', () => {
  it('selects no webhook signing secret', () => {
    for (const sql of ALL_SQL) expect(sql).not.toMatch(/\bsecret\b/i);
  });

  it('selects no device token hash', () => {
    for (const sql of ALL_SQL) expect(sql).not.toMatch(/tokenHash/i);
  });

  it('models neither column, so a reader cannot surface one by accident', () => {
    expect(Object.keys(DeviceTokenSqlRowSchema.shape)).not.toContain('tokenHash');
    expect(Object.keys(WebhookDeliverySqlRowSchema.shape)).not.toContain('secret');
  });

  it('reads the token by its non-secret display id instead', () => {
    expect(DEVICE_TOKENS_SQL).toContain('"displayId"');
    expect(Object.keys(DeviceTokenSqlRowSchema.shape)).toContain('displayId');
  });
});

describe('hub sql is parameterized', () => {
  it('every filtered statement binds its values as placeholders', () => {
    for (const sql of ALL_SQL) expect(sql).toMatch(/\$\d/);
  });

  it('carries no string interpolation of a caller value', () => {
    for (const sql of ALL_SQL) expect(sql).not.toContain('${');
  });

  it('reads only, never writes', () => {
    for (const sql of ALL_SQL) {
      expect(sql.trimStart().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    }
  });
});

describe('row coercion', () => {
  it('turns a pg timestamp into unix milliseconds', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    const row = DeviceTokenSqlRowSchema.parse({
      id: 'tok-1',
      displayId: 'dtok_abc',
      deviceId: 'dev-1',
      deploymentId: null,
      context: 'BROKKR_LIVE',
      status: 'ACTIVE',
      rotationGeneration: 0,
      expiresAt: null,
      lastUsedAt: at,
      lastUsedIp: '10.0.0.1',
      revokedAt: null,
      revokedReason: null,
      issuedBy: null,
      createdAt: at,
    });

    expect(row.lastUsedAt).toBe(at.getTime());
    expect(row.expiresAt).toBeNull();
  });

  it('normalises an empty string to null so a blank column never reads as a value', () => {
    const row = WebhookDeliverySqlRowSchema.parse({
      id: 'del-1',
      webhookId: 'wh-1',
      endpoint: '',
      eventType: 'DEPLOYMENT_INTERRUPTED',
      status: 'PENDING',
      httpStatus: null,
      attempts: 0,
      errorMessage: '',
      idempotencyKey: null,
      nextRetryAt: null,
      createdAt: new Date(),
      deliveredAt: null,
      processingLockedBy: null,
      processingLockedAt: null,
      processingLockExpires: null,
      payload: {},
      responseBody: null,
    });

    expect(row.endpoint).toBeNull();
    expect(row.errorMessage).toBeNull();
  });
});

describe('deviceTokenLastUsedKey', () => {
  it('carries no zone prefix, because the hub writes it globally', () => {
    expect(deviceTokenLastUsedKey('tok-1')).toBe('device-token:tok-1:last-used');
  });
});

describe('the lifecycle statements', () => {
  it('treats an empty phase list as no filter, which a bare ANY would read as no rows', () => {
    expect(LIFECYCLE_JOBS_SQL).toContain('cardinality($1::text[]) = 0');
  });

  it('censuses without the phase filter, so a tile states the fleet and not the selection', () => {
    expect(LIFECYCLE_PHASE_COUNTS_SQL).not.toMatch(/phase[^\n]*=/);
    expect(LIFECYCLE_PHASE_COUNTS_SQL).toContain('GROUP BY j.phase');
  });

  it('takes the newest event for the row, so a phase reads against the step it is actually on', () => {
    expect(LIFECYCLE_JOBS_SQL).toContain('LEFT JOIN LATERAL');
    expect(LIFECYCLE_JOBS_SQL).toMatch(/ORDER BY e\."recordedAt" DESC\s+LIMIT 1/);
  });
})
