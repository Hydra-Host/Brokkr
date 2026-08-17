import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { parseSlashDate, readFile, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.system');

const TIMEOUT_MS = 90_000;

const parseBiosDate = parseSlashDate;

async function checkEdac(
  mce: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  systemIssues: string[],
  systemWarnings: string[],
): Promise<void> {
  try {
    const edacOutput = await sh('edac-util -v', TIMEOUT_MS);
    if (edacOutput && !edacOutput.includes('No errors')) {
      const edacEvents: string[] = [];
      for (const line of edacOutput.split('\n')) {
        const lineLower = line.toLowerCase();
        if (
          line.trim() &&
          (lineLower.includes('error') || lineLower.includes('correctable') || lineLower.includes('uncorrectable'))
        ) {
          edacEvents.push(line.trim());
        }
      }

      mce['recent_events'] = edacEvents;
      mce['event_count'] = edacEvents.length;
      mce['tool_used'] = 'edac-utils';

      if (edacEvents.length > 0) {
        const uncorrectable = edacEvents.filter((e) => e.toLowerCase().includes('uncorrectable'));
        if (uncorrectable.length > 0) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
          systemIssues.push(`Uncorrectable ECC errors: ${uncorrectable.length} events`);
        } else if (edacEvents.length > 10) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
          systemWarnings.push(`Multiple ECC errors detected: ${edacEvents.length} events`);
        } else {
          systemWarnings.push(`ECC errors detected: ${edacEvents.length} events`);
        }
      }
    } else {
      mce['recent_events'] = [];
      mce['event_count'] = 0;
      mce['tool_used'] = 'edac-utils';
    }
  } catch {
    mce['tools_available'] = false;
    mce['message'] = 'Neither rasdaemon nor edac-utils available - MCE monitoring limited to dmesg';
  }
}

async function checkMce(
  mce: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  systemIssues: string[],
  systemWarnings: string[],
): Promise<void> {
  try {
    const rasOutput = await sh('ras-mc-ctl --errors', TIMEOUT_MS);
    if (rasOutput && rasOutput.trim()) {
      const mceEvents: string[] = [];
      for (const line of rasOutput.split('\n')) {
        if (line.trim() && !line.startsWith('ras-mc-ctl:')) {
          mceEvents.push(line.trim());
        }
      }

      mce['recent_events'] = mceEvents;
      mce['event_count'] = mceEvents.length;
      mce['tool_used'] = 'rasdaemon';

      if (mceEvents.length > 0) {
        const criticalKeywords = ['fatal', 'uncorrectable', 'panic', 'error', 'hardware error'];
        const criticalEvents = mceEvents.filter((e) => criticalKeywords.some((k) => e.toLowerCase().includes(k)));

        if (criticalEvents.length > 0) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
          systemIssues.push(`Critical machine check events: ${criticalEvents.length} events`);
        } else if (mceEvents.length > 5) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
          systemWarnings.push(`Multiple machine check events: ${mceEvents.length} events`);
        } else {
          systemWarnings.push(`Machine check events detected: ${mceEvents.length} events`);
        }
      }
    } else {
      mce['recent_events'] = [];
      mce['event_count'] = 0;
      mce['tool_used'] = 'rasdaemon';
    }
  } catch {
    await checkEdac(mce, overallStatusRef, systemIssues, systemWarnings);
  }
}

async function checkHardwareErrors(
  hwLogs: HealthSection,
  knLogs: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  systemIssues: string[],
  systemWarnings: string[],
): Promise<void> {
  try {
    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const hardwareErrorPatterns = [
        'hardware error',
        'mce:',
        'machine check',
        'edac',
        'ecc',
        'pci error',
        'ata error',
        'usb error',
        'i/o error',
        'firmware bug',
        'bios bug',
        'acpi error',
        'thermal',
        'cpu',
        'correctable',
        'uncorrectable',
        'fatal',
      ];

      const hardwareErrors: string[] = [];
      const kernelErrors: string[] = [];

      for (const line of dmesgOutput.split('\n')) {
        const lineLower = line.toLowerCase();
        for (const pattern of hardwareErrorPatterns) {
          if (lineLower.includes(pattern)) {
            if (['error', 'fatal', 'bug', 'mce'].some((c) => lineLower.includes(c))) {
              hardwareErrors.push(line.trim());
            } else {
              kernelErrors.push(line.trim());
            }
            break;
          }
        }
      }

      if (hardwareErrors.length > 0) {
        hwLogs['dmesg_errors'] = hardwareErrors.slice(-15);
        hwLogs['total_error_count'] = hardwareErrors.length;

        const fatalErrors = hardwareErrors.filter((e) =>
          ['fatal', 'panic', 'oops'].some((k) => e.toLowerCase().includes(k)),
        );
        if (fatalErrors.length > 0) {
          overallStatusRef.value = 'critical';
          systemIssues.push(`Fatal hardware errors detected: ${fatalErrors.length} errors`);
        } else if (hardwareErrors.length > 10) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
          systemIssues.push(`Multiple hardware errors: ${hardwareErrors.length} errors`);
        } else if (hardwareErrors.length > 5) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
          systemWarnings.push(`Hardware errors detected: ${hardwareErrors.length} errors`);
        }
      } else {
        hwLogs['dmesg_errors'] = [];
        hwLogs['total_error_count'] = 0;
      }

      if (kernelErrors.length > 0) {
        knLogs['dmesg_kernel_events'] = kernelErrors.slice(-10);
        knLogs['total_kernel_events'] = kernelErrors.length;

        if (kernelErrors.length > 20) {
          systemWarnings.push(`Many kernel events detected: ${kernelErrors.length} events`);
        }
      } else {
        knLogs['dmesg_kernel_events'] = [];
        knLogs['total_kernel_events'] = 0;
      }
    }
  } catch (error) {
    hwLogs['error'] = getErrorMessage(error);
  }
}

async function checkBios(bios: HealthSection, systemWarnings: string[]): Promise<void> {
  try {
    const biosOutput = await sh('dmidecode -t bios', TIMEOUT_MS);
    if (biosOutput) {
      const biosInfo: Record<string, string> = {};
      for (const rawLine of biosOutput.split('\n')) {
        const stripped = rawLine.trim();
        if (stripped.includes(':')) {
          const [keyRaw, valueRaw] = stripped.split(/:(.*)/s);
          const key = keyRaw!.trim().toLowerCase().replace(/ /g, '_');
          const value = (valueRaw ?? '').trim();

          if (['vendor', 'version', 'release_date', 'bios_revision', 'firmware_revision'].includes(key)) {
            biosInfo[key] = value;
          }
        }
      }

      bios['bios_info'] = biosInfo;

      if ('release_date' in biosInfo) {
        const biosDate = parseBiosDate(biosInfo['release_date']!);
        if (biosDate) {
          const ageYears = (Date.now() - biosDate.getTime()) / 86400000 / 365.25;
          bios['age_years'] = Math.round(ageYears * 10) / 10;
          if (ageYears > 5) {
            systemWarnings.push(`BIOS is old: ${ageYears.toFixed(1)} years`);
          }
        }
      }
    }

    try {
      const efiVars = await sh('efivar -l', TIMEOUT_MS);
      if (efiVars) {
        bios['efi_variables_available'] = true;
        bios['efi_variable_count'] = efiVars.split('\n').length;
      } else {
        bios['efi_variables_available'] = false;
      }
    } catch {
      bios['efi_variables_available'] = false;
    }
  } catch (error) {
    bios['error'] = getErrorMessage(error);
  }
}

async function checkStability(stab: HealthSection, systemWarnings: string[]): Promise<void> {
  try {
    try {
      const uptimeOutput = await readFile('/proc/uptime');
      if (uptimeOutput) {
        const uptimeSeconds = parseFloat(uptimeOutput.split(/\s+/)[0]!);
        if (!Number.isNaN(uptimeSeconds)) {
          const uptimeDays = uptimeSeconds / 86400;
          stab['uptime_days'] = Math.round(uptimeDays * 100) / 100;
          if (uptimeDays < 0.1) {
            systemWarnings.push(`Recent system restart: ${uptimeDays.toFixed(1)} days uptime`);
          }
        }
      }
    } catch (error) {
      logger.debug('uptime check failed', { path: '/proc/uptime', error: getErrorMessage(error) });
    }

    try {
      const loadavgOutput = await readFile('/proc/loadavg');
      if (loadavgOutput) {
        const loadParts = loadavgOutput.split(/\s+/);
        const load1min = parseFloat(loadParts[0]!);
        const load5min = parseFloat(loadParts[1]!);
        const load15min = parseFloat(loadParts[2]!);

        stab['load_averages'] = {
          '1min': load1min,
          '5min': load5min,
          '15min': load15min,
        };

        const cpuCountOutput = await sh('nproc', TIMEOUT_MS);
        if (cpuCountOutput) {
          const cpuCount = Number.parseInt(cpuCountOutput.trim(), 10);
          if (!Number.isNaN(cpuCount) && cpuCount > 0) {
            const loadPerCpu = load1min / cpuCount;

            if (loadPerCpu > 2.0) {
              systemWarnings.push(`High system load: ${loadPerCpu.toFixed(1)} per CPU`);
            } else if (loadPerCpu > 1.5) {
              systemWarnings.push(`Elevated system load: ${loadPerCpu.toFixed(1)} per CPU`);
            }
          }
        }
      }
    } catch (error) {
      logger.debug('loadavg check failed', { path: '/proc/loadavg', error: getErrorMessage(error) });
    }
  } catch (error) {
    stab['error'] = getErrorMessage(error);
  }
}

async function checkJournal(hwLogs: HealthSection, systemWarnings: string[]): Promise<void> {
  try {
    const journalOutput = await sh('journalctl -p err -n 20 --no-pager', TIMEOUT_MS);
    if (journalOutput) {
      const journalErrors: string[] = [];
      for (const line of journalOutput.split('\n')) {
        if (line.trim() && !line.startsWith('--')) {
          journalErrors.push(line.trim());
        }
      }

      hwLogs['journal_errors'] = journalErrors;
      hwLogs['journal_error_count'] = journalErrors.length;

      if (journalErrors.length > 10) {
        systemWarnings.push(`Many recent journal errors: ${journalErrors.length} errors`);
      }
    }
  } catch (error) {
    hwLogs['journal_error'] = getErrorMessage(error);
  }
}

function buildRecommendations(systemIssues: string[], systemWarnings: string[]): string[] {
  const recommendations: string[] = [];
  if (systemIssues.length > 0) {
    recommendations.push('Critical system issues detected - investigate immediately');
    if (systemIssues.some((i) => i.toLowerCase().includes('machine check'))) {
      recommendations.push('Hardware fault detected - check CPU, memory, and motherboard');
    }
    if (systemIssues.some((i) => i.toLowerCase().includes('hardware error'))) {
      recommendations.push('Hardware diagnostics recommended');
    }
    if (systemIssues.some((i) => i.toLowerCase().includes('fatal'))) {
      recommendations.push('System stability at risk - immediate maintenance required');
    }
  } else if (systemWarnings.length > 0) {
    recommendations.push('Monitor system health closely');
    if (systemWarnings.some((w) => w.toLowerCase().includes('bios'))) {
      recommendations.push('Consider BIOS/firmware update');
    }
    if (systemWarnings.some((w) => w.toLowerCase().includes('load'))) {
      recommendations.push('Monitor system performance and resource usage');
    }
    if (systemWarnings.some((w) => w.toLowerCase().includes('error'))) {
      recommendations.push('Review system logs for patterns');
    }
  } else {
    recommendations.push('System health appears stable');
  }
  return recommendations;
}

export async function runSystemDiagnostic(): Promise<{ system: Record<string, unknown> }> {
  const mce: HealthSection = {};
  const hwLogs: HealthSection = {};
  const bios: HealthSection = {};
  const knLogs: HealthSection = {};
  const stab: HealthSection = {};

  const overallStatusRef: { value: 'healthy' | 'warning' | 'critical' } = { value: 'healthy' };
  const systemIssues: string[] = [];
  const systemWarnings: string[] = [];

  await checkMce(mce, overallStatusRef, systemIssues, systemWarnings);
  await checkHardwareErrors(hwLogs, knLogs, overallStatusRef, systemIssues, systemWarnings);
  await checkBios(bios, systemWarnings);
  await checkStability(stab, systemWarnings);
  await checkJournal(hwLogs, systemWarnings);

  const health_assessment: HealthSection = {
    overall_status: overallStatusRef.value,
    issues: systemIssues,
    warnings: systemWarnings,
    checks_performed: [
      'Machine check event monitoring',
      'Hardware error log analysis',
      'BIOS/UEFI health assessment',
      'System stability indicators',
      'Kernel error detection',
    ],
    recommendations: buildRecommendations(systemIssues, systemWarnings),
  };

  return {
    system: {
      status: overallStatusRef.value,
      timestamp: new Date().toISOString(),
      machine_check_events: mce,
      hardware_error_logs: hwLogs,
      bios_health: bios,
      kernel_errors: knLogs,
      system_stability: stab,
      health_assessment,
    },
  };
}

export function registerSystemDiagnostic(): void {
  registerOperation('diagnostic.system', async () => runSystemDiagnostic());
}
