import { describe, expect, it } from 'vitest';

import { bmcCredentials, type BmcCredentials } from '../../../common/bmc.types';
import { cduMeasurements } from '../../common/cdu-scrape-plan.service';
import { KIND_CDU } from '../../common/infra-targets';
import { RecordedProbeClient } from '../../common/redfish-device-vendor-hints';
import { ALL_MEASUREMENTS, buildScrapePlan, extractPoints } from '../../common/scrape-plan.service';
import { DeviceSensorsService } from '../device-sensors.service';
import type { DeviceVendorHints, RedfishProbeClient, ScrapePlanDeps, VendorHints } from '../device-sensors.types';
import { GpuLayout } from '../device-sensors.types';

const CREDS: BmcCredentials = bmcCredentials('172.16.32.40', 'USERID', 'secret');

const DEFAULT_HINTS: VendorHints = {
  baselineChassisId: '1',
  baselineUrlTrailingSlash: false,
  gpuLayout: GpuLayout.NONE,
  gpuCount: 0,
  gpuSlots: [],
  gpuChassisIds: [],
};

const SCRAPE_PLAN_DEPS: ScrapePlanDeps = {
  buildScrapePlan: (h) =>
    buildScrapePlan({
      baselineChassisId: h.baselineChassisId,
      baselineUrlTrailingSlash: h.baselineUrlTrailingSlash,
      gpuLayout: h.gpuLayout as unknown as Parameters<typeof buildScrapePlan>[0]['gpuLayout'],
      gpuCount: h.gpuCount,
      gpuSlots: h.gpuSlots,
      gpuChassisIds: h.gpuChassisIds,
    }),
  extractPoints: (body, probe) => extractPoints(body, probe) as never,
  allMeasurements: ALL_MEASUREMENTS,
};

class FixedHints implements DeviceVendorHints {
  constructor(private readonly hints: VendorHints) {}
  async get(): Promise<VendorHints> {
    return this.hints;
  }
}

class ExplodingProbe implements RedfishProbeClient {
  authRejected = false;
  constructor(
    private readonly okBody: Record<string, unknown>,
    private readonly failSubstr: string,
  ) {}
  resetAuth(): void {
    this.authRejected = false;
  }
  async get(_ip: string, path: string) {
    if (path.includes(this.failSubstr)) {
      throw new Error('boom');
    }
    return this.okBody;
  }
}

class HangingProbe implements RedfishProbeClient {
  authRejected = false;
  resetAuth(): void {
    this.authRejected = false;
  }
  async get(): Promise<Record<string, unknown> | null> {
    await new Promise<void>(() => {
    });
    return {};
  }
}

class ExplodingHints implements DeviceVendorHints {
  async get(): Promise<VendorHints> {
    throw new Error('vendor hints must not be queried');
  }
}

class CountingProbe implements RedfishProbeClient {
  authRejected = false;
  getCalls = 0;
  resetAuth(): void {
    this.authRejected = false;
  }
  async get(): Promise<Record<string, unknown> | null> {
    this.getCalls += 1;
    return {};
  }
}

describe('collect — server', () => {
  it('seeds all measurements even when probes return nothing', async () => {
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), new RecordedProbeClient({}), SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    expect(Object.keys(doc).sort()).toEqual([...ALL_MEASUREMENTS].sort());
    for (const v of Object.values(doc)) expect(v).toEqual([]);
  });

  it('merges thermal and power readings', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/Chassis/1/Thermal': {
        Temperatures: [{ Name: 'Inlet', ReadingCelsius: 20 }],
        Fans: [{ Name: 'F1', Reading: 3000 }],
      },
      '/redfish/v1/Chassis/1/Power': {
        PowerControl: [{ Name: 'Sys', PowerConsumedWatts: 410 }],
      },
    });
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    expect(doc['sensor_temperature_celsius']).toEqual([{ sensor: 'Inlet', value: 20.0 }]);
    expect(doc['sensor_fan_rpm']).toEqual([{ sensor: 'F1', value: 3000.0 }]);
    expect(doc['chassis_power_watts']).toEqual([{ sensor: 'Sys', value: 410.0 }]);
  });

  it('merges per-gpu points into one array', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/Chassis/1/Sensors/GPU1_Temp': { Reading: 40 },
      '/redfish/v1/Chassis/1/Sensors/GPU2_Temp': { Reading: 42 },
      '/redfish/v1/Chassis/1/Sensors/GPU1_Power': { Reading: 300 },
      '/redfish/v1/Chassis/1/Sensors/GPU2_Power': { Reading: 310 },
    });
    const hints: VendorHints = { ...DEFAULT_HINTS, gpuLayout: GpuLayout.LENOVO_XCC, gpuCount: 2 };
    const svc = new DeviceSensorsService(new FixedHints(hints), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    const temps = [...(doc['gpu_temperature_celsius'] ?? [])].sort((a, b) =>
      String(a['gpu_index']).localeCompare(String(b['gpu_index'])),
    );
    expect(temps).toEqual([
      { gpu_index: '0', value: 40.0 },
      { gpu_index: '1', value: 42.0 },
    ]);
    expect(doc['gpu_power_watts'].length).toBe(2);
  });

  it('chassis_power_watts psu_sum fallback', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/Chassis/1/Power': {
        PowerControl: [],
        PowerSupplies: [
          { Name: 'PSU1', LastPowerOutputWatts: 300 },
          { Name: 'PSU2', LastPowerOutputWatts: 310 },
        ],
      },
    });
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    expect(doc['chassis_power_watts']).toEqual([{ sensor: 'psu_sum', value: 610.0 }]);
    expect(doc['sensor_psu_watts'].length).toBe(2);
  });

  it('direct chassis power wins over psu_sum', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/Chassis/1/Power': {
        PowerControl: [{ Name: 'System', PowerConsumedWatts: 410 }],
        PowerSupplies: [{ Name: 'PSU1', LastPowerOutputWatts: 300 }],
      },
    });
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    expect(doc['chassis_power_watts']).toEqual([{ sensor: 'System', value: 410.0 }]);
  });

  it('auth rejection surfaces flag and yields empty doc', async () => {
    const probe = new RecordedProbeClient({}, { rejectAuthForPassword: 'stale' });
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', bmcCredentials('10.0.0.1', 'u', 'stale'));
    expect(svc.authRejected).toBe(true);
    for (const v of Object.values(doc)) expect(v).toEqual([]);
  });

  it('auth flag is reset each collect', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/Chassis/1/Power': {
        PowerControl: [{ Name: 'Sys', PowerConsumedWatts: 100 }],
      },
    });
    probe.authRejected = true;
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    await svc.collect('42', CREDS);
    expect(svc.authRejected).toBe(false);
  });

  it('failing probe yields partial results', async () => {
    const probe = new ExplodingProbe({ Temperatures: [{ Name: 'Inlet', ReadingCelsius: 20 }] }, '/Power');
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('42', CREDS);
    expect(doc['sensor_temperature_celsius']).toEqual([{ sensor: 'Inlet', value: 20.0 }]);
    expect(doc['sensor_voltage_volts']).toEqual([]);
  });

  it('skips all probing when local simulation is enabled, returning a shape-preserving empty doc', async () => {
    const prev = process.env.LOCAL_SIMULATION_ENABLED;
    process.env.LOCAL_SIMULATION_ENABLED = 'true';
    try {
      const probe = new CountingProbe();
      const svc = new DeviceSensorsService(new ExplodingHints(), probe, SCRAPE_PLAN_DEPS);
      const doc = await svc.collect('42', CREDS);
      expect(probe.getCalls).toBe(0);
      expect(Object.keys(doc).sort()).toEqual([...ALL_MEASUREMENTS].sort());
      for (const v of Object.values(doc)) expect(v).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.LOCAL_SIMULATION_ENABLED;
      else process.env.LOCAL_SIMULATION_ENABLED = prev;
    }
  });

  it('hanging probe times out to empty doc', async () => {
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), new HangingProbe(), SCRAPE_PLAN_DEPS, {
      probeTimeoutSeconds: 0.05,
    });
    const doc = await svc.collect('42', CREDS);
    expect(Object.keys(doc).sort()).toEqual([...ALL_MEASUREMENTS].sort());
    for (const v of Object.values(doc)) expect(v).toEqual([]);
  });
});

describe('collect — concurrency', () => {
  it('does not cross-contaminate authRejected across concurrent collects', async () => {
    const created: TogglingProbe[] = [];
    const factory = (): TogglingProbe => {
      const p = new TogglingProbe();
      created.push(p);
      return p;
    };
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), factory, SCRAPE_PLAN_DEPS);

    const rejectingCreds = bmcCredentials('10.0.0.1', 'u', 'stale');
    const okCreds = bmcCredentials('10.0.0.2', 'u', 'good');

    const calls: Promise<void>[] = [];
    const rejectFlags: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const creds = i % 2 === 0 ? rejectingCreds : okCreds;
      calls.push(
        svc.collect(`dev-${i}`, creds).then(() => {
          rejectFlags.push(svc.authRejected);
        }),
      );
    }
    await Promise.all(calls);

    expect(created.length).toBe(10);
    const probeSet = new Set(created);
    expect(probeSet.size).toBe(10);
  });

  it('a fresh probe is built per collect even when invoked sequentially', async () => {
    const created: RedfishProbeClient[] = [];
    const factory = (): RedfishProbeClient => {
      const p = new RecordedProbeClient({});
      created.push(p);
      return p;
    };
    const svc = new DeviceSensorsService(new FixedHints(DEFAULT_HINTS), factory, SCRAPE_PLAN_DEPS);
    await svc.collect('a', CREDS);
    await svc.collect('b', CREDS);
    await svc.collect('c', CREDS);
    expect(created.length).toBe(3);
  });
});

class TogglingProbe implements RedfishProbeClient {
  authRejected = false;
  resetAuth(): void {
    this.authRejected = false;
  }
  async get(
    _ip: string,
    _path: string,
    opts: { username: string; password: string; jobId?: string; signal?: AbortSignal },
  ): Promise<Record<string, unknown> | null> {
    await new Promise((r) => setTimeout(r, 0));
    if (opts.password === 'stale') {
      this.authRejected = true;
      return null;
    }
    return {};
  }
}

describe('collect — CDU', () => {
  it('uses CDU plan without discovery and seeds CDU catalog', async () => {
    const probe = new RecordedProbeClient({
      '/redfish/v1/ThermalEquipment/CDUs/1/PrimaryCoolantConnectors/1': {
        SupplyTemperatureCelsius: { Reading: 32.5 },
        FlowLitersPerMinute: { Reading: 120.0 },
      },
      '/redfish/v1/ThermalEquipment/CDUs/1/LeakDetection/LeakDetectors?$expand=*($levels=1)': {
        Members: [
          { Id: '1', DetectorState: 'OK' },
          { Id: '2', DetectorState: 'CriticalFlow' },
        ],
      },
    });
    const svc = new DeviceSensorsService(new ExplodingHints(), probe, SCRAPE_PLAN_DEPS);
    const doc = await svc.collect('cdu-1', CREDS, KIND_CDU);
    expect(Object.keys(doc).sort()).toEqual(
      cduMeasurements()
        .map(([n]) => n)
        .sort(),
    );
    expect('sensor_temperature_celsius' in doc).toBe(false);
    expect(doc['cdu_primary_supply_temp_celsius']).toEqual([{ value: 32.5 }]);
    const leaks = Object.fromEntries((doc['cdu_leak_detector_ok'] ?? []).map((p) => [p['detector'], p['value']]));
    expect(leaks).toEqual({ '1': 1.0, '2': 0.0 });
    expect(doc['cdu_pump_speed_percent']).toEqual([]);
  });
});
