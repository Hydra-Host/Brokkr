// Partial results are intentional: a failed/timed-out probe contributes nothing, so one dead sensor endpoint never zeroes out the rest of the device.

import { Injectable } from '@nestjs/common';

import type { BmcCredentials } from '../../common/bmc.types';
import { logDebug, logWarning } from '../../logger/logger.service';
import { isLocalSimulationEnabled } from '../../redfish/redfish.config';
import { buildCduScrapePlan, cduMeasurements } from '../common/cdu-scrape-plan.service';
import { KIND_CDU, KIND_SERVER } from '../common/infra-targets';

import type {
  DeviceVendorHints,
  MeasurementPoints,
  RedfishProbeClient,
  ScrapePlanDeps,
  SensorPoint,
  SensorProbe,
} from './device-sensors.types';

const APP_CLASS_NAME = 'DeviceSensorsService';

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 8.0;

export interface DeviceSensorsServiceOptions {
  concurrency?: number;
  probeTimeoutSeconds?: number;
}

export type ProbeFactory = () => RedfishProbeClient;

@Injectable()
export class DeviceSensorsService {
  private readonly vendorHints: DeviceVendorHints;
  private readonly probeFactory: ProbeFactory;
  private readonly scrapePlan: ScrapePlanDeps;
  private readonly concurrency: number;
  private readonly probeTimeoutSeconds: number;
  private readonly localSimulationEnabled: boolean;
  private lastAuthRejected = false;

  constructor(
    vendorHints: DeviceVendorHints,
    probeFactory: ProbeFactory | RedfishProbeClient,
    scrapePlan: ScrapePlanDeps,
    options: DeviceSensorsServiceOptions = {},
  ) {
    this.vendorHints = vendorHints;
    this.probeFactory = typeof probeFactory === 'function' ? probeFactory : () => probeFactory;
    this.scrapePlan = scrapePlan;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.probeTimeoutSeconds = options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
    this.localSimulationEnabled = isLocalSimulationEnabled();
  }

  get authRejected(): boolean {
    return this.lastAuthRejected;
  }

  async collect(deviceId: string, creds: BmcCredentials, kind: string = KIND_SERVER): Promise<MeasurementPoints> {
    const probe = this.probeFactory();
    probe.resetAuth();
    this.lastAuthRejected = false;

    if (this.localSimulationEnabled) {
      await logDebug('local simulation enabled: skipping BMC sensor collection', {
        appClassName: APP_CLASS_NAME,
        jobId: deviceId,
      });
      return emptyDoc(kind === KIND_CDU ? cduMeasurements().map(([name]) => name) : this.scrapePlan.allMeasurements);
    }

    let plan: SensorProbe[];
    let measurementNames: string[];
    if (kind === KIND_CDU) {
      plan = buildCduScrapePlan();
      measurementNames = cduMeasurements().map(([name]) => name);
    } else {
      const hints = await this.vendorHints.get(deviceId, creds);
      plan = this.scrapePlan.buildScrapePlan(hints);
      measurementNames = [...this.scrapePlan.allMeasurements];
    }

    const doc: MeasurementPoints = emptyDoc(measurementNames);

    const runs = plan.map((probeSpec) => this.runProbe(probe, probeSpec, deviceId, creds));
    const results = await runWithConcurrency(runs, this.concurrency);

    for (const result of results) {
      for (const [measurement, points] of Object.entries(result)) {
        if (!(measurement in doc)) {
          doc[measurement] = [];
        }
        doc[measurement].push(...points);
      }
    }

    if (kind === KIND_SERVER && !nonEmpty(doc.chassis_power_watts) && nonEmpty(doc.sensor_psu_watts)) {
      let psuTotal = 0;
      for (const point of doc.sensor_psu_watts) {
        const value = point.value;
        psuTotal += typeof value === 'number' ? value : Number(value);
      }
      doc.chassis_power_watts = [{ sensor: 'psu_sum', value: psuTotal }];
    }

    let total = 0;
    for (const points of Object.values(doc)) {
      total += points.length;
    }
    if (total === 0) {
      await logWarning(`device ${deviceId}: no sensor readings collected from ${plan.length} probes`, {
        appClassName: APP_CLASS_NAME,
        jobId: deviceId,
      });
    }
    this.lastAuthRejected = probe.authRejected;
    return doc;
  }

  private runProbe(
    probe: RedfishProbeClient,
    probeSpec: SensorProbe,
    deviceId: string,
    creds: BmcCredentials,
  ): () => Promise<MeasurementPoints> {
    return async () => {
      const controller = new AbortController();
      let body: Record<string, unknown> | null;
      try {
        body = await withTimeout(
          probe.get(creds.bmcIp, probeSpec.url, {
            username: creds.username,
            password: creds.password,
            jobId: deviceId,
            signal: controller.signal,
          }),
          this.probeTimeoutSeconds,
          controller,
        );
      } catch (error) {
        await logDebug(`sensor probe failed: ${probeSpec.url} (${errorTypeName(error)})`, {
          appClassName: APP_CLASS_NAME,
          jobId: deviceId,
        });
        return {};
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return {};
      }
      return this.scrapePlan.extractPoints(body, probeSpec);
    };
  }
}

function emptyDoc(measurementNames: readonly string[]): MeasurementPoints {
  const doc: MeasurementPoints = {};
  for (const name of measurementNames) {
    doc[name] = [];
  }
  return doc;
}

function nonEmpty(points: SensorPoint[] | undefined): points is SensorPoint[] {
  return Array.isArray(points) && points.length > 0;
}

async function runWithConcurrency<T>(tasks: ReadonlyArray<() => Promise<T>>, limit: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  const bound = Math.max(1, limit);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  for (let i = 0; i < Math.min(bound, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`probe timed out after ${seconds}s`);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, seconds: number, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      controller?.abort();
      reject(new TimeoutError(seconds));
    }, seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorTypeName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
