import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhwBaseboardHandler } from '../ghw_baseboard.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/ghw_baseboard', `${name}.json`), 'utf8'));

describe('GhwBaseboardHandler', () => {
  const handler = new GhwBaseboardHandler();

  it('writes baseboardSerial; blanks asset_tag via hardwareString', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.deviceUpdate).toEqual({ baseboardSerial: 'BR80H2000800168' });
    expect(parsed.baseboard.asset_tag).toBeNull();
    expect(parsed.baseboard.version).toBeNull();
  });
});
