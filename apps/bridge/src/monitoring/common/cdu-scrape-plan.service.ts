// `$expand` inlines `Members[]`; `okValue` turns status strings into 1.0/0.0 gauges (e.g. `cdu_leak_detector_ok == 0` means a leak).

export interface Extract {
  readonly measurement: string;
  readonly valuePath: string;
  readonly array: string | null;
  readonly nameKey: string | null;
  readonly nameTag: string;
  readonly scale: number;
  readonly okValue: string | null;
  readonly rankNumericTag: boolean;
}

export interface SensorProbe {
  readonly url: string;
  readonly extracts: ReadonlyArray<Extract>;
  readonly tags: Readonly<Record<string, string>>;
}

interface ExtractInit {
  measurement: string;
  valuePath: string;
  array?: string | null;
  nameKey?: string | null;
  nameTag?: string;
  scale?: number;
  okValue?: string | null;
  rankNumericTag?: boolean;
}

function extract(init: ExtractInit): Extract {
  return {
    measurement: init.measurement,
    valuePath: init.valuePath,
    array: init.array ?? null,
    nameKey: init.nameKey ?? null,
    nameTag: init.nameTag ?? 'sensor',
    scale: init.scale ?? 1.0,
    okValue: init.okValue ?? null,
    rankNumericTag: init.rankNumericTag ?? false,
  };
}

const CDU = '/redfish/v1/ThermalEquipment/CDUs/1';
const EXPAND = '?$expand=*($levels=1)';

export function buildCduScrapePlan(): SensorProbe[] {
  return [
    {
      url: CDU,
      extracts: [
        extract({ measurement: 'cdu_health_ok', valuePath: 'Status.Health', okValue: 'OK' }),
        extract({ measurement: 'cdu_health_rollup_ok', valuePath: 'Status.HealthRollup', okValue: 'OK' }),
        extract({ measurement: 'cdu_state_ok', valuePath: 'Status.State', okValue: 'Enabled' }),
      ],
      tags: {},
    },
    {
      url: `${CDU}/EnvironmentMetrics`,
      extracts: [
        extract({ measurement: 'cdu_ambient_temp_celsius', valuePath: 'TemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_humidity_percent', valuePath: 'HumidityPercent.Reading' }),
        extract({ measurement: 'cdu_absolute_humidity_grams_per_m3', valuePath: 'AbsoluteHumidity.Reading' }),
        extract({ measurement: 'cdu_env_dewpoint_celsius', valuePath: 'DewPointCelsius.Reading' }),
        extract({ measurement: 'cdu_power_watts', valuePath: 'PowerWatts.Reading' }),
        extract({ measurement: 'cdu_energy_kwh', valuePath: 'EnergykWh.Reading' }),
        extract({ measurement: 'cdu_cooling_capacity_watts', valuePath: 'CoolingCapacityWatts' }),
      ],
      tags: {},
    },
    {
      url: `${CDU}/PrimaryCoolantConnectors/1`,
      extracts: [
        extract({ measurement: 'cdu_primary_supply_temp_celsius', valuePath: 'SupplyTemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_primary_return_temp_celsius', valuePath: 'ReturnTemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_primary_delta_temp_celsius', valuePath: 'DeltaTemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_primary_supply_pressure_kpa', valuePath: 'SupplyPressurekPa.Reading' }),
        extract({ measurement: 'cdu_primary_return_pressure_kpa', valuePath: 'ReturnPressurekPa.Reading' }),
        extract({ measurement: 'cdu_primary_delta_pressure_kpa', valuePath: 'DeltaPressurekPa.Reading' }),
        extract({ measurement: 'cdu_primary_flow_lpm', valuePath: 'FlowLitersPerMinute.Reading' }),
        extract({ measurement: 'cdu_primary_heat_removed_kw', valuePath: 'HeatRemovedkW.Reading' }),
      ],
      tags: {},
    },
    {
      url: `${CDU}/SecondaryCoolantConnectors/1`,
      extracts: [
        extract({ measurement: 'cdu_secondary_supply_temp_celsius', valuePath: 'SupplyTemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_secondary_return_temp_celsius', valuePath: 'ReturnTemperatureCelsius.Reading' }),
        extract({ measurement: 'cdu_secondary_delta_temp_celsius', valuePath: 'DeltaTemperatureCelsius.Reading' }),
        extract({
          measurement: 'cdu_secondary_supply_temp_setpoint_celsius',
          valuePath: 'SupplyTemperatureControlCelsius.SetPoint',
        }),
        extract({ measurement: 'cdu_secondary_supply_pressure_kpa', valuePath: 'SupplyPressurekPa.Reading' }),
        extract({ measurement: 'cdu_secondary_return_pressure_kpa', valuePath: 'ReturnPressurekPa.Reading' }),
        extract({ measurement: 'cdu_secondary_delta_pressure_kpa', valuePath: 'DeltaPressurekPa.Reading' }),
        extract({
          measurement: 'cdu_secondary_delta_pressure_setpoint_kpa',
          valuePath: 'DeltaPressureControlkPa.SetPoint',
        }),
        extract({ measurement: 'cdu_secondary_flow_lpm', valuePath: 'FlowLitersPerMinute.Reading' }),
        extract({ measurement: 'cdu_secondary_heat_removed_kw', valuePath: 'HeatRemovedkW.Reading' }),
      ],
      tags: {},
    },
    {
      url: '/redfish/v1/Chassis/1/Sensors/PrimaryDewPointCelsius',
      extracts: [extract({ measurement: 'cdu_primary_dewpoint_celsius', valuePath: 'Reading' })],
      tags: {},
    },
    {
      url: '/redfish/v1/Chassis/1/Sensors/SecondaryDewPointCelsius',
      extracts: [extract({ measurement: 'cdu_secondary_dewpoint_celsius', valuePath: 'Reading' })],
      tags: {},
    },
    {
      url: '/redfish/v1/Chassis/1/Controls/ChillerSupplyValve1',
      extracts: [
        extract({ measurement: 'cdu_valve_position_percent', valuePath: 'Sensor.Reading' }),
        extract({ measurement: 'cdu_valve_setpoint_percent', valuePath: 'SetPoint' }),
        extract({ measurement: 'cdu_valve_health_ok', valuePath: 'Status.Health', okValue: 'OK' }),
      ],
      tags: {},
    },
    {
      url: '/redfish/v1/Managers/CDU',
      extracts: [extract({ measurement: 'cdu_manager_health_ok', valuePath: 'Status.Health', okValue: 'OK' })],
      tags: {},
    },
    {
      url: `${CDU}/LeakDetection`,
      extracts: [extract({ measurement: 'cdu_leak_health_ok', valuePath: 'Status.Health', okValue: 'OK' })],
      tags: {},
    },
    {
      url: `${CDU}/LeakDetection/LeakDetectors${EXPAND}`,
      extracts: [
        extract({
          measurement: 'cdu_leak_detector_ok',
          valuePath: 'DetectorState',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'detector',
          okValue: 'OK',
        }),
        extract({
          measurement: 'cdu_leak_detector_health_ok',
          valuePath: 'Status.Health',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'detector',
          okValue: 'OK',
        }),
      ],
      tags: {},
    },
    {
      url: `${CDU}/Pumps${EXPAND}`,
      extracts: [
        extract({
          measurement: 'cdu_pump_speed_percent',
          valuePath: 'PumpSpeedPercent.Reading',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'pump',
        }),
        extract({
          measurement: 'cdu_pump_speed_rpm',
          valuePath: 'PumpSpeedPercent.SpeedRPM',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'pump',
        }),
        extract({
          measurement: 'cdu_pump_service_hours',
          valuePath: 'ServiceHours',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'pump',
        }),
        extract({
          measurement: 'cdu_pump_health_ok',
          valuePath: 'Status.Health',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'pump',
          okValue: 'OK',
        }),
      ],
      tags: {},
    },
    {
      url: `${CDU}/Reservoirs${EXPAND}`,
      extracts: [
        extract({
          measurement: 'cdu_reservoir_capacity_liters',
          valuePath: 'CapacityLiters',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'reservoir',
        }),
        extract({
          measurement: 'cdu_reservoir_level_ok',
          valuePath: 'FluidLevelStatus',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'reservoir',
          okValue: 'OK',
        }),
        extract({
          measurement: 'cdu_reservoir_health_ok',
          valuePath: 'Status.Health',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'reservoir',
          okValue: 'OK',
        }),
      ],
      tags: {},
    },
    {
      url: `/redfish/v1/Chassis/1/PowerSubsystem/PowerSupplies${EXPAND}`,
      extracts: [
        extract({
          measurement: 'cdu_psu_health_ok',
          valuePath: 'Status.Health',
          array: 'Members',
          nameKey: 'Id',
          nameTag: 'psu',
          okValue: 'OK',
        }),
      ],
      tags: {},
    },
  ];
}

export type CduMeasurementEntry = readonly [measurement: string, tag: string | null];

export function cduMeasurements(): CduMeasurementEntry[] {
  const seen = new Map<string, string | null>();
  for (const probe of buildCduScrapePlan()) {
    for (const ex of probe.extracts) {
      if (!seen.has(ex.measurement)) {
        seen.set(ex.measurement, ex.nameKey ? ex.nameTag : null);
      }
    }
  }
  return Array.from(seen.entries());
}
