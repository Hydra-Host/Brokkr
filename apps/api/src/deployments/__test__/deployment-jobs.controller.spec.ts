import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentJobsController } from '../controllers/deployment-jobs.controller';
import { DeploymentJobsService } from '../services/deployment-jobs.service';

const JOB = '44444444-4444-4444-4444-444444444444';
const page = { data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } };
const events = { data: [], meta: { truncated: false, cap: 500 } };

describe('DeploymentJobsController', () => {
  const service = { list: vi.fn(), events: vi.fn() };
  let controller: DeploymentJobsController;

  beforeEach(async () => {
    vi.clearAllMocks();
    service.list.mockResolvedValue(page);
    service.events.mockResolvedValue(events);

    const module = await Test.createTestingModule({
      controllers: [DeploymentJobsController],
      providers: [{ provide: DeploymentJobsService, useValue: service }],
    }).compile();

    controller = module.get(DeploymentJobsController);
  });

  it('lists the jobs of the deployment in the path with the pagination query', async () => {
    const handler = await controller.listDeploymentJobs();

    const response = await handler({ params: { id: 'deploy-1' }, query: { page: 2, pageSize: 10 }, headers: {} });

    expect(service.list).toHaveBeenCalledWith('deploy-1', { page: 2, pageSize: 10 });
    expect(response).toEqual({ status: 200, body: page });
  });

  it('reads the events of the job and deployment in the path', async () => {
    const handler = await controller.getDeploymentJobEvents();

    const response = await handler({ params: { id: 'deploy-1', jobId: JOB }, headers: {} });

    expect(service.events).toHaveBeenCalledWith('deploy-1', JOB);
    expect(response).toEqual({ status: 200, body: events });
  });
});
