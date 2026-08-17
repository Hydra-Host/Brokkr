import { AuthType } from 'src/auth/identity-context';
import { describe, expect, it } from 'vitest';
import { buildTelemetrySpanAttributes } from '../telemetry-span-attributes';

describe('buildTelemetrySpanAttributes', () => {
  it('carries only the request id when no identity is present (public routes)', () => {
    const attributes = buildTelemetrySpanAttributes({ requestId: 'req-1' });
    expect(attributes).toEqual({ 'brokkr.request_id': 'req-1' });
  });

  it('maps a session identity to id-only attributes', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      identity: {
        authType: AuthType.Session,
        organizationId: 'org-1',
        session: { user: { id: 'user-1' } },
      },
    });
    expect(attributes).toEqual({
      'brokkr.request_id': 'req-1',
      'brokkr.organization_id': 'org-1',
      'brokkr.auth_type': AuthType.Session,
      'brokkr.request_source': 'UI',
      'enduser.id': 'user-1',
    });
  });

  it('maps an api-key identity to API request source', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      identity: {
        authType: AuthType.ApiKey,
        organizationId: 'org-1',
        user: { id: 'user-2' },
      },
    });
    expect(attributes).toEqual({
      'brokkr.request_id': 'req-1',
      'brokkr.organization_id': 'org-1',
      'brokkr.auth_type': AuthType.ApiKey,
      'brokkr.request_source': 'API',
      'enduser.id': 'user-2',
    });
  });

  it('maps a session-only user (no org identity) to id-only attributes', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      sessionUser: { id: 'user-3' },
    });
    expect(attributes).toEqual({
      'brokkr.request_id': 'req-1',
      'enduser.id': 'user-3',
      'brokkr.auth_type': AuthType.Session,
      'brokkr.request_source': 'UI',
    });
  });

  it('prefers full identity over the session-only fallback', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      sessionUser: { id: 'user-3' },
      identity: {
        authType: AuthType.ApiKey,
        organizationId: 'org-1',
        user: { id: 'user-2' },
      },
    });
    expect(attributes['enduser.id']).toBe('user-2');
    expect(attributes['brokkr.organization_id']).toBe('org-1');
  });

  it('never emits email or name attributes', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      identity: {
        authType: AuthType.Session,
        organizationId: 'org-1',
        session: { user: { id: 'user-1' } },
      },
    });
    const keys = Object.keys(attributes).join(' ');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('name');
  });

  it('prefers device identity and uses the supplier as organization', () => {
    const attributes = buildTelemetrySpanAttributes({
      requestId: 'req-1',
      deviceIdentity: { deviceId: 'dev-1', context: 'DEPLOYMENT_OS', supplierId: 'org-9' },
      identity: {
        authType: AuthType.Session,
        organizationId: 'org-1',
        session: { user: { id: 'user-1' } },
      },
    });
    expect(attributes).toEqual({
      'brokkr.request_id': 'req-1',
      'brokkr.request_source': 'DEVICE',
      'brokkr.device_id': 'dev-1',
      'brokkr.device_token_context': 'DEPLOYMENT_OS',
      'brokkr.organization_id': 'org-9',
    });
  });

  it('omits organization for device tokens without a supplier', () => {
    const attributes = buildTelemetrySpanAttributes({
      deviceIdentity: { deviceId: 'dev-1', context: 'BROKKR_LIVE', supplierId: null },
    });
    expect(attributes['brokkr.organization_id']).toBeUndefined();
  });
});
