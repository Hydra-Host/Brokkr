import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { LAB_ROUTE, type LabRouteOptions } from '../../common/lab-route';
import { QueuesController } from '../queues.controller';

const reflector = new Reflector();

describe('QueuesController capability annotations', () => {
  it('prices every queue mutation at operate — each one rewrites shared queue state', () => {
    for (const handler of ['retryQueueJob', 'removeQueueJob', 'drainQueue', 'cleanQueue'] as const) {
      expect(
        reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, QueuesController.prototype[handler]),
        handler,
      ).toEqual({ capability: 'operate' });
    }
  });

  it('leaves the read-only inspectors untagged', () => {
    for (const handler of ['listQueues', 'listQueueJobs', 'getQueueJob'] as const) {
      expect(
        reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, QueuesController.prototype[handler]),
        handler,
      ).toBeUndefined();
    }
  });
});
