import { describe, expect, it } from 'vitest';
import { resolveGatewaySelection } from './edit';

describe('resolveGatewaySelection (gateway field → updatePrefix body)', () => {
  it('maps the empty selection to a null gateway with no validation', () => {
    expect(resolveGatewaySelection('', null)).toEqual({ gatewayIpId: null, needsValidation: false });
  });

  it('clears an existing gateway without validation', () => {
    expect(resolveGatewaySelection('', 'ip-1')).toEqual({ gatewayIpId: null, needsValidation: false });
  });

  it('requires validation when assigning a gateway to a prefix without one', () => {
    expect(resolveGatewaySelection('ip-1', null)).toEqual({ gatewayIpId: 'ip-1', needsValidation: true });
  });

  it('requires validation when switching to a different gateway', () => {
    expect(resolveGatewaySelection('ip-2', 'ip-1')).toEqual({ gatewayIpId: 'ip-2', needsValidation: true });
  });

  it('skips validation when the selection matches the current gateway', () => {
    expect(resolveGatewaySelection('ip-1', 'ip-1')).toEqual({ gatewayIpId: 'ip-1', needsValidation: false });
  });
});
