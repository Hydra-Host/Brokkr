import { Test, TestingModule } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { vi } from 'vitest';
import { DeploymentsController } from '../controllers/deployments.controller';
import { DeploymentsService } from '../services/deployments.service';

describe('DeploymentsController', () => {
  let controller: DeploymentsController;
  let service: {
    reprovisionDirectProvisionDeployment: ReturnType<typeof vi.fn>;
    rebootDirectProvisionDevice: ReturnType<typeof vi.fn>;
    powerControlDevice: ReturnType<typeof vi.fn>;
    deprovisionDirectProvisionDevice: ReturnType<typeof vi.fn>;
    activateRescueMode: ReturnType<typeof vi.fn>;
    deactivateRescueMode: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      getDeploymentsForOrganizations: vi.fn(),
      getDeploymentById: vi.fn(),
      updateDeploymentNickname: vi.fn(),
      reprovisionDirectProvisionDeployment: vi.fn().mockResolvedValue({ data: { id: 'job-reprovision-1' } }),
      rebootDirectProvisionDevice: vi.fn().mockResolvedValue({ data: { id: 'job-reboot-1' } }),
      powerControlDevice: vi.fn().mockResolvedValue({ data: { id: 'job-power-1' } }),
      deprovisionDirectProvisionDevice: vi.fn().mockResolvedValue({ data: { id: 'job-deprovision-1' } }),
      activateRescueMode: vi.fn().mockResolvedValue('plan-rescue-activate-1'),
      deactivateRescueMode: vi.fn().mockResolvedValue('plan-rescue-deactivate-1'),
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

  it('returns the lifecycle job id from reprovision', async () => {
    const handler = await controller.reprovisionDeployment();
    const response = await handler({
      params: { id: 'deploy-1' },
      body: { deploymentName: 'n', operatingSystem: 'ubuntu-22', sshKeyIds: [], diskLayouts: [] },
    } as never);

    expect(response).toEqual({ status: 200, body: { success: true, jobId: 'job-reprovision-1' } });
  });

  it('returns the lifecycle job id from reboot', async () => {
    const handler = await controller.rebootDevice();
    const response = await handler({ params: { id: 'deploy-1' } } as never);

    expect(response).toEqual({ status: 200, body: { success: true, jobId: 'job-reboot-1' } });
  });

  it('returns the lifecycle job id from power cycle', async () => {
    const handler = await controller.powerCycleDevice();
    const response = await handler({ params: { id: 'deploy-1' } } as never);

    expect(response).toEqual({ status: 200, body: { success: true, jobId: 'job-reboot-1' } });
  });

  it('returns the lifecycle job id from power control', async () => {
    const handler = await controller.powerControlDevice();
    const response = await handler({ params: { id: 'deploy-1' }, body: { operation: 'off' } } as never);

    expect(service.powerControlDevice).toHaveBeenCalledWith('deploy-1', { operation: 'off' });
    expect(response).toEqual({ status: 200, body: { success: true, jobId: 'job-power-1' } });
  });

  it('returns the lifecycle job id from deprovision', async () => {
    const handler = await controller.deprovisionDevice();
    const response = await handler({ params: { id: 'deploy-1' } } as never);

    expect(response).toEqual({ status: 200, body: { success: true, jobId: 'job-deprovision-1' } });
  });

  it('returns the bridge plan id from rescue activate', async () => {
    const handler = await controller.activateRescueMode();
    const response = await handler({ params: { id: 'deploy-1' } } as never);

    expect(response).toEqual({
      status: 200,
      body: { success: true, message: 'Rescue mode activated', planId: 'plan-rescue-activate-1' },
    });
  });

  it('returns the bridge plan id from rescue deactivate', async () => {
    const handler = await controller.deactivateRescueMode();
    const response = await handler({ params: { id: 'deploy-1' } } as never);

    expect(response).toEqual({
      status: 200,
      body: { success: true, message: 'Rescue mode deactivated', planId: 'plan-rescue-deactivate-1' },
    });
  });
});
