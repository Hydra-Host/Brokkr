export interface MeterFakeObservation {
  value: number;
  attrs?: Record<string, unknown>;
}

type GaugeCallback = (result: { observe(value: number, attrs?: Record<string, unknown>): void }) => unknown;

export interface RecordingMeterFake {
  counters: Record<string, MeterFakeObservation[]>;
  meter: {
    createCounter(name: string): { add(value: number, attrs?: Record<string, unknown>): void };
    createObservableGauge(name: string): { addCallback(callback: GaugeCallback): void };
  };
  reset(): void;
  collect(name: string): Promise<MeterFakeObservation[]>;
}

export function createRecordingMeterFake(): RecordingMeterFake {
  const counters: Record<string, MeterFakeObservation[]> = {};
  const gauges: Record<string, GaugeCallback[]> = {};
  return {
    counters,
    meter: {
      createCounter: (name: string) => ({
        add: (value: number, attrs?: Record<string, unknown>) => {
          (counters[name] ??= []).push({ value, attrs });
        },
      }),
      createObservableGauge: (name: string) => ({
        addCallback: (callback: GaugeCallback) => {
          (gauges[name] ??= []).push(callback);
        },
      }),
    },
    reset() {
      for (const key of Object.keys(counters)) delete counters[key];
      for (const key of Object.keys(gauges)) delete gauges[key];
    },
    async collect(name: string) {
      const observed: MeterFakeObservation[] = [];
      for (const callback of gauges[name] ?? []) {
        await callback({ observe: (value, attrs) => void observed.push({ value, attrs }) });
      }
      return observed;
    },
  };
}
