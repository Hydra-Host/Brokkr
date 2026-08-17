const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  HH_ENV: 'test',
  BROKKR_ADMIN_ORG_ID: 'org_test',
  BASE_URL: 'http://localhost',
  DATABASE_URL: 'postgresql://stub:stub@localhost:5432/stub',
  REDIS_URL: 'redis://localhost:6379',
  BROKKR_HUB_PRIVATE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  S3_ACCESS_KEY_ID: 'test',
  S3_BUCKET: 'test',
  S3_SECRET_ACCESS_KEY: 'test',
  S3_ENDPOINT_URL: 'http://localhost',
  BETTER_AUTH_SECRET: 'test',
  DEVICE_TOKEN_PEPPER: 'test',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
