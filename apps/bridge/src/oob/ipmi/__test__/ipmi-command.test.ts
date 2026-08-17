import { describe, expect, it } from 'vitest';

import { buildBaseCommand, ipmitoolBin, withCsvFlag } from '../command.js';
import { createIpmiDevice } from '../device.js';

describe('buildBaseCommand', () => {
  it('emits the canonical argv without a cipher flag when device.cipher is null', () => {
    const d = createIpmiDevice({ ip: '10.0.0.1', username: 'admin', password: 's3cret', port: 623 });
    const cmd = buildBaseCommand(d);
    expect(cmd).toEqual([ipmitoolBin(), '-H', '10.0.0.1', '-U', 'admin', '-P', 's3cret', '-p', '623', '-I', 'lanplus']);
  });

  it('appends -C<cipher> when device.cipher is set', () => {
    const d = createIpmiDevice({ ip: '10.0.0.1', username: 'u', password: 'p', port: 624, cipher: '3' });
    const cmd = buildBaseCommand(d);
    expect(cmd[cmd.length - 1]).toBe('-C3');
    expect(cmd.slice(-3, -1)).toEqual(['-I', 'lanplus']);
    expect(cmd).toContain('-p');
    expect(cmd[cmd.indexOf('-p') + 1]).toBe('624');
  });
});

describe('withCsvFlag', () => {
  it('inserts -c immediately after the binary', () => {
    const base = buildBaseCommand(createIpmiDevice({ ip: '10.0.0.1', username: 'u', password: 'p' }));
    const csv = withCsvFlag(base);
    expect(csv[0]).toBe(ipmitoolBin());
    expect(csv[1]).toBe('-c');
    expect(csv.slice(2)).toEqual(base.slice(1));
  });

  it('does not mutate the input array', () => {
    const base = buildBaseCommand(createIpmiDevice({ ip: '10.0.0.1', username: 'u', password: 'p' }));
    const originalLen = base.length;
    withCsvFlag(base);
    expect(base.length).toBe(originalLen);
  });
});
