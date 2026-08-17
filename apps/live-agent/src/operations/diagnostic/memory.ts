import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { readFile, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.memory');

const TIMEOUT_MS = 60_000;

const MEMORY_ERROR_REGEXES: RegExp[] = [
  /\b(corrected|correctable|uncorrected|uncorrectable)\b[^.]*\berrors?\b/i,
  /\b[CU]E\b[^.]*\berrors?\b/i,
  /machine check\b[^.]*\b(errors?|exception|events?|logged)\b/i,
  /\bhardware errors?\b[^.]*memory/i,
  /\bmemory (errors?|failures?|corruption)\b/i,
  /\bbad ram\b/i,
];

const MEMORY_CRITICAL_REGEXES: RegExp[] = [
  /\b(uncorrected|uncorrectable)\b/i,
  /\bfatal\b/i,
  /machine check (errors?|exception)/i,
  /memory corruption/i,
];

export function matchMemoryDmesgErrors(dmesgOutput: string): { errors: string[]; critical: string[] } {
  const errors: string[] = [];
  for (const line of dmesgOutput.split('\n')) {
    if (MEMORY_ERROR_REGEXES.some((re) => re.test(line))) {
      errors.push(line.trim());
    }
  }
  const critical = errors.filter((e) => MEMORY_CRITICAL_REGEXES.some((re) => re.test(e)));
  return { errors, critical };
}

export async function runMemoryDiagnostic(): Promise<{ memory: Record<string, unknown> }> {
  const ecc: HealthSection = {};
  const dimm: HealthSection = {};
  const util: HealthSection = {};
  const errs: HealthSection = {};
  const ctrl: HealthSection = {};

  let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  const memoryIssues: string[] = [];
  const memoryWarnings: string[] = [];

  try {
    const edacOutput = await sh('edac-util -s', TIMEOUT_MS);
    if (edacOutput) {
      ecc['raw_output'] = edacOutput.trim();

      if (edacOutput.includes('EDAC drivers are loaded')) {
        ecc['drivers_loaded'] = true;
        ecc['ecc_supported'] = true;

        if (edacOutput.includes('Correctable Errors') || edacOutput.includes('Uncorrectable Errors')) {
          for (const line of edacOutput.split('\n')) {
            if (line.includes('Correctable Errors:')) {
              try {
                const correctable = Number.parseInt(line.split(':')[1]!.trim(), 10);
                ecc['correctable_errors'] = correctable;
                if (correctable > 0) {
                  memoryWarnings.push(`ECC correctable errors detected: ${correctable}`);
                }
              } catch (error) {
                logger.trace('edac correctable error count parse failed', { error: getErrorMessage(error) });
              }
            } else if (line.includes('Uncorrectable Errors:')) {
              try {
                const uncorrectable = Number.parseInt(line.split(':')[1]!.trim(), 10);
                ecc['uncorrectable_errors'] = uncorrectable;
                if (uncorrectable > 0) {
                  overallStatus = 'critical';
                  memoryIssues.push(`ECC uncorrectable errors detected: ${uncorrectable}`);
                }
              } catch (error) {
                logger.trace('edac uncorrectable error count parse failed', { error: getErrorMessage(error) });
              }
            }
          }
        }
      } else {
        ecc['drivers_loaded'] = false;
        ecc['ecc_supported'] = false;
        memoryWarnings.push('ECC drivers not loaded - ECC monitoring unavailable');
      }
    }
  } catch {
    ecc['edac_util_available'] = false;
    memoryWarnings.push('edac-util not available - ECC monitoring unavailable');
  }

  try {
    const dmidecodeOutput = await sh('dmidecode -t memory', TIMEOUT_MS);
    if (dmidecodeOutput) {
      dimm['raw_output'] = dmidecodeOutput.trim();

      const dimmInfo: Record<string, Record<string, string>> = {};
      let currentDimm: number | null = null;

      for (const rawLine of dmidecodeOutput.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('Memory Device')) {
          currentDimm = Object.keys(dimmInfo).length;
          dimmInfo[`dimm_${currentDimm}`] = {};
        } else if (currentDimm !== null && line.includes(':')) {
          const [keyRaw, valueRaw] = line.split(/:(.*)/s);
          const key = keyRaw!.trim().toLowerCase().replace(/ /g, '_');
          const value = (valueRaw ?? '').trim();

          if (['size', 'speed', 'manufacturer', 'part_number', 'serial_number', 'type'].includes(key)) {
            dimmInfo[`dimm_${currentDimm}`]![key] = value;

            if (key === 'size' && value !== 'No Module Installed' && !value.includes('GB') && !value.includes('MB')) {
              if (!['Unknown', 'Not Specified'].includes(value)) {
                memoryWarnings.push(`DIMM ${currentDimm} size reporting issue: ${value}`);
              }
            }
          }
        }
      }

      dimm['parsed_dimms'] = dimmInfo;
      dimm['total_dimms'] = Object.values(dimmInfo).filter(
        (d) => (d['size'] ?? 'No Module Installed') !== 'No Module Installed',
      ).length;
    }
  } catch (error) {
    dimm['error'] = getErrorMessage(error);
  }

  try {
    const meminfoOutput = await readFile('/proc/meminfo');
    if (meminfoOutput) {
      const meminfoData: Record<string, string> = {};
      for (const line of meminfoOutput.split('\n')) {
        if (line.includes(':')) {
          const [keyRaw, valueRaw] = line.split(/:(.*)/s);
          const key = keyRaw!.trim();
          const value = (valueRaw ?? '').trim();
          if (['MemTotal', 'MemFree', 'MemAvailable', 'Buffers', 'Cached', 'SwapTotal', 'SwapFree'].includes(key)) {
            meminfoData[key] = value;
          }
        }
      }

      util['meminfo'] = meminfoData;

      if ('MemTotal' in meminfoData && 'MemAvailable' in meminfoData) {
        try {
          const totalMb = Math.floor(Number.parseInt(meminfoData['MemTotal']!.split(' ')[0]!, 10) / 1024);
          const availableMb = Math.floor(Number.parseInt(meminfoData['MemAvailable']!.split(' ')[0]!, 10) / 1024);
          const usedMb = totalMb - availableMb;
          const utilizationPercent = (usedMb / totalMb) * 100;

          util['total_mb'] = totalMb;
          util['used_mb'] = usedMb;
          util['available_mb'] = availableMb;
          util['utilization_percent'] = Math.round(utilizationPercent * 10) / 10;

          if (utilizationPercent > 95) {
            if (overallStatus === 'healthy') overallStatus = 'critical';
            memoryIssues.push(`Critical memory utilization: ${utilizationPercent.toFixed(1)}%`);
          } else if (utilizationPercent > 90) {
            if (overallStatus === 'healthy') overallStatus = 'warning';
            memoryWarnings.push(`High memory utilization: ${utilizationPercent.toFixed(1)}%`);
          } else if (utilizationPercent > 80) {
            memoryWarnings.push(`Elevated memory utilization: ${utilizationPercent.toFixed(1)}%`);
          }
        } catch (error) {
          logger.trace('meminfo utilization parse failed', { error: getErrorMessage(error) });
        }
      }
    }
  } catch (error) {
    util['error'] = getErrorMessage(error);
  }

  try {
    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const { errors: memoryErrors, critical: criticalErrors } = matchMemoryDmesgErrors(dmesgOutput);

      if (memoryErrors.length > 0) {
        errs['dmesg_errors'] = memoryErrors.slice(-10);
        errs['total_error_count'] = memoryErrors.length;

        if (criticalErrors.length > 0) {
          overallStatus = 'critical';
          memoryIssues.push(`Critical memory errors found: ${criticalErrors.length} errors`);
        } else if (memoryErrors.length > 10) {
          if (overallStatus === 'healthy') overallStatus = 'warning';
          memoryWarnings.push(`Multiple memory errors detected: ${memoryErrors.length} errors`);
        } else if (memoryErrors.length > 0) {
          memoryWarnings.push(`Memory errors detected: ${memoryErrors.length} errors`);
        }
      } else {
        errs['dmesg_errors'] = [];
        errs['total_error_count'] = 0;
      }
    }
  } catch (error) {
    errs['error'] = getErrorMessage(error);
  }

  try {
    const lshwOutput = await sh('lshw -c memory', TIMEOUT_MS);
    if (lshwOutput) {
      ctrl['lshw_output'] = lshwOutput.trim();

      if (lshwOutput.toLowerCase().includes('memory')) {
        if (lshwOutput.toLowerCase().includes('size:')) {
          ctrl['controller_detected'] = true;
        }
        if (lshwOutput.toLowerCase().includes('width:')) {
          for (const line of lshwOutput.split('\n')) {
            if (line.toLowerCase().includes('width:')) {
              ctrl['bus_width'] = line.trim();
            }
          }
        }
      }
    }
  } catch (error) {
    ctrl['error'] = getErrorMessage(error);
  }

  const recommendations: string[] = [];
  if (memoryIssues.length > 0) {
    recommendations.push('Immediate attention required - memory hardware issues detected');
    if (memoryIssues.some((i) => i.toLowerCase().includes('uncorrectable'))) {
      recommendations.push('Replace faulty memory modules immediately');
    }
    if (memoryIssues.some((i) => i.toLowerCase().includes('utilization'))) {
      recommendations.push('Add more memory or reduce memory usage');
    }
  } else if (memoryWarnings.length > 0) {
    recommendations.push('Monitor memory health closely');
    if (memoryWarnings.some((w) => w.toLowerCase().includes('ecc'))) {
      recommendations.push('Monitor ECC error rates - possible memory degradation');
    }
    if (memoryWarnings.some((w) => w.toLowerCase().includes('utilization'))) {
      recommendations.push('Consider memory expansion for optimal performance');
    }
  } else {
    recommendations.push('Memory health appears normal');
  }

  const health_assessment: HealthSection = {
    overall_status: overallStatus,
    issues: memoryIssues,
    warnings: memoryWarnings,
    checks_performed: [
      'ECC error monitoring',
      'DIMM configuration analysis',
      'Memory utilization assessment',
      'System error log analysis',
      'Memory controller detection',
    ],
    recommendations,
  };

  return {
    memory: {
      status: overallStatus,
      ecc_status: ecc,
      memory_errors: errs,
      memory_controller: ctrl,
      dimm_details: dimm,
      memory_utilization: util,
      health_assessment,
    },
  };
}

export function registerMemoryDiagnostic(): void {
  registerOperation('diagnostic.memory', async () => runMemoryDiagnostic());
}
