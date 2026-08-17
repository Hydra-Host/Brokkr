import { afterAll, beforeAll } from 'vitest';

export function withEnv(key: string, value: string): void {
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env[key];
    process.env[key] = value;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}
