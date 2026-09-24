import { API_PREFIX } from '@repo/api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectModuleControllers, controllerRoutePaths } from './controller-route-paths';

const UNPREFIXED_ROUTES = new Set(['/api/events/devices', '/healthcheck', '/version', '/whoami']);

describe(`AppModule controllers register routes under the ${API_PREFIX} prefix`, () => {
  const savedEnv = { ...process.env };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??= 'postgresql://stub:stub@localhost:5432/stub';
    process.env.REDIS_URL = 'redis://localhost:6379';
    for (const key of ['BASE_URL', 'S3_ENDPOINT_URL']) process.env[key] ??= 'http://localhost';
    for (const key of [
      'HH_ENV',
      'BROKKR_HUB_PRIVATE_KEY',
      'S3_ACCESS_KEY_ID',
      'S3_BUCKET',
      'S3_SECRET_ACCESS_KEY',
      'BETTER_AUTH_SECRET',
      'DEVICE_TOKEN_PEPPER',
    ]) {
      process.env[key] ??= 'stub';
    }
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('every bound route outside the infra allowlist starts with the API prefix', async () => {
    const { AppModule } = await import('../app.module');
    const controllers = collectModuleControllers(AppModule);
    expect(controllers.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    const unprefixedSeen = new Set<string>();
    for (const controller of controllers) {
      for (const path of controllerRoutePaths(controller)) {
        if (path.startsWith(`${API_PREFIX}/`)) continue;
        if (UNPREFIXED_ROUTES.has(path)) unprefixedSeen.add(path);
        else offenders.push(`${controller.name} ${path}`);
      }
    }
    expect(offenders).toEqual([]);
    expect([...unprefixedSeen].sort()).toEqual([...UNPREFIXED_ROUTES].sort());
  }, 60_000);
});
