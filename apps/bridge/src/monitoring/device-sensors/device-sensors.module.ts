import { Module, Scope } from '@nestjs/common';

import { logWarning } from '../../core/logging/bridge-logger';
import { RedfishBaseHandler, RedfishDevice } from '../../redfish/index.js';
import { CachingDeviceVendorHints } from '../common/device-vendor-hints';
import { RedfishDeviceVendorHints } from '../common/redfish-device-vendor-hints';
import {
  ALL_MEASUREMENTS,
  buildScrapePlan as buildScrapePlanFn,
  extractPoints as extractPointsFn,
  type MeasurementPoints as ScrapePlanMeasurementPoints,
  type SensorProbe as ScrapePlanSensorProbe,
  type VendorHints as ScrapePlanVendorHints,
} from '../common/scrape-plan.service';

import { DeviceSensorsController } from './device-sensors.controller';
import { DeviceSensorsService } from './device-sensors.service';
import type {
  DeviceVendorHints,
  MeasurementPoints,
  RedfishProbeClient,
  ScrapePlanDeps,
  SensorProbe,
  VendorHints,
} from './device-sensors.types';

const APP_CLASS_NAME = 'redfish-handler-probe-client';
const AUTH_REJECTED_STATUSES = new Set([401, 403]);

class RedfishHandlerProbeClient implements RedfishProbeClient {
  authRejected = false;

  resetAuth(): void {
    this.authRejected = false;
  }

  async get(
    bmcIp: string,
    path: string,
    opts: { username: string; password: string; jobId?: string; signal?: AbortSignal },
  ): Promise<Record<string, unknown> | null> {
    const jobId = opts.jobId ?? '';
    const device = new RedfishDevice(jobId, '', bmcIp, opts.username, opts.password);
    const handler = new RedfishBaseHandler(device, jobId);

    let body: Record<string, unknown>;
    try {
      body = await handler.fetch('GET', path, {});
    } catch (error) {
      logWarning(`redfish probe error: ${path}: ${error instanceof Error ? error.message : String(error)}`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
      return null;
    }

    const last = device.callStack[device.callStack.length - 1];
    if (last !== undefined && last.status !== null && AUTH_REJECTED_STATUSES.has(last.status)) {
      this.authRejected = true;
    }
    device.callStack.pop();

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null;
    }
    if (Object.keys(body).length === 0) {
      return null;
    }
    if ('error' in body || 'xml' in body || 'unknown' in body) {
      return null;
    }
    return body;
  }
}

let vendorHintsSingleton: CachingDeviceVendorHints | null = null;
function getDeviceVendorHints(probe: RedfishProbeClient): CachingDeviceVendorHints {
  if (vendorHintsSingleton === null) {
    vendorHintsSingleton = new CachingDeviceVendorHints(
      new RedfishDeviceVendorHints(probe as unknown as ConstructorParameters<typeof RedfishDeviceVendorHints>[0]),
    );
  }
  return vendorHintsSingleton;
}

function buildScrapePlanDeps(): ScrapePlanDeps {
  return {
    buildScrapePlan(hints: VendorHints): SensorProbe[] {
      const plan = buildScrapePlanFn(hints as unknown as ScrapePlanVendorHints);
      return plan as unknown as SensorProbe[];
    },
    extractPoints(body, probe): MeasurementPoints {
      const result: ScrapePlanMeasurementPoints = extractPointsFn(body, probe as unknown as ScrapePlanSensorProbe);
      return result as unknown as MeasurementPoints;
    },
    allMeasurements: ALL_MEASUREMENTS,
  };
}

function buildDeviceSensorsService(): DeviceSensorsService {
  const hintsProbe = new RedfishHandlerProbeClient();
  const vendorHints = getDeviceVendorHints(hintsProbe) as unknown as DeviceVendorHints;
  const scrapePlan = buildScrapePlanDeps();
  // Fresh probe per collect() so authRejected state doesn't leak across concurrent calls.
  return new DeviceSensorsService(vendorHints, () => new RedfishHandlerProbeClient(), scrapePlan);
}

@Module({
  controllers: [DeviceSensorsController],
  providers: [
    {
      provide: DeviceSensorsService,
      useFactory: buildDeviceSensorsService,
      scope: Scope.REQUEST,
    },
  ],
  exports: [DeviceSensorsService],
})
export class DeviceSensorsModule {}
