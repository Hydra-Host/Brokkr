import { afterAll, beforeAll, describe, expect, it } from 'vitest';


describe('AppModule (DI graph compiles)', () => {
  const savedEnv = { ...process.env };

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    const urlKeys = ['DATABASE_URL', 'REDIS_URL', 'BASE_URL', 'S3_ENDPOINT_URL'];
    const plainKeys = [
      'HH_ENV',
      'BROKKR_HUB_PRIVATE_KEY',
      'S3_ACCESS_KEY_ID',
      'S3_BUCKET',
      'S3_SECRET_ACCESS_KEY',
      'BETTER_AUTH_SECRET',
      'DEVICE_TOKEN_PEPPER',
    ];
    for (const k of urlKeys) {
      process.env[k] ??= k === 'DATABASE_URL' ? 'postgresql://stub:stub@localhost:5432/stub' : 'http://localhost';
    }
    process.env.REDIS_URL = 'redis://localhost:6379';
    for (const k of plainKeys) process.env[k] ??= 'stub';
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('resolves every provider without a missing/dangling dependency', async () => {
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../app.module');

    const silentLogger = { log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, verbose: () => {} };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .setLogger(silentLogger)
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60_000);
});
