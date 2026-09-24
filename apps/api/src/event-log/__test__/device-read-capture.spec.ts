import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import { defer, from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { BridgeCommissioningService } from 'src/brokkr-bridge/lifecycle/commissioning.service';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ActiveRecordContextProvider } from 'src/common/context/active-record-context.provider';
import { ContextService } from 'src/common/context/context.service';
import { DeviceSecretService } from 'src/device-secret/device-secret.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { BaremetalController } from 'src/devices/baremetal.controller';
import { BaremetalService } from 'src/devices/baremetal.service';
import { InventoryService } from 'src/inventory/inventory.service';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { CloudInitProcessor, ProvisionValidatorService } from 'src/provision/processors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from '../audit-action.decorator';
import { EventLogInterceptor } from '../event-log.interceptor';
import type { EventLogWrite } from '../event-log.types';

const ORG = 'org-1';

type Handler = (...args: never[]) => unknown;

function identity(): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(['device:read']),
    session: { user: { id: 'u-1', email: 'caller@example.com' } },
  } as unknown as IdentityContext;
}

describe('device read capture', () => {
  const deviceDelegate = { findMany: vi.fn(), count: vi.fn() };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  let contextService: ContextService;
  let service: BaremetalService;

  beforeEach(async () => {
    vi.clearAllMocks();
    deviceDelegate.findMany.mockResolvedValue([]);
    deviceDelegate.count.mockResolvedValue(0);

    contextService = new ContextService(new DesignationOperatorPolicy());
    const contextProvider = new ActiveRecordContextProvider(contextService);
    ActiveRecordRegistry.configureForTest({ device: deviceDelegate, $queryRaw: vi.fn() }, () =>
      contextProvider.getContext(),
    );

    const module = await Test.createTestingModule({
      providers: [
        BaremetalService,
        { provide: ContextService, useValue: contextService },
        { provide: PrismaClient, useValue: {} },
        { provide: BridgeCommissioningService, useValue: {} },
        { provide: BridgeInventoryCollectionService, useValue: {} },
        { provide: OrganizationsService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: LifecycleService, useValue: {} },
        { provide: CloudInitProcessor, useValue: {} },
        { provide: ProvisionValidatorService, useValue: {} },
        { provide: CloudInitTemplatesService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: vi.fn() } },
        { provide: DeviceSecretService, useValue: {} },
        { provide: DeviceTokensService, useValue: {} },
        { provide: DhcpConfigPublisherService, useValue: {} },
        { provide: 'LoggerServiceBaremetalService', useValue: logger },
      ],
    }).compile();
    service = module.get(BaremetalService);
  });

  const capture = async (handler: Handler, call: () => Promise<unknown>): Promise<EventLogWrite[]> => {
    const rows: EventLogWrite[] = [];
    const interceptor = new EventLogInterceptor(
      contextService,
      { recordBestEffort: async (write: EventLogWrite) => void rows.push(write) } as never,
      new Reflector(),
      logger as never,
    );
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          path: '/api/v1/servers',
          params: {},
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => handler,
    };

    await new Promise<void>((resolve) =>
      contextService.run(
        {
          requestId: 'req-1',
          identity: identity(),
          method: 'GET',
          path: '/api/v1/servers',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          interceptor
            .intercept(executionContext as never, { handle: () => defer(() => from(call())) })
            .subscribe({ complete: () => setImmediate(resolve), error: () => setImmediate(resolve) });
        },
      ),
    );

    return rows;
  };

  const listServers = () => service.getBaremetalServersPaginated({ page: 1 });

  it('reaches the device:read policy gate when the server list is paginated', async () => {
    const pushIntent = vi.spyOn(contextService, 'pushIntent');

    await capture(BaremetalController.prototype.getServers, listServers);

    expect(pushIntent).toHaveBeenCalledWith('device', 'read', false);
    expect(deviceDelegate.findMany).toHaveBeenCalledOnce();
  });

  it('writes no row for the server list read the interceptor wraps', async () => {
    const rows = await capture(BaremetalController.prototype.getServers, listServers);

    expect(rows).toEqual([]);
  });

  it('leaves the server list handler undecorated so its read gate cannot mint a synthetic row', () => {
    const options = new Reflector().get<AuditActionOptions | undefined>(
      AUDIT_ACTION_KEY,
      BaremetalController.prototype.getServers,
    );

    expect(options).toBeUndefined();
  });
});
