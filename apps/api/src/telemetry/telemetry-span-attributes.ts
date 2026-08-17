import { RequestSource } from '@repo/database';
import { AuthType } from 'src/auth/identity-context';

export type TelemetryIdentityView =
  | { authType: AuthType.Session; organizationId: string; session: { user: { id: string } } }
  | { authType: AuthType.ApiKey; organizationId: string; user: { id: string } };

export interface TelemetryDeviceIdentityView {
  deviceId: string;
  context: string;
  supplierId: string | null;
}

export interface TelemetryRequestView {
  requestId?: string;
  identity?: TelemetryIdentityView;
  deviceIdentity?: TelemetryDeviceIdentityView;
  sessionUser?: { id: string };
}

/** IDs only — never email or names: attributes are exported to third-party backends. */
export function buildTelemetrySpanAttributes(view: TelemetryRequestView): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {
    'brokkr.request_id': view.requestId,
  };

  if (view.deviceIdentity) {
    attributes['brokkr.request_source'] = RequestSource.DEVICE;
    attributes['brokkr.device_id'] = view.deviceIdentity.deviceId;
    attributes['brokkr.device_token_context'] = view.deviceIdentity.context;
    if (view.deviceIdentity.supplierId) {
      attributes['brokkr.organization_id'] = view.deviceIdentity.supplierId;
    }
    return attributes;
  }

  const identity = view.identity;
  if (!identity) {
    if (view.sessionUser) {
      attributes['enduser.id'] = view.sessionUser.id;
      attributes['brokkr.auth_type'] = AuthType.Session;
      attributes['brokkr.request_source'] = RequestSource.UI;
    }
    return attributes;
  }

  attributes['brokkr.organization_id'] = identity.organizationId;
  attributes['brokkr.auth_type'] = identity.authType;
  attributes['brokkr.request_source'] = identity.authType === AuthType.ApiKey ? RequestSource.API : RequestSource.UI;
  attributes['enduser.id'] = identity.authType === AuthType.Session ? identity.session.user.id : identity.user.id;
  return attributes;
}
