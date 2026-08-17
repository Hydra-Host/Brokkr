import { Test, TestingModule } from '@nestjs/testing';
import type { WebVitalMetric } from '@repo/api-client';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WebVitalsController } from '../web-vitals.controller';
import { WebVitalsService } from '../web-vitals.service';

const metric: WebVitalMetric = {
  name: 'LCP',
  value: 1830.4,
  rating: 'needs-improvement',
  delta: 1830.4,
  id: 'v5-lcp',
  route: '/servers/$serverId',
};

describe('WebVitalsController', () => {
  let controller: WebVitalsController;
  let record: Mock;

  beforeEach(async () => {
    record = vi.fn().mockReturnValue({ accepted: 1 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebVitalsController],
      providers: [{ provide: WebVitalsService, useValue: { record } }],
    }).compile();

    controller = module.get(WebVitalsController);
  });

  it('binds the ts-rest handler to a 202 with the service result as the body', async () => {
    const handler = await controller.reportWebVitals();

    const res = await handler({ body: { metrics: [metric] }, headers: {} });

    expect(record).toHaveBeenCalledWith([metric]);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1 });
  });
});
