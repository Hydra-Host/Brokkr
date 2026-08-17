import { describe, expect, it } from 'vitest';

import { buildCduScrapePlan, cduMeasurements } from '../cdu-scrape-plan.service';
import { extractPoints, type SensorProbe } from '../scrape-plan.service';

function probeFor(urlSubstr: string): SensorProbe {
  const probe = buildCduScrapePlan().find((p) => p.url.includes(urlSubstr));
  if (!probe) throw new Error(`probe not found: ${urlSubstr}`);
  return probe;
}

describe('CDU plan shape', () => {
  it('targets the thermal-equipment tree', () => {
    const urls = buildCduScrapePlan().map((p) => p.url);
    expect(urls).toContain('/redfish/v1/ThermalEquipment/CDUs/1/PrimaryCoolantConnectors/1');
    expect(urls).toContain('/redfish/v1/ThermalEquipment/CDUs/1/SecondaryCoolantConnectors/1');
    expect(urls.some((u) => u.includes('LeakDetectors'))).toBe(true);
  });

  it('uses $expand for member collections', () => {
    for (const substr of ['Pumps', 'Reservoirs', 'LeakDetectors', 'PowerSupplies']) {
      expect(probeFor(substr).url.endsWith('?$expand=*($levels=1)')).toBe(true);
    }
  });

  it('static plan needs no hints and emits at least 10 probes', () => {
    expect(buildCduScrapePlan().length).toBeGreaterThanOrEqual(10);
  });
});

describe('CDU numeric extraction', () => {
  it('extracts primary coolant readings', () => {
    const probe = probeFor('PrimaryCoolantConnectors');
    const body = {
      SupplyTemperatureCelsius: { Reading: 32.5 },
      ReturnTemperatureCelsius: { Reading: 40.0 },
      FlowLitersPerMinute: { Reading: 120.0 },
      HeatRemovedkW: { Reading: 18.3 },
    };
    const out = extractPoints(body, probe);
    expect(out['cdu_primary_supply_temp_celsius']).toEqual([{ value: 32.5 }]);
    expect(out['cdu_primary_flow_lpm']).toEqual([{ value: 120.0 }]);
    expect(out['cdu_primary_delta_pressure_kpa']).toBeUndefined();
  });
});

describe('CDU status gauges', () => {
  it('health OK maps to 1.0', () => {
    const probe = probeFor('/redfish/v1/Managers/CDU');
    expect(extractPoints({ Status: { Health: 'OK' } }, probe)['cdu_manager_health_ok']).toEqual([{ value: 1.0 }]);
  });

  it('health not OK maps to 0.0', () => {
    const probe = probeFor('/redfish/v1/Managers/CDU');
    expect(extractPoints({ Status: { Health: 'Critical' } }, probe)['cdu_manager_health_ok']).toEqual([{ value: 0.0 }]);
  });

  it('leak detected maps to 0.0 per detector', () => {
    const probe = probeFor('LeakDetectors');
    const body = {
      Members: [
        { Id: '1', DetectorState: 'OK', Status: { Health: 'OK' } },
        { Id: '2', DetectorState: 'CriticalFlow', Status: { Health: 'Critical' } },
      ],
    };
    const out = extractPoints(body, probe);
    const byDetector = Object.fromEntries((out['cdu_leak_detector_ok'] ?? []).map((p) => [p['detector'], p['value']]));
    expect(byDetector).toEqual({ '1': 1.0, '2': 0.0 });
  });

  it('absent status produces no points', () => {
    const probe = probeFor('/redfish/v1/Managers/CDU');
    expect(extractPoints({ Status: {} }, probe)).toEqual({});
  });
});

describe('CDU array unroll', () => {
  it('pumps tagged by member id', () => {
    const probe = probeFor('Pumps');
    const body = {
      Members: [
        {
          Id: 'Pump1',
          PumpSpeedPercent: { Reading: 55.0, SpeedRPM: 3300 },
          Status: { Health: 'OK' },
        },
        {
          Id: 'Pump2',
          PumpSpeedPercent: { Reading: 0.0, SpeedRPM: 0 },
          Status: { Health: 'Warning' },
        },
      ],
    };
    const out = extractPoints(body, probe);
    const speeds = Object.fromEntries((out['cdu_pump_speed_percent'] ?? []).map((p) => [p['pump'], p['value']]));
    expect(speeds).toEqual({ Pump1: 55.0, Pump2: 0.0 });
    const health = Object.fromEntries((out['cdu_pump_health_ok'] ?? []).map((p) => [p['pump'], p['value']]));
    expect(health).toEqual({ Pump1: 1.0, Pump2: 0.0 });
  });
});

describe('CDU measurement catalog', () => {
  it('singletons have no tag, arrays do', () => {
    const catalog = new Map(cduMeasurements());
    expect(catalog.get('cdu_primary_supply_temp_celsius')).toBeNull();
    expect(catalog.get('cdu_leak_detector_ok')).toBe('detector');
    expect(catalog.get('cdu_pump_speed_percent')).toBe('pump');
    expect(catalog.get('cdu_reservoir_capacity_liters')).toBe('reservoir');
    expect(catalog.get('cdu_psu_health_ok')).toBe('psu');
  });

  it('catalog covers every emitted measurement', () => {
    const emitted = new Set<string>();
    for (const probe of buildCduScrapePlan()) {
      for (const ex of probe.extracts) emitted.add(ex.measurement);
    }
    const catalogNames = new Set(cduMeasurements().map(([m]) => m));
    expect(catalogNames).toEqual(emitted);
  });
});
