import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { CircuitTypeController } from 'src/circuits/circuit-type/circuit-type.controller';
import { ProviderNetworkController } from 'src/circuits/provider-network/provider-network.controller';
import { ProviderController } from 'src/circuits/provider/provider.controller';
import { RackRoleController } from 'src/dcim/rack-role/rack-role.controller';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from '../audit-action.decorator';

const reflector = new Reflector();

function auditOptions(controller: object, method: string): AuditActionOptions | undefined {
  const prototype = controller as { prototype: Record<string, unknown> };
  return reflector.get<AuditActionOptions | undefined>(AUDIT_ACTION_KEY, prototype.prototype[method] as never);
}

const CONTROLLERS: [string, object, string][] = [
  ['circuit-type', CircuitTypeController, 'circuit-type'],
  ['provider', ProviderController, 'provider'],
  ['provider-network', ProviderNetworkController, 'provider-network'],
  ['rack-role', RackRoleController, 'rack-role'],
];

describe('operator-gated capture', () => {
  it.each(CONTROLLERS)('leaves %s list undecorated so a guarded read emits nothing', (_name, controller) => {
    expect(auditOptions(controller, 'list')).toBeUndefined();
  });

  it.each(CONTROLLERS)('leaves %s getById undecorated so a guarded read emits nothing', (_name, controller) => {
    expect(auditOptions(controller, 'getById')).toBeUndefined();
  });

  it.each(CONTROLLERS)('decorates %s create', (_name, controller, resource) => {
    expect(auditOptions(controller, 'create')).toMatchObject({
      actionKey: `${resource}.created`,
      resource,
      action: 'create',
    });
  });

  it.each(CONTROLLERS)('decorates %s update', (_name, controller, resource) => {
    expect(auditOptions(controller, 'update')).toMatchObject({
      actionKey: `${resource}.updated`,
      resource,
      action: 'update',
    });
  });

  it.each(CONTROLLERS)('decorates %s delete', (_name, controller, resource) => {
    expect(auditOptions(controller, 'delete')).toMatchObject({
      actionKey: `${resource}.deleted`,
      resource,
      action: 'delete',
    });
  });
});
