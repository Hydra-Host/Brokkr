import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { readFile, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.performance');

const TIMEOUT_MS = 60_000;

export async function runPerformanceDiagnostic(): Promise<{ performance: Record<string, unknown> }> {
  const cpuPerf: HealthSection = {};
  const ioPerf: HealthSection = {};
  const loadMetrics: HealthSection = {};
  const throttling: HealthSection = {};
  const perfCounters: HealthSection = {};

  let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  const perfIssues: string[] = [];
  const perfWarnings: string[] = [];

  try {
    const cpufreqOutput = await readFile('/proc/cpuinfo');
    if (cpufreqOutput) {
      const cpuMhzEntries: number[] = [];
      let cpuModel: string | null = null;

      for (const line of cpufreqOutput.split('\n')) {
        if (line.startsWith('cpu MHz')) {
          try {
            const mhz = parseFloat(line.split(':')[1]!.trim());
            if (!Number.isNaN(mhz)) cpuMhzEntries.push(mhz);
          } catch (error) {
            logger.trace('cpuinfo mhz parse failed', { error: getErrorMessage(error) });
          }
        } else if (line.startsWith('model name') && cpuModel === null) {
          cpuModel = line.split(/:(.*)/s)[1]!.trim();
        }
      }

      if (cpuMhzEntries.length > 0) {
        const minFreq = Math.min(...cpuMhzEntries);
        const maxFreq = Math.max(...cpuMhzEntries);
        const avgFreq = cpuMhzEntries.reduce((a, b) => a + b, 0) / cpuMhzEntries.length;

        cpuPerf['model'] = cpuModel;
        cpuPerf['current_frequencies_mhz'] = {
          min: minFreq,
          max: maxFreq,
          average: Math.round(avgFreq * 10) / 10,
        };
        cpuPerf['core_count'] = cpuMhzEntries.length;
        cpuPerf['frequency_variance'] = Math.round((maxFreq - minFreq) * 10) / 10;

        if (maxFreq - minFreq > 500) {
          perfWarnings.push(`CPU frequency variance detected: ${(maxFreq - minFreq).toFixed(0)} MHz`);
        }
        if (minFreq < 1000) {
          if (overallStatus === 'healthy') overallStatus = 'warning';
          perfWarnings.push(`Low CPU frequency detected: ${minFreq.toFixed(0)} MHz`);
        }
      }
    }

    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const throttlingPatterns = [
        'thermal throttling',
        'cpu throttling',
        'overheating',
        'temperature above threshold',
        'thermal emergency',
        'throttled',
      ];

      const throttlingEvents: string[] = [];
      for (const line of dmesgOutput.split('\n')) {
        const lineLower = line.toLowerCase();
        for (const pattern of throttlingPatterns) {
          if (lineLower.includes(pattern)) {
            throttlingEvents.push(line.trim());
            break;
          }
        }
      }

      throttling['recent_events'] = throttlingEvents.slice(-5);
      throttling['total_events'] = throttlingEvents.length;

      if (throttlingEvents.length > 0) {
        if (throttlingEvents.length > 5) {
          if (overallStatus === 'healthy') overallStatus = 'critical';
          perfIssues.push(`Frequent thermal throttling: ${throttlingEvents.length} events`);
        } else {
          if (overallStatus === 'healthy') overallStatus = 'warning';
          perfWarnings.push(`Thermal throttling detected: ${throttlingEvents.length} events`);
        }
      }
    }
  } catch (error) {
    cpuPerf['error'] = getErrorMessage(error);
  }

  try {
    const iostatOutput = await sh('iostat -x 1 2', TIMEOUT_MS);
    if (iostatOutput) {
      const lines = iostatOutput.split('\n');
      const deviceMetrics: Record<string, Record<string, unknown>> = {};
      let parsingDevices = false;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.includes('Device') && line.includes('r/s')) {
          parsingDevices = true;
          continue;
        } else if (parsingDevices && line && !line.startsWith('avg-cpu')) {
          try {
            const parts = line.split(/\s+/);
            if (parts.length >= 10) {
              const device = parts[0]!;
              const readPs = parseFloat(parts[3]!);
              const writePs = parseFloat(parts[4]!);
              const utilPct = parseFloat(parts[9]!);

              deviceMetrics[device] = {
                reads_per_sec: readPs,
                writes_per_sec: writePs,
                utilization_percent: utilPct,
              };

              if (utilPct > 95) {
                if (overallStatus === 'healthy') overallStatus = 'critical';
                perfIssues.push(`Critical I/O utilization on ${device}: ${utilPct}%`);
              } else if (utilPct > 90) {
                if (overallStatus === 'healthy') overallStatus = 'warning';
                perfWarnings.push(`High I/O utilization on ${device}: ${utilPct}%`);
              }
            }
          } catch (error) {
            logger.trace('iostat device line parse failed', { error: getErrorMessage(error) });
          }
        } else if (parsingDevices && line === '') {
          parsingDevices = false;
        }
      }

      ioPerf['device_metrics'] = deviceMetrics;
      ioPerf['devices_monitored'] = Object.keys(deviceMetrics).length;
    }
  } catch (error) {
    const msg = getErrorMessage(error);
    ioPerf['iostat_available'] = false;
    perfWarnings.push('iostat not available - I/O performance monitoring unavailable');
    ioPerf['error'] = msg;
  }

  try {
    const loadavgOutput = await readFile('/proc/loadavg');
    if (loadavgOutput) {
      const loadParts = loadavgOutput.split(/\s+/);
      if (loadParts.length >= 4) {
        const load1min = parseFloat(loadParts[0]!);
        const load5min = parseFloat(loadParts[1]!);
        const load15min = parseFloat(loadParts[2]!);
        const procParts = loadParts[3]!.split('/');
        const running = Number.parseInt(procParts[0]!, 10);
        const total = Number.parseInt(procParts[1]!, 10);

        loadMetrics['load_averages'] = {
          '1min': load1min,
          '5min': load5min,
          '15min': load15min,
        };
        loadMetrics['processes'] = { running, total };

        try {
          const cpuCountOutput = await sh('nproc', TIMEOUT_MS);
          if (cpuCountOutput) {
            const cpuCount = Number.parseInt(cpuCountOutput.trim(), 10);
            loadMetrics['cpu_count'] = cpuCount;

            const loadPerCpu1min = load1min / cpuCount;
            const loadPerCpu5min = load5min / cpuCount;

            loadMetrics['load_per_cpu'] = {
              '1min': Math.round(loadPerCpu1min * 100) / 100,
              '5min': Math.round(loadPerCpu5min * 100) / 100,
            };

            if (loadPerCpu1min > 2.0) {
              if (overallStatus === 'healthy') overallStatus = 'critical';
              perfIssues.push(`Critical system load: ${loadPerCpu1min.toFixed(1)} per CPU`);
            } else if (loadPerCpu1min > 1.5) {
              if (overallStatus === 'healthy') overallStatus = 'warning';
              perfWarnings.push(`High system load: ${loadPerCpu1min.toFixed(1)} per CPU`);
            }

            if (loadPerCpu1min > loadPerCpu5min * 1.5) {
              perfWarnings.push('Load increasing rapidly');
            } else if (loadPerCpu5min > loadPerCpu1min * 1.5) {
              loadMetrics['trend'] = 'decreasing';
            }
          }
        } catch (error) {
          logger.debug('nproc load analysis failed', { error: getErrorMessage(error) });
        }
      }
    }

    const meminfoOutput = await readFile('/proc/meminfo');
    if (meminfoOutput) {
      for (const line of meminfoOutput.split('\n')) {
        if (line.startsWith('MemAvailable:')) {
          try {
            const availableKb = Number.parseInt(line.split(/\s+/)[1]!, 10);
            const availableMb = Math.floor(availableKb / 1024);
            loadMetrics['memory_available_mb'] = availableMb;

            if (availableMb < 256) {
              if (overallStatus === 'healthy') overallStatus = 'critical';
              perfIssues.push(`Critical memory pressure: ${availableMb} MB available`);
            } else if (availableMb < 512) {
              if (overallStatus === 'healthy') overallStatus = 'warning';
              perfWarnings.push(`Low memory available: ${availableMb} MB`);
            }
          } catch (error) {
            logger.trace('meminfo memavailable parse failed', { error: getErrorMessage(error) });
          }
          break;
        }
      }
    }
  } catch (error) {
    loadMetrics['error'] = getErrorMessage(error);
  }

  try {
    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const perfPatterns = [
        'performance',
        'slow',
        'timeout',
        'latency',
        'hung task',
        'blocked',
        'stalled',
        'watchdog',
        'soft lockup',
        'hard lockup',
      ];

      const perfEvents: string[] = [];
      for (const line of dmesgOutput.split('\n')) {
        const lineLower = line.toLowerCase();
        for (const pattern of perfPatterns) {
          if (lineLower.includes(pattern)) {
            perfEvents.push(line.trim());
            break;
          }
        }
      }

      if (perfEvents.length > 0) {
        perfCounters['recent_events'] = perfEvents.slice(-8);
        perfCounters['total_events'] = perfEvents.length;

        const criticalPatterns = ['hung task', 'lockup', 'watchdog', 'stalled'];
        const criticalEvents = perfEvents.filter((e) => criticalPatterns.some((p) => e.toLowerCase().includes(p)));

        if (criticalEvents.length > 0) {
          if (criticalEvents.length > 3) {
            if (overallStatus === 'healthy') overallStatus = 'critical';
            perfIssues.push(`Critical performance events: ${criticalEvents.length} events`);
          } else {
            if (overallStatus === 'healthy') overallStatus = 'warning';
            perfWarnings.push(`Performance events detected: ${criticalEvents.length} events`);
          }
        }
      } else {
        perfCounters['recent_events'] = [];
        perfCounters['total_events'] = 0;
      }
    }
  } catch (error) {
    perfCounters['error'] = getErrorMessage(error);
  }

  const recommendations: string[] = [];
  if (perfIssues.length > 0) {
    recommendations.push('Performance issues detected - optimization required');
    if (perfIssues.some((i) => i.toLowerCase().includes('throttling'))) {
      recommendations.push('Check thermal management and CPU cooling');
    }
    if (perfIssues.some((i) => i.toLowerCase().includes('load'))) {
      recommendations.push('Reduce system load or add more CPU capacity');
    }
    if (perfIssues.some((i) => i.toLowerCase().includes('memory'))) {
      recommendations.push('Add more memory or reduce memory usage');
    }
    if (perfIssues.some((i) => i.toLowerCase().includes('i/o'))) {
      recommendations.push('Optimize storage I/O or upgrade storage');
    }
  } else if (perfWarnings.length > 0) {
    recommendations.push('Monitor performance metrics closely');
    if (perfWarnings.some((w) => w.toLowerCase().includes('frequency'))) {
      recommendations.push('Monitor CPU frequency scaling behavior');
    }
    if (perfWarnings.some((w) => w.toLowerCase().includes('load'))) {
      recommendations.push('Consider load balancing or resource optimization');
    }
    if (perfWarnings.some((w) => w.toLowerCase().includes('utilization'))) {
      recommendations.push('Monitor resource utilization trends');
    }
  } else {
    recommendations.push('System performance appears optimal');
  }

  const health_assessment: HealthSection = {
    overall_status: overallStatus,
    issues: perfIssues,
    warnings: perfWarnings,
    checks_performed: [
      'CPU frequency and throttling analysis',
      'I/O performance monitoring',
      'System load assessment',
      'Memory pressure evaluation',
      'Performance event detection',
    ],
    recommendations,
  };

  return {
    performance: {
      status: overallStatus,
      cpu_performance: cpuPerf,
      io_performance: ioPerf,
      load_metrics: loadMetrics,
      throttling_events: throttling,
      performance_counters: perfCounters,
      health_assessment,
    },
  };
}

export function registerPerformanceDiagnostic(): void {
  registerOperation('diagnostic.performance', async () => runPerformanceDiagnostic());
}
