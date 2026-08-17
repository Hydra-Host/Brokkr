// The `scrape-plan-v1` corpus locks the byte-stable outputs of buildScrapePlan and extractPoints — both must remain pure.

import { isRecord } from '@repo/utils';

export const ALL_MEASUREMENTS = [
  'sensor_temperature_celsius',
  'sensor_fan_rpm',
  'sensor_fan_percent',
  'sensor_voltage_volts',
  'sensor_psu_watts',
  'chassis_power_watts',
  'gpu_temperature_celsius',
  'gpu_memory_temperature_celsius',
  'gpu_power_watts',
  'gpu_memory_power_watts',
] as const;

export type Measurement = (typeof ALL_MEASUREMENTS)[number];

export enum GpuLayout {
  NONE = 'none',
  DELL_IDRAC9 = 'dell_idrac9',
  LENOVO_XCC = 'lenovo_xcc',
  CISCO_CBMC = 'cisco_cbmc',
  GRAPHICS_CONTROLLER = 'graphics_controller',
  SUPERMICRO_ASPEED = 'supermicro_aspeed',
  NVIDIA_HGX = 'nvidia_hgx',
}

export interface VendorHints {
  baselineChassisId: string;
  baselineUrlTrailingSlash: boolean;
  gpuLayout: GpuLayout;
  gpuCount: number;
  gpuSlots: readonly number[];
  gpuChassisIds: readonly string[];
}

export const DEFAULT_VENDOR_HINTS: VendorHints = {
  baselineChassisId: '1',
  baselineUrlTrailingSlash: false,
  gpuLayout: GpuLayout.NONE,
  gpuCount: 0,
  gpuSlots: [],
  gpuChassisIds: [],
};

export interface Extract {
  measurement: string;
  valuePath: string;
  array: string | null;
  nameKey: string | null;
  nameTag: string;
  scale: number;
  okValue: string | null;
  rankNumericTag: boolean;
}

export const EXTRACT_DEFAULTS = {
  array: null,
  nameKey: null,
  nameTag: 'sensor',
  scale: 1.0,
  okValue: null,
  rankNumericTag: false,
} as const;

export function makeExtract(
  measurement: string,
  valuePath: string,
  overrides: Partial<Omit<Extract, 'measurement' | 'valuePath'>> = {},
): Extract {
  return {
    measurement,
    valuePath,
    array: overrides.array ?? EXTRACT_DEFAULTS.array,
    nameKey: overrides.nameKey ?? EXTRACT_DEFAULTS.nameKey,
    nameTag: overrides.nameTag ?? EXTRACT_DEFAULTS.nameTag,
    scale: overrides.scale ?? EXTRACT_DEFAULTS.scale,
    okValue: overrides.okValue ?? EXTRACT_DEFAULTS.okValue,
    rankNumericTag: overrides.rankNumericTag ?? EXTRACT_DEFAULTS.rankNumericTag,
  };
}

export interface SensorProbe {
  url: string;
  extracts: readonly Extract[];
  tags: Readonly<Record<string, string>>;
}

export type SensorPoint = Record<string, unknown>;

export type MeasurementPoints = Record<string, SensorPoint[]>;

function baselineProbes(hints: VendorHints): SensorProbe[] {
  const slash = hints.baselineUrlTrailingSlash ? '/' : '';
  const chassis = hints.baselineChassisId;
  return [
    {
      url: `/redfish/v1/Chassis/${chassis}/Thermal${slash}`,
      extracts: [
        makeExtract('sensor_temperature_celsius', 'ReadingCelsius', { array: 'Temperatures', nameKey: 'Name' }),
        makeExtract('sensor_fan_rpm', 'Reading', { array: 'Fans', nameKey: 'Name' }),
        makeExtract('sensor_fan_percent', 'CurrentReading', { array: 'Fans', nameKey: 'FanName' }),
      ],
      tags: {},
    },
    {
      url: `/redfish/v1/Chassis/${chassis}/Power${slash}`,
      extracts: [
        makeExtract('sensor_voltage_volts', 'ReadingVolts', { array: 'Voltages', nameKey: 'Name' }),
        makeExtract('sensor_psu_watts', 'PowerOutputWatts', { array: 'PowerSupplies', nameKey: 'Name' }),
        makeExtract('sensor_psu_watts', 'LastPowerOutputWatts', { array: 'PowerSupplies', nameKey: 'Name' }),
        makeExtract('chassis_power_watts', 'PowerConsumedWatts', { array: 'PowerControl', nameKey: 'Name' }),
      ],
      tags: {},
    },
  ];
}

function ciscoCbmcProbes(hints: VendorHints): SensorProbe[] {
  const probes: SensorProbe[] = [];
  for (let i = 0; i < hints.gpuCount; i += 1) {
    const n = i + 1;
    const base = `/redfish/v1/Chassis/GPU_${n}/Sensors`;
    const tags = { gpu_index: String(i) };
    probes.push({
      url: `${base}/temperature_GPU_${n}_Temp_0`,
      extracts: [makeExtract('gpu_temperature_celsius', 'Reading')],
      tags,
    });
    probes.push({
      url: `${base}/temperature_GPU_${n}_DRAM_0_Temp_0`,
      extracts: [makeExtract('gpu_memory_temperature_celsius', 'Reading')],
      tags,
    });
    probes.push({
      url: `${base}/power_GPU_${n}_Power_0`,
      extracts: [makeExtract('gpu_power_watts', 'Reading')],
      tags,
    });
  }
  return probes;
}

function graphicsControllerProbes(hints: VendorHints): SensorProbe[] {
  const probes: SensorProbe[] = [];
  for (let n = 0; n < hints.gpuCount; n += 1) {
    probes.push({
      url: `/redfish/v1/Systems/1/GraphicsControllers/GPU${n}`,
      extracts: [
        makeExtract('gpu_temperature_celsius', 'Oem.Public.Temperature'),
        makeExtract('gpu_temperature_celsius', 'Oem.Temperature'),
        makeExtract('gpu_power_watts', 'Oem.Public.PowerWatts'),
        makeExtract('gpu_power_watts', 'PowerWatts'),
      ],
      tags: { gpu_index: String(n) },
    });
  }
  return probes;
}

function nvidiaHgxProbes(hints: VendorHints): SensorProbe[] {
  const probes: SensorProbe[] = [];
  hints.gpuChassisIds.forEach((hgx, i) => {
    const base = `/redfish/v1/Chassis/${hgx}/Sensors`;
    const tags = { gpu_index: String(i) };
    probes.push({
      url: `${base}/${hgx}_TEMP_0`,
      extracts: [makeExtract('gpu_temperature_celsius', 'Reading')],
      tags,
    });
    probes.push({
      url: `${base}/${hgx}_DRAM_0_Temp_0`,
      extracts: [makeExtract('gpu_memory_temperature_celsius', 'Reading')],
      tags,
    });
    probes.push({
      url: `${base}/${hgx}_Power_0`,
      extracts: [makeExtract('gpu_power_watts', 'Reading')],
      tags,
    });
    probes.push({
      url: `${base}/${hgx}_DRAM_0_Power_0`,
      extracts: [makeExtract('gpu_memory_power_watts', 'Reading')],
      tags,
    });
  });
  return probes;
}

function supermicroAspeedProbes(hints: VendorHints): SensorProbe[] {
  return hints.gpuSlots.map((slot, i) => ({
    url: `/redfish/v1/Chassis/1/Sensors/GPU${slot}Temp`,
    extracts: [makeExtract('gpu_temperature_celsius', 'Reading')],
    tags: { gpu_index: String(i) },
  }));
}

function dellIdrac9Probes(_hints: VendorHints): SensorProbe[] {
  return [
    {
      url: '/redfish/v1/Systems/System.Embedded.1/Oem/Dell/DellGPUSensors',
      extracts: [
        makeExtract('gpu_temperature_celsius', 'PrimaryGPUTemperatureCelsius', {
          array: 'Members',
          nameKey: 'DeviceID',
          nameTag: 'gpu_index',
          rankNumericTag: true,
        }),
        makeExtract('gpu_power_watts', 'PowerConsumptionmW', {
          array: 'Members',
          nameKey: 'DeviceID',
          nameTag: 'gpu_index',
          scale: 0.001,
          rankNumericTag: true,
        }),
      ],
      tags: {},
    },
  ];
}

function lenovoXccProbes(hints: VendorHints): SensorProbe[] {
  const probes: SensorProbe[] = [];
  for (let i = 0; i < hints.gpuCount; i += 1) {
    const n = i + 1;
    const tags = { gpu_index: String(i) };
    probes.push({
      url: `/redfish/v1/Chassis/1/Sensors/GPU${n}_Temp`,
      extracts: [makeExtract('gpu_temperature_celsius', 'Reading')],
      tags,
    });
    probes.push({
      url: `/redfish/v1/Chassis/1/Sensors/GPU${n}_Power`,
      extracts: [makeExtract('gpu_power_watts', 'Reading')],
      tags,
    });
  }
  return probes;
}

const GPU_LAYOUT_PROBES: Partial<Record<GpuLayout, (hints: VendorHints) => SensorProbe[]>> = {
  [GpuLayout.DELL_IDRAC9]: dellIdrac9Probes,
  [GpuLayout.LENOVO_XCC]: lenovoXccProbes,
  [GpuLayout.CISCO_CBMC]: ciscoCbmcProbes,
  [GpuLayout.GRAPHICS_CONTROLLER]: graphicsControllerProbes,
  [GpuLayout.SUPERMICRO_ASPEED]: supermicroAspeedProbes,
  [GpuLayout.NVIDIA_HGX]: nvidiaHgxProbes,
};

export function buildScrapePlan(hints: VendorHints): SensorProbe[] {
  const plan = baselineProbes(hints);
  const builder = GPU_LAYOUT_PROBES[hints.gpuLayout];
  if (builder !== undefined) plan.push(...builder(hints));
  return plan;
}

function dig(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!isRecord(cur)) return null;
    const next = cur[part];
    cur = next === undefined ? null : next;
  }
  return cur;
}

const STRICT_FLOAT_RE =
  /^[+-]?(?:inf(?:inity)?|nan|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$/i;

function coerceFloat(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  let result: number;
  if (typeof value === 'number') {
    result = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (!STRICT_FLOAT_RE.test(trimmed)) return null;
    result = Number(trimmed.replace(/_/g, ''));
    if (Number.isNaN(result)) return null;
  } else {
    return null;
  }
  if (Number.isNaN(result) || !Number.isFinite(result)) return null;
  return result;
}

const FIRST_INT = /\d+/;

function numericRankMap(elements: readonly unknown[], nameKey: string): Map<unknown, string> {
  const parsed: Array<[unknown, number]> = [];
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const raw = element[nameKey];
    if (raw === undefined || raw === null) continue;
    const match = FIRST_INT.exec(String(raw));
    if (match === null) continue;
    parsed.push([raw, Number.parseInt(match[0], 10)]);
  }
  const uniqueSorted = Array.from(new Set(parsed.map(([, n]) => n))).sort((a, b) => a - b);
  const rankOf = new Map<number, number>();
  uniqueSorted.forEach((n, idx) => rankOf.set(n, idx));
  const result = new Map<unknown, string>();
  for (const [raw, n] of parsed) {
    const rank = rankOf.get(n);
    if (rank !== undefined) result.set(raw, String(rank));
  }
  return result;
}

function canonicalNumeric(result: number): number {
  return Number(result.toFixed(6));
}

export function extractPoints(body: Record<string, unknown>, probe: SensorProbe): MeasurementPoints {
  const out: MeasurementPoints = {};
  for (const ex of probe.extracts) {
    let elements: readonly unknown[];
    if (ex.array === null) {
      elements = [body];
    } else {
      const arr = body[ex.array];
      if (!Array.isArray(arr)) continue;
      elements = arr;
    }
    const rankMap = ex.rankNumericTag && ex.nameKey !== null ? numericRankMap(elements, ex.nameKey) : null;
    const points: SensorPoint[] = [];
    for (const element of elements) {
      if (!isRecord(element)) continue;
      const raw = dig(element, ex.valuePath);
      let value: number;
      if (ex.okValue !== null) {
        if (raw === null || raw === undefined) continue;
        value = String(raw) === ex.okValue ? 1 : 0;
      } else {
        const numeric = coerceFloat(raw);
        if (numeric === null) continue;
        value = canonicalNumeric(numeric * ex.scale);
      }
      const point: SensorPoint = { ...probe.tags };
      if (ex.nameKey !== null) {
        const nameValue = element[ex.nameKey];
        if (nameValue !== null && nameValue !== undefined) {
          const ranked = rankMap?.get(nameValue);
          point[ex.nameTag] = ranked !== undefined ? ranked : nameValue;
        }
      }
      point.value = value;
      points.push(point);
    }
    if (points.length > 0) {
      if (out[ex.measurement] === undefined) out[ex.measurement] = [];
      out[ex.measurement].push(...points);
    }
  }
  return out;
}
