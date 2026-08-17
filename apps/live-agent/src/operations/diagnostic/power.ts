import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { runStrict, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.power');

const TIMEOUT_MS = 60_000;

const POWER_EVENT_REGEXES: RegExp[] = [
  /thermal shutdown/i,
  /critical temperature/i,
  /\bover[-\s]?current\b/i,
  /\bunder[-\s]?voltage\b/i,
  /\bover[-\s]?voltage\b/i,
  /(psu|power[_\s]supply)[^.]*(fail|failure|fault)/i,
  /\bon battery\b/i,
  /battery (critical|low)/i,
];

const POWER_CRITICAL_REGEXES: RegExp[] = [
  /thermal shutdown/i,
  /critical temperature/i,
  /\bover[-\s]?current\b/i,
  /\bunder[-\s]?voltage\b/i,
  /\bover[-\s]?voltage\b/i,
  /(psu|power[_\s]supply)[^.]*(fail|failure|fault)/i,
  /battery critical/i,
];

export function matchPowerDmesgEvents(dmesgOutput: string): { events: string[]; critical: string[] } {
  const events: string[] = [];
  for (const line of dmesgOutput.split('\n')) {
    if (POWER_EVENT_REGEXES.some((re) => re.test(line))) {
      events.push(line.trim());
    }
  }
  const critical = events.filter((e) => POWER_CRITICAL_REGEXES.some((re) => re.test(e)));
  return { events, critical };
}

async function checkGenericUps(
  upsStatus: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  powerIssues: string[],
): Promise<void> {
  try {
    const upscOutput = await sh('upsc -l', TIMEOUT_MS);
    if (upscOutput && upscOutput.trim()) {
      const upsNames = upscOutput.trim().split('\n');
      for (const rawName of upsNames.slice(0, 3)) {
        const upsName = rawName.trim();
        if (!upsName) continue;
        let upsDetail: string | undefined;
        try {
          upsDetail = await runStrict('upsc', [upsName], TIMEOUT_MS);
        } catch {
          continue;
        }
        if (upsDetail) {
          const upsData: Record<string, string> = { name: upsName };
          for (const line of upsDetail.split('\n')) {
            if (line.includes(':')) {
              const [keyRaw, valueRaw] = line.split(/:(.*)/s);
              const key = keyRaw!.trim();
              const value = (valueRaw ?? '').trim();
              if (['ups.status', 'battery.charge', 'ups.load'].includes(key)) {
                upsData[key] = value;
              }
            }
          }

          upsStatus[upsName] = upsData;

          const status = upsData['ups.status'];
          if (status) {
            if (status.includes('OB')) {
              if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
              powerIssues.push(`UPS ${upsName} on battery`);
            } else if (status.includes('LB')) {
              overallStatusRef.value = 'critical';
              powerIssues.push(`UPS ${upsName} low battery`);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.debug('upsc power probe failed', { error: getErrorMessage(error) });
  }
}

async function checkUps(
  upsStatus: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  powerIssues: string[],
  powerWarnings: string[],
): Promise<void> {
  try {
    const apcOutput = await sh('apcaccess', TIMEOUT_MS);
    if (apcOutput && apcOutput.includes('STATUS')) {
      const upsData: Record<string, string> = {};
      for (const line of apcOutput.split('\n')) {
        if (line.includes(':')) {
          const [keyRaw, valueRaw] = line.split(/:(.*)/s);
          const key = keyRaw!.trim();
          const value = (valueRaw ?? '').trim();
          if (['STATUS', 'LOADPCT', 'BCHARGE', 'TIMELEFT', 'BATTV', 'LINEV'].includes(key)) {
            upsData[key.toLowerCase()] = value;
          }
        }
      }

      upsStatus['apc'] = upsData;

      if (upsData['status']) {
        const status = upsData['status'];
        if (status !== 'ONLINE') {
          if (['ONBATT', 'BATTERY'].includes(status)) {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
            powerIssues.push(`UPS on battery power: ${status}`);
          } else if (['LOWBATT', 'LB'].includes(status)) {
            overallStatusRef.value = 'critical';
            powerIssues.push('UPS low battery critical');
          } else {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
            powerWarnings.push(`UPS status: ${status}`);
          }
        }
      }

      if (upsData['bcharge']) {
        try {
          const chargePct = parseFloat(upsData['bcharge'].replace('%', ''));
          if (chargePct < 20) {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
            powerIssues.push(`UPS battery critically low: ${chargePct}%`);
          } else if (chargePct < 50) {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
            powerWarnings.push(`UPS battery low: ${chargePct}%`);
          }
        } catch (error) {
          logger.trace('apcaccess bcharge parse failed', { error: getErrorMessage(error) });
        }
      }

      if (upsData['loadpct']) {
        try {
          const loadPct = parseFloat(upsData['loadpct'].replace('%', ''));
          if (loadPct > 90) {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
            powerWarnings.push(`UPS high load: ${loadPct}%`);
          }
        } catch (error) {
          logger.trace('apcaccess loadpct parse failed', { error: getErrorMessage(error) });
        }
      }
    } else {
      await checkGenericUps(upsStatus, overallStatusRef, powerIssues);
    }
  } catch (error) {
    upsStatus['error'] = getErrorMessage(error);
  }
}

async function checkSensors(
  voltageRails: HealthSection,
  powerConsumption: HealthSection,
  powerWarnings: string[],
): Promise<void> {
  try {
    const sensorsOutput = await sh('sensors', TIMEOUT_MS);
    if (sensorsOutput) {
      const voltageData: Record<string, Record<string, string>> = {};
      const powerData: Record<string, Record<string, string>> = {};

      let currentChip: string | null = null;
      for (const rawLine of sensorsOutput.split('\n')) {
        const stripped = rawLine.trim();

        if (stripped && !rawLine.startsWith(' ') && !stripped.includes(':')) {
          currentChip = stripped;
          voltageData[currentChip] = {};
          powerData[currentChip] = {};
        } else if (stripped.includes(':') && currentChip) {
          const [keyRaw, valueRaw] = stripped.split(/:(.*)/s);
          const key = keyRaw!.trim();
          const value = (valueRaw ?? '').trim();

          if (key.toLowerCase().includes('v') || key.toLowerCase().includes('volt')) {
            voltageData[currentChip]![key] = value;
            try {
              const voltageVal = parseFloat(value.split(/\s+/)[0]!.replace('+', ''));
              if (!Number.isNaN(voltageVal)) {
                if (key.includes('12V') || key.includes('12.0V')) {
                  if (voltageVal < 11.0 || voltageVal > 13.0) {
                    powerWarnings.push(`12V rail out of range: ${voltageVal}V`);
                  }
                } else if (key.includes('5V') || key.includes('5.0V')) {
                  if (voltageVal < 4.5 || voltageVal > 5.5) {
                    powerWarnings.push(`5V rail out of range: ${voltageVal}V`);
                  }
                } else if (key.includes('3.3V')) {
                  if (voltageVal < 3.0 || voltageVal > 3.6) {
                    powerWarnings.push(`3.3V rail out of range: ${voltageVal}V`);
                  }
                }
              }
            } catch (error) {
              logger.trace('sensors voltage parse failed', { error: getErrorMessage(error) });
            }
          } else if (key.toLowerCase().includes('power') || key.toLowerCase().includes('watt')) {
            powerData[currentChip]![key] = value;
          }
        }
      }

      voltageRails['sensors_data'] = voltageData;
      powerConsumption['sensors_data'] = powerData;
    }
  } catch {
    voltageRails['sensors_available'] = false;
    powerWarnings.push('sensors command not available - voltage monitoring unavailable');
  }
}

async function checkPsu(psuStatus: HealthSection, powerIssues: string[]): Promise<void> {
  try {
    const dmidecodeOutput = await sh('dmidecode -t 39', TIMEOUT_MS);
    if (dmidecodeOutput) {
      const psuInfo: Record<string, Record<string, string>> = {};
      let currentPsu: number | null = null;

      for (const rawLine of dmidecodeOutput.split('\n')) {
        const stripped = rawLine.trim();
        if (stripped.startsWith('System Power Supply')) {
          currentPsu = Object.keys(psuInfo).length;
          psuInfo[`psu_${currentPsu}`] = {};
        } else if (currentPsu !== null && stripped.includes(':')) {
          const [keyRaw, valueRaw] = stripped.split(/:(.*)/s);
          const key = keyRaw!.trim().toLowerCase().replace(/ /g, '_');
          const value = (valueRaw ?? '').trim();

          if (
            [
              'location',
              'name',
              'manufacturer',
              'serial_number',
              'asset_tag',
              'model_part_number',
              'revision',
              'max_power_capacity',
              'status',
              'supply_type',
              'input_voltage_range_switching',
            ].includes(key)
          ) {
            psuInfo[`psu_${currentPsu}`]![key] = value;

            if (key === 'status' && !['OK', 'Present', 'Unknown'].includes(value)) {
              powerIssues.push(`PSU ${currentPsu} status: ${value}`);
            }
          }
        }
      }

      psuStatus['dmidecode_psus'] = psuInfo;
      psuStatus['total_psus_detected'] = Object.keys(psuInfo).length;
    }
  } catch (error) {
    psuStatus['error'] = getErrorMessage(error);
  }
}

async function checkPowerEvents(
  powerEventsSection: HealthSection,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  powerIssues: string[],
  powerWarnings: string[],
): Promise<void> {
  try {
    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const { events: powerEvents, critical: criticalEvents } = matchPowerDmesgEvents(dmesgOutput);

      if (powerEvents.length > 0) {
        powerEventsSection['dmesg_events'] = powerEvents.slice(-10);
        powerEventsSection['total_events'] = powerEvents.length;

        if (criticalEvents.length > 0) {
          if (criticalEvents.length > 3) {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
            powerIssues.push(`Multiple critical power events: ${criticalEvents.length} events`);
          } else {
            if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
            powerWarnings.push(`Power events detected: ${criticalEvents.length} critical events`);
          }
        }
      } else {
        powerEventsSection['dmesg_events'] = [];
        powerEventsSection['total_events'] = 0;
      }
    }
  } catch (error) {
    powerEventsSection['error'] = getErrorMessage(error);
  }
}

function buildRecommendations(powerIssues: string[], powerWarnings: string[]): string[] {
  const recommendations: string[] = [];
  if (powerIssues.length > 0) {
    recommendations.push('Power issues detected - investigate immediately');
    if (powerIssues.some((i) => i.toLowerCase().includes('ups'))) {
      recommendations.push('Check UPS system and battery health');
    }
    if (powerIssues.some((i) => i.toLowerCase().includes('voltage') || i.toLowerCase().includes('rail'))) {
      recommendations.push('Check power supply voltage regulation');
    }
    if (powerIssues.some((i) => i.toLowerCase().includes('psu'))) {
      recommendations.push('Inspect power supply units for faults');
    }
  } else if (powerWarnings.length > 0) {
    recommendations.push('Monitor power systems closely');
    if (powerWarnings.some((w) => w.toLowerCase().includes('battery'))) {
      recommendations.push('Consider UPS battery replacement');
    }
    if (powerWarnings.some((w) => w.toLowerCase().includes('voltage'))) {
      recommendations.push('Monitor voltage rails for stability');
    }
  } else {
    recommendations.push('Power systems appear healthy');
  }
  return recommendations;
}

export async function runPowerDiagnostic(): Promise<{ power: Record<string, unknown> }> {
  const psuStatus: HealthSection = {};
  const voltageRails: HealthSection = {};
  const powerConsumption: HealthSection = {};
  const upsStatus: HealthSection = {};
  const powerEventsSection: HealthSection = {};

  const overallStatusRef: { value: 'healthy' | 'warning' | 'critical' } = { value: 'healthy' };
  const powerIssues: string[] = [];
  const powerWarnings: string[] = [];

  await checkUps(upsStatus, overallStatusRef, powerIssues, powerWarnings);
  await checkSensors(voltageRails, powerConsumption, powerWarnings);
  await checkPsu(psuStatus, powerIssues);
  await checkPowerEvents(powerEventsSection, overallStatusRef, powerIssues, powerWarnings);

  const health_assessment: HealthSection = {
    overall_status: overallStatusRef.value,
    issues: powerIssues,
    warnings: powerWarnings,
    checks_performed: [
      'UPS status monitoring',
      'Voltage rail assessment',
      'PSU configuration analysis',
      'Power consumption monitoring',
      'Power event log analysis',
    ],
    recommendations: buildRecommendations(powerIssues, powerWarnings),
  };

  return {
    power: {
      status: overallStatusRef.value,
      timestamp: new Date().toISOString(),
      psu_status: psuStatus,
      voltage_rails: voltageRails,
      power_consumption: powerConsumption,
      ups_status: upsStatus,
      power_events: powerEventsSection,
      health_assessment,
    },
  };
}

export function registerPowerDiagnostic(): void {
  registerOperation('diagnostic.power', async () => runPowerDiagnostic());
}
