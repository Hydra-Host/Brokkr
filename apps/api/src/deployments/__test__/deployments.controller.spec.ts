import { Test, TestingModule } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { vi } from 'vitest';
import { DeploymentsController } from '../controllers/deployments.controller';
import { DeploymentsService } from '../services/deployments.service';

describe('DeploymentsController', () => {
  let controller: DeploymentsController;
  let service: { reprovisionDirectProvisionDeployment: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    service = {
      getDeploymentsForOrganizations: vi.fn(),
      getDeploymentById: vi.fn(),
      updateDeploymentNickname: vi.fn(),
      reprovisionDirectProvisionDeployment: vi.fn(),
      rebootDirectProvisionDevice: vi.fn(),
      powerControlDevice: vi.fn(),
      deprovisionDirectProvisionDevice: vi.fn(),
      activateRescueMode: vi.fn(),
      deactivateRescueMode: vi.fn(),
      getLogsForDeploymentJob: vi.fn(),
      toggleDeploymentLock: vi.fn(),
      getInterruptibleClaims: vi.fn(),
    } as never;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeploymentsController],
      providers: [
        {
          provide: DeploymentsService,
          useFactory: () => service,
        },
        {
          provide: ContextService,
          useFactory: () => ({
            requireIdentity: { organizationId: 'test-org-id' },
          }),
        },
      ],
    }).compile();

    controller = module.get<DeploymentsController>(DeploymentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('forwards the tee flag to the service on reprovision (not silently dropped)', async () => {
    const handler = await controller.reprovisionDeployment();
    await handler({
      params: { id: 'deploy-1' },
      body: {
        deploymentName: 'n',
        operatingSystem: 'ipxe-custom',
        sshKeyIds: ['key-1'],
        diskLayouts: [],
        tee: true,
      },
    } as never);

    expect(service.reprovisionDirectProvisionDeployment).toHaveBeenCalledWith(
      'deploy-1',
      expect.objectContaining({ tee: true }),
    );
  });
});
