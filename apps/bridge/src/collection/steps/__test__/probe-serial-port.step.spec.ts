import { afterEach, describe, expect, it, vi } from 'vitest';

import { bmcCredentials, type BmcCredentials } from '../../../common/bmc.types';
import {
  configureDeviceCredentialResolver,
  DeviceCredentialResolver,
  resetDeviceCredentialResolverForTests,
} from '../../../monitoring/common/device-credential-resolver.service';
import type { SagaContext } from '../../../saga-framework/saga.types';
import { ProbeSerialPortStep } from '../probe-serial-port.step';

function makeLogger() {
  return {
    info: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
  };
}

function makeResults() {
  return {
    mergeResolvedIntoSerialPorts: vi.fn(async () => true),
    enqueueDiscoveryComplete: vi.fn(async () => true),
  };
}

function makeCtx(stepResults: Record<string, unknown> = { collect_hardware: { collected: true } }): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'probe_serial_port',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults,
  };
}

function withCreds(creds: BmcCredentials | null): void {
  configureDeviceCredentialResolver(() => new DeviceCredentialResolver({ get: async () => creds }));
}

afterEach(() => {
  resetDeviceCredentialResolverForTests();
  vi.restoreAllMocks();
});

describe('ProbeSerialPortStep.execute', () => {
  it('(a) skips the probe and discovery.complete when collection did not run', async () => {
    withCreds(bmcCredentials('10.0.0.1', 'admin', 'secret'));
    const probe = vi.fn();
    const results = makeResults();
    const step = new ProbeSerialPortStep({ create: async () => ({ probe }) }, results, makeLogger());

    const result = await step.execute(makeCtx({ collect_hardware: { collected: false } }));

    expect(result).toEqual({ probed: false, reason: 'collection did not run' });
    expect(probe).not.toHaveBeenCalled();
    expect(results.mergeResolvedIntoSerialPorts).not.toHaveBeenCalled();
    expect(results.enqueueDiscoveryComplete).not.toHaveBeenCalled();
  });

  it('(b) merges a confirmed probe result and enqueues discovery.complete', async () => {
    withCreds(bmcCredentials('10.0.0.1', 'admin', 'secret'));
    const probe = vi.fn(async () => ({
      port: '/dev/ttyS1',
      baud: 115200,
      source: 'sol_probe',
      confirmed: true,
      notes: ['matched token'],
    }));
    const results = makeResults();
    const step = new ProbeSerialPortStep({ create: async () => ({ probe }) }, results, makeLogger());

    const result = await step.execute(makeCtx());

    expect(probe).toHaveBeenCalledWith({
      deviceId: 'device-1',
      bmcIp: '10.0.0.1',
      bmcUsername: 'admin',
      bmcPassword: 'secret',
    });
    expect(results.mergeResolvedIntoSerialPorts).toHaveBeenCalledWith('device-1', {
      port: '/dev/ttyS1',
      source: 'probed',
      confirmed: true,
      notes: ['matched token'],
      baud: 115200,
    });
    expect(results.enqueueDiscoveryComplete).toHaveBeenCalledWith({ deviceId: 'device-1', jobId: 'job-1' });
    expect(result).toEqual({ probed: true, confirmed: true, port: '/dev/ttyS1', source: 'probed' });
  });

  it('omits baud from the merge patch when the probe did not return a numeric baud', async () => {
    withCreds(bmcCredentials('10.0.0.1', 'admin', 'secret'));
    const probe = vi.fn(async () => ({
      port: '/dev/ttyS1',
      baud: null,
      source: 'sol_probe',
      confirmed: true,
      notes: [],
    }));
    const results = makeResults();
    const step = new ProbeSerialPortStep({ create: async () => ({ probe }) }, results, makeLogger());

    await step.execute(makeCtx());

    expect(results.mergeResolvedIntoSerialPorts).toHaveBeenCalledWith('device-1', {
      port: '/dev/ttyS1',
      source: 'probed',
      confirmed: true,
      notes: [],
    });
  });

  it('does not merge when the probe returns an unconfirmed result', async () => {
    withCreds(bmcCredentials('10.0.0.1', 'admin', 'secret'));
    const probe = vi.fn(async () => ({
      port: '/dev/ttyS1',
      baud: 115200,
      source: 'modem_hint',
      confirmed: false,
      notes: [],
    }));
    const results = makeResults();
    const step = new ProbeSerialPortStep({ create: async () => ({ probe }) }, results, makeLogger());

    const result = await step.execute(makeCtx());

    expect(results.mergeResolvedIntoSerialPorts).not.toHaveBeenCalled();
    expect(results.enqueueDiscoveryComplete).toHaveBeenCalledWith({ deviceId: 'device-1', jobId: 'job-1' });
    expect(result).toEqual({ probed: true, confirmed: false, port: null, source: 'none' });
  });

  it('(c) skips the merge but still enqueues discovery.complete when no creds resolve', async () => {
    withCreds(null);
    const create = vi.fn();
    const results = makeResults();
    const step = new ProbeSerialPortStep({ create }, results, makeLogger());

    const result = await step.execute(makeCtx());

    expect(create).not.toHaveBeenCalled();
    expect(results.mergeResolvedIntoSerialPorts).not.toHaveBeenCalled();
    expect(results.enqueueDiscoveryComplete).toHaveBeenCalledWith({ deviceId: 'device-1', jobId: 'job-1' });
    expect(result).toEqual({ probed: true, confirmed: false, port: null, source: 'none' });
  });

  it('(d) fail-soft: a throwing probe still enqueues discovery.complete', async () => {
    withCreds(bmcCredentials('10.0.0.1', 'admin', 'secret'));
    const probe = vi.fn(async () => {
      throw new Error('boom');
    });
    const results = makeResults();
    const logger = makeLogger();
    const step = new ProbeSerialPortStep({ create: async () => ({ probe }) }, results, logger);

    const result = await step.execute(makeCtx());

    expect(results.mergeResolvedIntoSerialPorts).not.toHaveBeenCalled();
    expect(results.enqueueDiscoveryComplete).toHaveBeenCalledWith({ deviceId: 'device-1', jobId: 'job-1' });
    expect(logger.warning).toHaveBeenCalled();
    expect(result).toEqual({ probed: true, confirmed: false, port: null, source: 'none' });
  });
});
