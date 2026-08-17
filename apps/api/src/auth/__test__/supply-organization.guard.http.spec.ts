import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationMembershipRole, TenantType } from '@repo/database';
import type { Server } from 'http';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy, OPERATOR_POLICY } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { CableController } from 'src/dcim/cable/cable.controller';
import { CableService } from 'src/dcim/cable/cable.service';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const CABLE_ID = '11111111-1111-1111-1111-111111111111';
const CABLE_PATH = `/api/v1/dcim/cables/${CABLE_ID}`;

function tenantIdentity(tenantType: TenantType): IdentityContext {
  return {
    authType: AuthType.Session,
    role: OrganizationMembershipRole.Member,
    organizationId: 'org-1',
    organization: { id: 'org-1', tenantType, isInstanceOperator: false },
    session: { user: { id: 'u', email: 'caller@example.com' } },
  } as unknown as IdentityContext;
}

describe('SupplyOrganizationGuard (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let findById: ReturnType<typeof vi.fn>;
  let currentIdentity: IdentityContext | undefined;

  beforeAll(async () => {
    findById = vi.fn().mockResolvedValue({ id: CABLE_ID });

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CableController],
      providers: [
        ContextService,
        { provide: OPERATOR_POLICY, useClass: DesignationOperatorPolicy },
        { provide: CableService, useValue: { findById } },
      ],
    }).compile();

    const contextService = moduleRef.get(ContextService);
    app = moduleRef.createNestApplication();
    app.use((_req: unknown, _res: unknown, next: () => void) => {
      contextService.run({ requestId: 'test-req', identity: currentIdentity }, next);
    });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    currentIdentity = undefined;
    findById.mockClear();
  });

  it('returns 403 for a demand tenant and never reaches the handler', async () => {
    currentIdentity = tenantIdentity(TenantType.DemandCustomer);

    await request(server).get(CABLE_PATH).expect(403);

    expect(findById).not.toHaveBeenCalled();
  });

  it('lets a supply tenant through to the handler', async () => {
    currentIdentity = tenantIdentity(TenantType.SupplyCustomer);

    await request(server).get(CABLE_PATH).expect(200);

    expect(findById).toHaveBeenCalledWith(CABLE_ID);
  });

  it('returns 401 fail-closed when no identity is in scope', async () => {
    currentIdentity = undefined;

    await request(server).get(CABLE_PATH).expect(401);

    expect(findById).not.toHaveBeenCalled();
  });
});
