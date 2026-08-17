import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedfishHttpResponse, RedfishRequestParams } from '../vendor/base/base.js';
import { RedfishDevice } from '../vendor/base/base.js';
import { RedfishDellHandler } from '../vendor/dell/dell.js';

delete process.env.BROKKR_ENV;
delete process.env.HH_ENV;
delete process.env.ENVIRONMENT;

function jsonResponse(body: unknown): RedfishHttpResponse {
  return { status: 200, text: JSON.stringify(body), headers: {} };
}

type RequesterMock = Mock<(params: RedfishRequestParams) => Promise<RedfishHttpResponse>>;

function makeHandler(): { handler: RedfishDellHandler; requester: RequesterMock } {
  const device = new RedfishDevice('job-1', 'dev-1', '10.0.0.5', 'root', 'calvin');
  device.rebootTimeout = 0;
  device.jobserviceEndpoint = '/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs';
  device.systemEndpoint = '/redfish/v1/Systems/System.Embedded.1';
  device.rebootEndpoint = '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset';
  device.biosPatchEndpoint = '/redfish/v1/Systems/System.Embedded.1/Bios/Settings';
  device.dellLcServiceEndpoint = '';
  const requester = vi.fn<(params: RedfishRequestParams) => Promise<RedfishHttpResponse>>();
  return { handler: new RedfishDellHandler(device, 'job-1', requester), requester };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitForBiosJobTerminal', () => {
  it('polls the job URI until it reaches Completed', async () => {
    const { handler, requester } = makeHandler();
    requester
      .mockResolvedValueOnce(jsonResponse({ JobState: 'Running', PercentComplete: 50 }))
      .mockResolvedValueOnce(jsonResponse({ JobState: 'Running', PercentComplete: 80 }))
      .mockResolvedValueOnce(jsonResponse({ JobState: 'Completed', PercentComplete: 100 }));

    const outcome = await handler.waitForBiosJobTerminal('/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs/JID_1');

    expect(outcome).toBe('completed');
    expect(requester).toHaveBeenCalledTimes(3);
    for (const call of requester.mock.calls) {
      expect(call[0]?.url).toBe('https://10.0.0.5:443/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs/JID_1');
    }
  });

  it('returns failed on a terminal failure state', async () => {
    const { handler, requester } = makeHandler();
    requester.mockResolvedValueOnce(jsonResponse({ JobState: 'Failed', PercentComplete: 10, Message: 'boom' }));

    const outcome = await handler.waitForBiosJobTerminal('/jobs/JID_2');

    expect(outcome).toBe('failed');
  });
});

describe('createBiosConfigJob', () => {
  it('diffs the job list to resolve the new BIOSConfiguration job URI', async () => {
    const { handler, requester } = makeHandler();
    const preexisting = { '@odata.id': '/jobs/JID_1', JobType: 'BIOSConfiguration', StartTime: '2024-01-01T00:00:00' };
    const created = { '@odata.id': '/jobs/JID_2', JobType: 'BIOSConfiguration', StartTime: '2024-01-02T00:00:00' };
    requester
      .mockResolvedValueOnce(jsonResponse({ Members: [preexisting] }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ Members: [preexisting, created] }));

    const [accepted, jobUrl] = await handler.createBiosConfigJob();

    expect(accepted).toBe(true);
    expect(jobUrl).toBe('/jobs/JID_2');
    const postParams = requester.mock.calls[1]?.[0];
    expect(postParams?.method).toBe('POST');
    expect(postParams?.body).toBe(
      JSON.stringify({
        JobType: 'BIOSConfiguration',
        TargetSettingsURI: '/redfish/v1/Systems/System.Embedded.1/Bios/Settings',
        RebootJobType: 'PowerCycle',
      }),
    );
  });

  it('reports not-accepted when the POST returns an error envelope', async () => {
    const { handler, requester } = makeHandler();
    requester
      .mockResolvedValueOnce(jsonResponse({ Members: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: { '@Message.ExtendedInfo': [{ Message: 'job already queued' }] } }));

    const [accepted, jobUrl] = await handler.createBiosConfigJob();

    expect(accepted).toBe(false);
    expect(jobUrl).toBe('');
  });
});

describe('runBiosConfigLifecycle', () => {
  it('issues a plain reboot when no BIOS settings are pending and clears rebootNeeded once the host is back', async () => {
    const { handler, requester } = makeHandler();
    handler.device.rebootNeeded = true;
    requester
      .mockResolvedValueOnce(jsonResponse({ LastResetTime: '2024-01-01T00:00:00+00:00' }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          BootProgress: { LastState: 'SystemHardwareInitializationComplete' },
          Status: { Health: 'OK' },
          LastResetTime: '2024-01-01T00:30:00+00:00',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          BootProgress: { LastState: 'OSRunning' },
          Status: { Health: 'OK' },
          LastResetTime: '2024-01-01T01:00:00+00:00',
        }),
      );

    await handler.runBiosConfigLifecycle();

    expect(handler.device.rebootNeeded).toBe(false);
    const postParams = requester.mock.calls[1]?.[0];
    expect(postParams?.method).toBe('POST');
    expect(postParams?.body).toBe(JSON.stringify({ ResetType: 'GracefulRestart' }));
  });
});

describe('parseIso', () => {
  it('parses ISO timestamps with offsets and Z suffixes', () => {
    const withOffset = RedfishDellHandler.parseIso('2024-01-01T00:00:00+00:00');
    const withZ = RedfishDellHandler.parseIso('2024-01-01T00:00:00Z');
    expect(withOffset).not.toBeNull();
    expect(withOffset).toBe(withZ);
  });

  it('returns null for empty or malformed values', () => {
    expect(RedfishDellHandler.parseIso(null)).toBeNull();
    expect(RedfishDellHandler.parseIso('')).toBeNull();
    expect(RedfishDellHandler.parseIso('not-a-date')).toBeNull();
  });
});
