import { Controller, Get, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DesignationOperatorPolicy, OPERATOR_POLICY } from 'src/common/authz/operator-policy';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextMiddleware } from '../context.middleware';
import { ContextService, type RequestFields } from '../context.service';

@Controller()
class ProbeController {
  constructor(private readonly contextService: ContextService) {}

  @Get('/api/v1/zones/:id')
  read(): RequestFields {
    return this.contextService.requestFields();
  }
}

@Module({
  controllers: [ProbeController],
  providers: [ContextService, { provide: OPERATOR_POLICY, useClass: DesignationOperatorPolicy }],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ContextMiddleware).forRoutes('*');
  }
}

describe('ContextMiddleware request provenance', () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  async function createApp() {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    const nestApp = moduleRef.createNestApplication();
    await nestApp.init();
    return nestApp;
  }

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes the request method, path, ip and user agent through requestFields', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/zones/z-1?include=ips')
      .set('user-agent', 'brokkr-cli/1.2.3');

    expect(response.status).toBe(200);
    expect(response.body.method).toBe('GET');
    expect(response.body.path).toBe('/api/v1/zones/z-1');
    expect(response.body.userAgent).toBe('brokkr-cli/1.2.3');
    expect(response.body.ipAddress).toContain('127.0.0.1');
  });

  it('reports a null user agent when the header is absent', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/zones/z-2').unset('User-Agent');

    expect(response.status).toBe(200);
    expect(response.body.userAgent).toBeNull();
    expect(response.body.path).toBe('/api/v1/zones/z-2');
  });
});
