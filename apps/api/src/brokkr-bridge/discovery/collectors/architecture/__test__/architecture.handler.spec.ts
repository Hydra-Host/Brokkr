import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchitectureHandler } from '../architecture.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/architecture', `${name}.json`), 'utf8'));

describe('ArchitectureHandler', () => {
  const handler = new ArchitectureHandler();

  it('parses happy-path fixture and writes Device.architecture', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({ architecture: 'x86_64' });
  });

  it('rejects input when machine is missing', () => {
    const out = handler.schema.safeParse({});
    expect(out.success).toBe(false);
  });

  it('rejects input when machine is empty', () => {
    const out = handler.schema.safeParse({ machine: '' });
    expect(out.success).toBe(false);
  });

  it('tolerates extra fields via passthrough', () => {
    const out = handler.schema.safeParse({ machine: 'aarch64', future_field: 'whatever' });
    expect(out.success).toBe(true);
  });
});
