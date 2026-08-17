import { describe, expect, it } from 'vitest';

import { getStep, requireUbuntuOnBareMetal } from './steps';

describe('provision step parseParams', () => {
  it('rejects an unknown param key (strict)', () => {
    expect(() => getStep('provision').parseParams({ bogus: 1 })).toThrow();
  });

  it('applies the deploymentName default on empty/undefined raw', () => {
    expect(getStep('provision').parseParams(undefined)).toMatchObject({
      kind: 'provision',
      deploymentName: 'e2e-plan',
    });
    expect(getStep('provision').parseParams({})).toMatchObject({ deploymentName: 'e2e-plan' });
    expect(getStep('reprovision').parseParams(undefined)).toMatchObject({
      kind: 'reprovision',
      deploymentName: 'e2e-plan-reprov',
    });
  });

  it('rejects an explicit empty deploymentName', () => {
    expect(() => getStep('provision').parseParams({ deploymentName: '' })).toThrow();
  });

  it('accepts a picker-built diskLayout with a label', () => {
    expect(
      getStep('provision').parseParams({
        diskLayout: { label: 'raid1 os', os: { group: 'os', config: 'raid1' }, data: [] },
      }),
    ).toMatchObject({ diskLayout: { label: 'raid1 os' } });
  });

  it('rejects malformed customizations', () => {
    expect(() => getStep('provision').parseParams({ customizations: { a: 42 } })).toThrow();
  });

  it('round-trips valid params', () => {
    expect(
      getStep('provision').parseParams({
        deploymentName: 'custom',
        osSlug: 'ubuntu-24.04',
        customizations: { gpuDriver: 'nvidia-driver-550', misc: ['docker'] },
      }),
    ).toMatchObject({
      kind: 'provision',
      deploymentName: 'custom',
      osSlug: 'ubuntu-24.04',
      customizations: { gpuDriver: 'nvidia-driver-550', misc: ['docker'] },
    });
  });
});

describe('requireUbuntuOnBareMetal', () => {
  it('rejects a non-ubuntu base in baremetal mode', () => {
    expect(() => requireUbuntuOnBareMetal('baremetal', 'debian-12', 'provision')).toThrow(/ubuntu-\* base/);
  });

  it('accepts an ubuntu base in baremetal mode', () => {
    expect(() => requireUbuntuOnBareMetal('baremetal', 'ubuntu-24.04', 'provision')).not.toThrow();
  });

  it('leaves vm mode unconstrained', () => {
    expect(() => requireUbuntuOnBareMetal('vm', 'debian-12', 'reprovision')).not.toThrow();
  });
});

describe('provision-ipxe-custom on bare metal', () => {
  it('refuses to run before issuing any hub call', async () => {
    const hubAdmin = {
      provision: () => {
        throw new Error('hub must not be called');
      },
    };
    const ctx = { fleet: { mode: 'baremetal' }, hubAdmin, deviceId: 'd', hubDb: {} };
    await expect(getStep('provision-ipxe-custom').exec(ctx as never, undefined)).rejects.toThrow(
      /refusing to run provision-ipxe-custom/,
    );
  });

  it('does not gate vm mode', async () => {
    const ctx = { fleet: { mode: 'vm' }, hubAdmin: {}, deviceId: 'd', hubDb: {} };
    const err = await getStep('provision-ipxe-custom')
      .exec(ctx as never, undefined)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/refusing to run provision-ipxe-custom/);
  });
});
