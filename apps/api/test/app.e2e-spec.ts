import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;
  let server: Server;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /healthcheck', () => {
    it('should return OK', async () => {
      const response = await request(server).get('/healthcheck').expect(200);

      expect(response.text).toBe('OK');
    });
  });

  describe('GET /api/v1/servers', () => {
    it('should return 401 when not authenticated', async () => {
      await request(server).get('/api/v1/servers').expect(401);
    });
  });
});
