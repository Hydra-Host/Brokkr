import { type MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import { AccessLogMiddleware } from '../common/middleware/access-log.middleware.js';
import { JobIdMiddleware } from '../common/middleware/job-id.middleware.js';
import { ResponseTimingMiddleware } from '../common/middleware/response-timing.middleware.js';

describe('AppModule', () => {
  it('compiles with every imported subsystem module resolvable', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('registers the three middlewares against every route in order', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.get(AppModule);

    interface RecordedRouteInfo {
      path: string;
      method: RequestMethod;
    }
    const recorded: { classes: Array<new (...args: never[]) => unknown>; routes: RecordedRouteInfo[] } = {
      classes: [],
      routes: [],
    };

    const consumer: MiddlewareConsumer = {
      apply(...middleware: Array<new (...args: never[]) => unknown>) {
        recorded.classes.push(...middleware);
        return {
          exclude: () => this,
          forRoutes: (...routes: RecordedRouteInfo[]) => {
            recorded.routes.push(...routes);
            return this;
          },
          with: () => this,
        };
      },
    } as unknown as MiddlewareConsumer;

    app.configure(consumer);

    expect(recorded.classes).toEqual([JobIdMiddleware, ResponseTimingMiddleware, AccessLogMiddleware]);
    expect(recorded.routes).toEqual([{ path: '*', method: RequestMethod.ALL }]);

    await moduleRef.close();
  });
});
