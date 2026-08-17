import { describe, expect, it } from 'vitest';

import {
  ALL_MEASUREMENTS,
  DEFAULT_VENDOR_HINTS,
  GpuLayout,
  buildScrapePlan,
  extractPoints,
  type SensorProbe,
  type VendorHints,
} from '../scrape-plan.service';

function hints(partial: Partial<VendorHints> = {}): VendorHints {
  return { ...DEFAULT_VENDOR_HINTS, ...partial };
}

function urls(plan: SensorProbe[]): string[] {
  return plan.map((p) => p.url);
}

describe('baseline scrape plan', () => {
  it('default hints emit only thermal and power', () => {
    expect(urls(buildScrapePlan(hints()))).toEqual(['/redfish/v1/Chassis/1/Thermal', '/redfish/v1/Chassis/1/Power']);
  });

  it('chassis id and trailing slash apply to both baseline urls', () => {
    const plan = buildScrapePlan(hints({ baselineChassisId: 'System.Embedded.1', baselineUrlTrailingSlash: true }));
    expect(plan[0].url).toBe('/redfish/v1/Chassis/System.Embedded.1/Thermal/');
    expect(plan[1].url).toBe('/redfish/v1/Chassis/System.Embedded.1/Power/');
  });

  it('thermal and power extract measurements are as documented', () => {
    const plan = buildScrapePlan(hints());
    const thermal = new Set(plan[0].extracts.map((e) => e.measurement));
    const power = new Set(plan[1].extracts.map((e) => e.measurement));
    expect(thermal).toEqual(new Set(['sensor_temperature_celsius', 'sensor_fan_rpm', 'sensor_fan_percent']));
    expect(power).toEqual(new Set(['sensor_voltage_volts', 'sensor_psu_watts', 'chassis_power_watts']));
  });

  it('fan and psu carry firmware variant candidates', () => {
    const plan = buildScrapePlan(hints());
    const thermalPaths = new Set(plan[0].extracts.map((e) => `${e.measurement}|${e.valuePath}|${e.nameKey}`));
    expect(thermalPaths.has('sensor_fan_rpm|Reading|Name')).toBe(true);
    expect(thermalPaths.has('sensor_fan_percent|CurrentReading|FanName')).toBe(true);
    const psuPaths = plan[1].extracts.filter((e) => e.measurement === 'sensor_psu_watts').map((e) => e.valuePath);
    expect(psuPaths).toContain('PowerOutputWatts');
    expect(psuPaths).toContain('LastPowerOutputWatts');
  });
});

describe('vendor layouts', () => {
  it('Cisco emits three probes per gpu with zero-based gpu_index', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.CISCO_CBMC, gpuCount: 2 }));
    const gpu = plan.filter((p) => p.url.includes('/Chassis/GPU_'));
    expect(gpu.length).toBe(6);
    const first = gpu.filter((p) => p.url.includes('GPU_1/'));
    expect(first.every((p) => p.tags['gpu_index'] === '0')).toBe(true);
    expect(first.some((p) => p.url.endsWith('/temperature_GPU_1_Temp_0'))).toBe(true);
    expect(first.some((p) => p.url.endsWith('/temperature_GPU_1_DRAM_0_Temp_0'))).toBe(true);
    expect(first.some((p) => p.url.endsWith('/power_GPU_1_Power_0'))).toBe(true);
  });

  it('NVIDIA HGX emits four probes per chassis id', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.NVIDIA_HGX, gpuChassisIds: ['HGX_GPU_0', 'HGX_GPU_1'] }));
    const gpu = plan.filter((p) => p.url.includes('/Sensors/HGX_GPU_'));
    expect(gpu.length).toBe(8);
    const measurements = new Set(gpu.flatMap((p) => p.extracts.map((e) => e.measurement)));
    expect(measurements).toEqual(
      new Set([
        'gpu_temperature_celsius',
        'gpu_memory_temperature_celsius',
        'gpu_power_watts',
        'gpu_memory_power_watts',
      ]),
    );
  });

  it('NVIDIA HGX chassis id appears in both path segments', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.NVIDIA_HGX, gpuChassisIds: ['HGX_GPU_SXM_1'] }));
    expect(plan.some((p) => p.url === '/redfish/v1/Chassis/HGX_GPU_SXM_1/Sensors/HGX_GPU_SXM_1_TEMP_0')).toBe(true);
  });

  it('Supermicro ASPEED keyed by slot with positional gpu_index, no power probe', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.SUPERMICRO_ASPEED, gpuSlots: [2, 5] }));
    const gpu = plan.filter((p) => p.url.includes('/Sensors/GPU') && p.url.includes('Temp'));
    expect(urls(gpu)).toEqual(['/redfish/v1/Chassis/1/Sensors/GPU2Temp', '/redfish/v1/Chassis/1/Sensors/GPU5Temp']);
    expect(gpu[0].tags['gpu_index']).toBe('0');
    expect(gpu[1].tags['gpu_index']).toBe('1');
    expect(gpu.flatMap((p) => p.extracts.map((e) => e.measurement))).not.toContain('gpu_power_watts');
  });

  it('Dell iDRAC9: single array probe with two extracts and milliwatt scale', () => {
    const plan = buildScrapePlan(
      hints({
        baselineChassisId: 'System.Embedded.1',
        gpuLayout: GpuLayout.DELL_IDRAC9,
        gpuCount: 8,
      }),
    );
    const dell = plan.filter((p) => p.url.includes('DellGPUSensors'));
    expect(dell.length).toBe(1);
    const byMeasurement = Object.fromEntries(dell[0].extracts.map((e) => [e.measurement, e]));
    expect(byMeasurement['gpu_temperature_celsius'].array).toBe('Members');
    expect(byMeasurement['gpu_temperature_celsius'].nameTag).toBe('gpu_index');
    expect(byMeasurement['gpu_temperature_celsius'].rankNumericTag).toBe(true);
    expect(byMeasurement['gpu_power_watts'].scale).toBe(0.001);
  });

  it('Lenovo XCC: temp/power pair per GPU', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.LENOVO_XCC, gpuCount: 3 }));
    const gpu = plan.filter((p) => p.url.includes('/Sensors/GPU'));
    expect(gpu.length).toBe(6);
    expect(gpu.some((p) => p.url.endsWith('/GPU1_Temp') && p.tags['gpu_index'] === '0')).toBe(true);
    expect(gpu.some((p) => p.url.endsWith('/GPU3_Power') && p.tags['gpu_index'] === '2')).toBe(true);
  });

  it('GraphicsController: one probe per GPU carries both layout candidates', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.GRAPHICS_CONTROLLER, gpuCount: 3 }));
    const gpu = plan.filter((p) => p.url.includes('GraphicsControllers'));
    expect(urls(gpu)).toEqual([
      '/redfish/v1/Systems/1/GraphicsControllers/GPU0',
      '/redfish/v1/Systems/1/GraphicsControllers/GPU1',
      '/redfish/v1/Systems/1/GraphicsControllers/GPU2',
    ]);
    expect(gpu.map((p) => p.tags['gpu_index'])).toEqual(['0', '1', '2']);
    const paths = new Set(gpu[0].extracts.map((e) => e.valuePath));
    expect(paths).toEqual(
      new Set(['Oem.Public.Temperature', 'Oem.Temperature', 'Oem.Public.PowerWatts', 'PowerWatts']),
    );
  });
});

describe('extractPoints', () => {
  const baseline = buildScrapePlan(hints());

  it('array extract drops nulls and non-dicts', () => {
    const body = {
      Temperatures: [{ Name: 'Inlet', ReadingCelsius: 21 }, { Name: 'CPU1', ReadingCelsius: null }, 'junk'],
      Fans: [],
    };
    const out = extractPoints(body, baseline[0]);
    expect(out['sensor_temperature_celsius']).toEqual([{ sensor: 'Inlet', value: 21.0 }]);
    expect(out['sensor_fan_rpm']).toBeUndefined();
  });

  it('missing array key is skipped', () => {
    const out = extractPoints({ Temperatures: [{ Name: 'A', ReadingCelsius: 1 }] }, baseline[0]);
    expect(Object.keys(out)).toEqual(['sensor_temperature_celsius']);
  });

  it('modern graphics-controller body yields one point per measurement', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.GRAPHICS_CONTROLLER, gpuCount: 1 }));
    const gpu = plan.find((p) => p.url.includes('GraphicsControllers'))!;
    const out = extractPoints({ Oem: { Public: { Temperature: 55, PowerWatts: 300 } } }, gpu);
    expect(out['gpu_temperature_celsius']).toEqual([{ gpu_index: '0', value: 55.0 }]);
    expect(out['gpu_power_watts']).toEqual([{ gpu_index: '0', value: 300.0 }]);
  });

  it('legacy graphics-controller body yields one point per measurement', () => {
    const plan = buildScrapePlan(hints({ gpuLayout: GpuLayout.GRAPHICS_CONTROLLER, gpuCount: 1 }));
    const gpu = plan.find((p) => p.url.includes('GraphicsControllers'))!;
    const out = extractPoints({ PowerWatts: '275.5', Oem: { Temperature: 50 } }, gpu);
    expect(out['gpu_temperature_celsius']).toEqual([{ gpu_index: '0', value: 50.0 }]);
    expect(out['gpu_power_watts']).toEqual([{ gpu_index: '0', value: 275.5 }]);
  });

  it('Dell milliwatt scale applied', () => {
    const plan = buildScrapePlan(
      hints({
        baselineChassisId: 'System.Embedded.1',
        gpuLayout: GpuLayout.DELL_IDRAC9,
        gpuCount: 1,
      }),
    );
    const dell = plan.find((p) => p.url.includes('DellGPUSensors'))!;
    const body = {
      Members: [{ DeviceID: 'Video.Slot.21-1', PrimaryGPUTemperatureCelsius: 45, PowerConsumptionmW: 48000 }],
    };
    const out = extractPoints(body, dell);
    expect(out['gpu_power_watts']).toEqual([{ gpu_index: '0', value: 48.0 }]);
  });

  it('Dell gpu_index ranked by physical slot', () => {
    const plan = buildScrapePlan(
      hints({
        baselineChassisId: 'System.Embedded.1',
        gpuLayout: GpuLayout.DELL_IDRAC9,
        gpuCount: 3,
      }),
    );
    const dell = plan.find((p) => p.url.includes('DellGPUSensors'))!;
    const body = {
      Members: [
        { DeviceID: 'Video.Slot.28-1', PrimaryGPUTemperatureCelsius: 50 },
        { DeviceID: 'Video.Slot.23-1', PrimaryGPUTemperatureCelsius: 51 },
        { DeviceID: 'Video.Slot.25-1', PrimaryGPUTemperatureCelsius: 52 },
      ],
    };
    const out = extractPoints(body, dell);
    const byIndex = Object.fromEntries((out['gpu_temperature_celsius'] ?? []).map((p) => [p['gpu_index'], p['value']]));
    expect(byIndex).toEqual({ '0': 51.0, '1': 52.0, '2': 50.0 });
  });

  it('iLO4 fan rpm and percent are mutually exclusive', () => {
    const body = {
      Fans: [
        { Name: 'Fan 1', Reading: 3000 },
        { FanName: 'Fan 2', CurrentReading: 19, Units: 'Percent' },
      ],
    };
    const out = extractPoints(body, baseline[0]);
    expect(out['sensor_fan_rpm']).toEqual([{ sensor: 'Fan 1', value: 3000.0 }]);
    expect(out['sensor_fan_percent']).toEqual([{ sensor: 'Fan 2', value: 19.0 }]);
  });

  it('PSU LastPowerOutputWatts fallback', () => {
    const body = { PowerSupplies: [{ Name: 'PSU1', LastPowerOutputWatts: 60 }] };
    const out = extractPoints(body, baseline[1]);
    expect(out['sensor_psu_watts']).toEqual([{ sensor: 'PSU1', value: 60.0 }]);
  });

  it('boolean reading rejected', () => {
    const out = extractPoints({ Temperatures: [{ Name: 'X', ReadingCelsius: true }] }, baseline[0]);
    expect(out).toEqual({});
  });

  it('NaN and Inf readings dropped', () => {
    const body = {
      Temperatures: [
        { Name: 'A', ReadingCelsius: Number.NaN },
        { Name: 'B', ReadingCelsius: Number.POSITIVE_INFINITY },
        { Name: 'C', ReadingCelsius: 'NaN' },
        { Name: 'D', ReadingCelsius: 20 },
      ],
    };
    const out = extractPoints(body, baseline[0]);
    expect(out['sensor_temperature_celsius']).toEqual([{ sensor: 'D', value: 20.0 }]);
  });

  it('missing name key emits untagged point', () => {
    const out = extractPoints({ Temperatures: [{ ReadingCelsius: 16 }] }, baseline[0]);
    expect(out['sensor_temperature_celsius']).toEqual([{ value: 16.0 }]);
  });
});

describe('measurement coverage across layouts', () => {
  const LAYOUTS: VendorHints[] = [
    hints({ gpuLayout: GpuLayout.CISCO_CBMC, gpuCount: 1 }),
    hints({ gpuLayout: GpuLayout.NVIDIA_HGX, gpuChassisIds: ['HGX_GPU_0'] }),
    hints({ gpuLayout: GpuLayout.SUPERMICRO_ASPEED, gpuSlots: [1] }),
    hints({
      baselineChassisId: 'System.Embedded.1',
      gpuLayout: GpuLayout.DELL_IDRAC9,
      gpuCount: 1,
    }),
    hints({ gpuLayout: GpuLayout.LENOVO_XCC, gpuCount: 1 }),
    hints({ gpuLayout: GpuLayout.GRAPHICS_CONTROLLER, gpuCount: 1 }),
  ];

  it('every emitted measurement is declared in ALL_MEASUREMENTS', () => {
    const emitted = new Set<string>();
    for (const h of LAYOUTS) {
      for (const p of buildScrapePlan(h)) {
        for (const e of p.extracts) emitted.add(e.measurement);
      }
    }
    for (const m of emitted) expect(ALL_MEASUREMENTS).toContain(m);
    expect(emitted.has('gpu_temperature_celsius')).toBe(true);
    expect(emitted.has('gpu_memory_power_watts')).toBe(true);
  });
});
