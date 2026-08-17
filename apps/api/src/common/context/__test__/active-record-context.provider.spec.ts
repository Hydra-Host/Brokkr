import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { describe, expect, it } from 'vitest';
import { ActiveRecordContextProvider } from '../active-record-context.provider';
import { ContextService } from '../context.service';

function setup() {
  const contextService = new ContextService(new DesignationOperatorPolicy());
  return { contextService, provider: new ActiveRecordContextProvider(contextService) };
}

function userIdentity(): IdentityContext {
  return {
    authType: AuthType.Session,
    organizationId: 'org-user',
    permissions: new Set(['device:read']),
    organization: { id: 'org-user' },
    role: 'Member',
    session: { user: { id: 'u1', email: 'u@example.com' } },
  } as unknown as IdentityContext;
}

describe('ActiveRecordContextProvider.getContext', () => {
  it('maps a user identity to a user context (org + permissions, not system)', () => {
    const { contextService, provider } = setup();
    const identity = userIdentity();
    contextService.run({ requestId: 'r', identity }, () => {
      const ctx = provider.getContext();
      expect(ctx?.organizationId).toBe('org-user');
      expect(ctx?.permissions).toBe(identity.permissions);
      expect(ctx?.system).toBeUndefined();
    });
  });

  it('maps a runAsSystem scope to a system context', () => {
    const { contextService, provider } = setup();
    contextService.runAsSystem('org-sys', () => {
      const ctx = provider.getContext();
      expect(ctx?.organizationId).toBe('org-sys');
      expect(ctx?.system).toBe(true);
    });
  });

  it('records a policy check as a permission intent', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r', identity: userIdentity() }, () => {
      provider.getContext()?.onPermissionCheck?.('device:update', false);

      expect(contextService.drainIntents()).toEqual([
        expect.objectContaining({ resource: 'device', action: 'update', denied: false }),
      ]);
    });
  });

  it('records a denied policy check', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r', identity: userIdentity() }, () => {
      provider.getContext()?.onPermissionCheck?.('device:update', true);

      expect(contextService.drainIntents()).toEqual([expect.objectContaining({ denied: true })]);
    });
  });

  it('records intents from a system context too', () => {
    const { contextService, provider } = setup();
    contextService.runAsSystem('org-sys', () => {
      provider.getContext()?.onPermissionCheck?.('prefix:create', false);

      expect(contextService.drainIntents()).toEqual([expect.objectContaining({ resource: 'prefix' })]);
    });
  });

  it('ignores a key with no resource/action separator', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r', identity: userIdentity() }, () => {
      provider.getContext()?.onPermissionCheck?.('malformed', false);

      expect(contextService.drainIntents()).toEqual([]);
    });
  });

  it('splits on the first separator so an action may contain a colon', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r', identity: userIdentity() }, () => {
      provider.getContext()?.onPermissionCheck?.('device:sub:action', false);

      expect(contextService.drainIntents()).toEqual([
        expect.objectContaining({ resource: 'device', action: 'sub:action' }),
      ]);
    });
  });

  it('returns undefined with neither an identity nor a system context', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r' }, () => {
      expect(provider.getContext()).toBeUndefined();
    });
  });

  it('resolves a user identity ahead of the system flag (no self-escalation to system)', () => {
    const { contextService, provider } = setup();
    contextService.run({ requestId: 'r', identity: userIdentity(), system: true }, () => {
      const ctx = provider.getContext();
      expect(ctx?.system).toBeUndefined();
      expect(ctx?.organizationId).toBe('org-user');
    });
  });
});
