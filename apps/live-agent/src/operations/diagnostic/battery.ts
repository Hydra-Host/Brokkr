import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { fileExists, parseSlashDate, readFile, runStrict, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.battery');

const TIMEOUT_MS = 60_000;

const parseApcDate = parseSlashDate;

interface BatterySections {
  upsBatteries: HealthSection;
  laptopBatteries: HealthSection;
  batteryChemistry: HealthSection;
  capacityAnalysis: HealthSection;
  lifecycleAssessment: HealthSection;
}

async function checkApcUps(
  sections: BatterySections,
  overallStatusRef: { value: 'healthy' | 'warning' | 'critical' },
  batteryIssues: string[],
  batteryWarnings: string[],
): Promise<void> {
  try {
    const apcOutput = await sh('apcaccess', TIMEOUT_MS);
    if (!apcOutput || !apcOutput.includes('STATUS')) return;

    const batteryData: Record<string, string> = {};
    for (const line of apcOutput.split('\n')) {
      if (line.includes(':')) {
        const [keyRaw, valueRaw] = line.split(/:(.*)/s);
        batteryData[keyRaw!.trim()] = (valueRaw ?? '').trim();
      }
    }

    const healthMetrics: HealthSection = {};
    const capacityAssessment: HealthSection = {};
    const replacementIndicators: string[] = [];

    if ('BCHARGE' in batteryData) {
      try {
        const charge = parseFloat(batteryData['BCHARGE']!.replace('%', ''));
        healthMetrics['charge_percent'] = charge;
        if (charge < 10) {
          overallStatusRef.value = 'critical';
          batteryIssues.push(`UPS battery critically low: ${charge}%`);
        } else if (charge < 30) {
          if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
          batteryWarnings.push(`UPS battery low: ${charge}%`);
        }
      } catch (error) {
        logger.trace('apcaccess BCHARGE parse failed', { error: getErrorMessage(error) });
      }
    }

    if ('BATTV' in batteryData) {
      try {
        const voltage = parseFloat(batteryData['BATTV']!.replace('V', ''));
        healthMetrics['voltage'] = voltage;
        if (voltage < 10.5) {
          batteryIssues.push(`UPS battery voltage critical: ${voltage}V`);
          replacementIndicators.push('Low voltage indicates battery degradation');
        } else if (voltage < 11.5) {
          batteryWarnings.push(`UPS battery voltage low: ${voltage}V`);
        }
      } catch (error) {
        logger.trace('apcaccess BATTV parse failed', { error: getErrorMessage(error) });
      }
    }

    if ('TIMELEFT' in batteryData) {
      try {
        const runtimeStr = batteryData['TIMELEFT']!.replace('Minutes', '').trim();
        const runtimeMin = parseFloat(runtimeStr);
        healthMetrics['runtime_minutes'] = runtimeMin;
        if (runtimeMin < 5) {
          batteryIssues.push(`UPS runtime critically low: ${runtimeMin} minutes`);
          replacementIndicators.push('Very short runtime indicates battery failure');
        } else if (runtimeMin < 15) {
          batteryWarnings.push(`UPS runtime low: ${runtimeMin} minutes`);
          replacementIndicators.push('Short runtime may indicate aging battery');
        }
      } catch (error) {
        logger.trace('apcaccess TIMELEFT parse failed', { error: getErrorMessage(error) });
      }
    }

    if ('ITEMP' in batteryData) {
      try {
        const tempStr = batteryData['ITEMP']!.replace('C', '').trim();
        const temp = parseFloat(tempStr);
        healthMetrics['internal_temperature_c'] = temp;
        if (temp > 50) {
          batteryIssues.push(`UPS internal temperature critical: ${temp} C`);
        } else if (temp > 40) {
          batteryWarnings.push(`UPS internal temperature high: ${temp} C`);
        }
      } catch (error) {
        logger.trace('apcaccess ITEMP parse failed', { error: getErrorMessage(error) });
      }
    }

    const model = batteryData['MODEL'] ?? '';
    if (model) {
      sections.batteryChemistry['apc_model'] = model;
    }
    const nombattv = batteryData['NOMBATTV'] ?? '';
    if (nombattv) {
      sections.batteryChemistry['nominal_voltage'] = nombattv;
    }

    if ('LINEV' in batteryData) {
      healthMetrics['line_voltage'] = batteryData['LINEV'];
    }
    if ('LOADPCT' in batteryData) {
      healthMetrics['load_percent'] = batteryData['LOADPCT'];
    }

    if ('NOMBATTV' in batteryData && 'BATTV' in batteryData) {
      try {
        const nominal = parseFloat(batteryData['NOMBATTV']!.replace('V', '').trim());
        const actual = parseFloat(batteryData['BATTV']!.replace('V', '').trim());
        if (nominal > 0) {
          const ratio = (actual / nominal) * 100;
          sections.capacityAnalysis['voltage_ratio_pct'] = Math.round(ratio * 10) / 10;
          if (ratio < 70) {
            batteryIssues.push(`Battery capacity severely degraded: ${ratio.toFixed(1)}% of nominal`);
            replacementIndicators.push('Battery voltage well below nominal - replace battery');
          } else if (ratio < 85) {
            batteryWarnings.push(`Battery capacity declining: ${ratio.toFixed(1)}% of nominal`);
          }
        }
      } catch (error) {
        logger.trace('apcaccess battery voltage ratio parse failed', { error: getErrorMessage(error) });
      }
    }

    const lifecycle: HealthSection = {};

    const battdate = batteryData['BATTDATE'] ?? '';
    if (battdate) {
      lifecycle['last_replacement'] = battdate;
      const batteryDate = parseApcDate(battdate);
      if (batteryDate) {
        const ageYears = (Date.now() - batteryDate.getTime()) / 86400000 / 365.25;
        lifecycle['age_years'] = Math.round(ageYears * 10) / 10;
        if (ageYears > 5) {
          batteryWarnings.push(`UPS battery very old: ${ageYears.toFixed(1)} years`);
          replacementIndicators.push('Battery age exceeds typical lifespan');
        } else if (ageYears > 3) {
          batteryWarnings.push(`UPS battery aging: ${ageYears.toFixed(1)} years`);
          replacementIndicators.push('Consider battery replacement planning');
        }
      }
    }

    const mandate = batteryData['MANDATE'] ?? '';
    if (mandate) lifecycle['manufacture_date'] = mandate;

    const numxfers = batteryData['NUMXFERS'] ?? '';
    if (numxfers) {
      try {
        const xferCount = Number.parseInt(numxfers, 10);
        lifecycle['transfer_count'] = xferCount;
        if (xferCount > 50) {
          batteryWarnings.push(`High transfer count: ${xferCount} transfers`);
          replacementIndicators.push('Many power transfers stress the battery');
        }
      } catch (error) {
        logger.trace('apcaccess NUMXFERS parse failed', { error: getErrorMessage(error) });
      }
    }

    const tonbatt = batteryData['TONBATT'] ?? '';
    if (tonbatt) lifecycle['time_on_battery_seconds'] = tonbatt;

    const cumonbatt = batteryData['CUMONBATT'] ?? '';
    if (cumonbatt) {
      try {
        const cumSecondsStr = cumonbatt.replace('Seconds', '').trim();
        const cumSeconds = parseFloat(cumSecondsStr);
        lifecycle['cumulative_battery_seconds'] = cumSeconds;
        const cumHours = cumSeconds / 3600;
        lifecycle['cumulative_battery_hours'] = Math.round(cumHours * 10) / 10;
        if (cumHours > 100) {
          batteryWarnings.push(`High cumulative battery time: ${cumHours.toFixed(1)} hours`);
          replacementIndicators.push('Extensive battery runtime accelerates degradation');
        }
      } catch (error) {
        logger.trace('apcaccess CUMONBATT parse failed', { error: getErrorMessage(error) });
      }
    }

    if (Object.keys(lifecycle).length > 0) {
      Object.assign(sections.lifecycleAssessment, lifecycle);
    }

    if ('SELFTEST' in batteryData) {
      const testResult = batteryData['SELFTEST']!;
      capacityAssessment['last_self_test'] = testResult;
      if (testResult.toUpperCase().includes('FAIL')) {
        if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'critical';
        batteryIssues.push(`UPS self-test failed: ${testResult}`);
        replacementIndicators.push('Self-test failure indicates battery replacement needed');
      } else if (testResult.toUpperCase().includes('WARN')) {
        if (overallStatusRef.value === 'healthy') overallStatusRef.value = 'warning';
        batteryWarnings.push(`UPS self-test warning: ${testResult}`);
      }
    }

    if ('STATUS' in batteryData) {
      healthMetrics['status'] = batteryData['STATUS'];
      const statusValue = batteryData['STATUS']!;
      if (!['ONLINE', 'ONLINE '].includes(statusValue)) {
        if (['ONBATT', 'BATTERY', 'LOWBATT', 'LB'].includes(statusValue.trim())) {
          overallStatusRef.value = 'critical';
          batteryIssues.push(`UPS not online: ${statusValue.trim()}`);
        }
      }
    }

    const upsAnalysis: HealthSection = {
      raw_data: batteryData,
      health_metrics: healthMetrics,
      capacity_assessment: capacityAssessment,
      replacement_indicators: replacementIndicators,
    };
    if (Object.keys(lifecycle).length > 0) {
      upsAnalysis['lifecycle_assessment'] = lifecycle;
    }
    sections.upsBatteries['apc_ups'] = upsAnalysis;
  } catch (error) {
    sections.upsBatteries['error'] = getErrorMessage(error);
  }
}

async function checkGenericUps(sections: BatterySections, batteryWarnings: string[]): Promise<void> {
  try {
    const upscList = await sh('upsc -l', TIMEOUT_MS);
    if (!upscList || !upscList.trim()) return;

    const upsNames = upscList.trim().split('\n');
    for (const rawName of upsNames.slice(0, 2)) {
      const upsName = rawName.trim();
      if (!upsName) continue;

      let upsDetail: string | undefined;
      try {
        upsDetail = await runStrict('upsc', [upsName], TIMEOUT_MS);
      } catch {
        continue;
      }
      if (!upsDetail) continue;

      const rawData: Record<string, string> = { name: upsName };
      for (const line of upsDetail.split('\n')) {
        if (line.includes(':')) {
          const [keyRaw, valueRaw] = line.split(/:(.*)/s);
          rawData[keyRaw!.trim()] = (valueRaw ?? '').trim();
        }
      }

      const healthIndicators: HealthSection = {};
      const replacementAssessment: string[] = [];

      if ('battery.charge' in rawData) {
        try {
          const charge = parseFloat(rawData['battery.charge']!);
          healthIndicators['charge_percent'] = charge;
          if (charge < 20) {
            batteryWarnings.push(`UPS ${upsName} low charge: ${charge}%`);
          }
        } catch (error) {
          logger.trace('upsc battery.charge parse failed', { ups: upsName, error: getErrorMessage(error) });
        }
      }

      if ('battery.runtime' in rawData) {
        try {
          const runtimeSeconds = parseFloat(rawData['battery.runtime']!);
          const runtimeMinutes = runtimeSeconds / 60;
          healthIndicators['runtime_minutes'] = Math.round(runtimeMinutes * 10) / 10;
          if (runtimeMinutes < 10) {
            replacementAssessment.push('Very short runtime indicates battery degradation');
          }
        } catch (error) {
          logger.trace('upsc battery.runtime parse failed', { ups: upsName, error: getErrorMessage(error) });
        }
      }

      if ('battery.voltage' in rawData) {
        try {
          const voltage = parseFloat(rawData['battery.voltage']!);
          healthIndicators['voltage'] = voltage;
        } catch (error) {
          logger.trace('upsc battery.voltage parse failed', { ups: upsName, error: getErrorMessage(error) });
        }
      }

      if ('battery.type' in rawData) {
        healthIndicators['chemistry'] = rawData['battery.type'];
        sections.batteryChemistry[upsName] = rawData['battery.type'];
      }

      const batteryAnalysis: HealthSection = {
        raw_data: rawData,
        health_indicators: healthIndicators,
        replacement_assessment: replacementAssessment,
      };
      sections.upsBatteries[upsName] = batteryAnalysis;
    }
  } catch (error) {
    logger.debug('upsc battery probe failed', { error: getErrorMessage(error) });
  }
}

async function checkLaptopBatteries(sections: BatterySections, batteryWarnings: string[]): Promise<void> {
  try {
    const lsOutput = await sh('ls /sys/class/power_supply/', TIMEOUT_MS);
    if (!lsOutput) return;

    const batteryDirs: string[] = [];
    for (const entry of lsOutput.trim().split(/\s+/)) {
      if (entry.startsWith('BAT')) batteryDirs.push(entry);
    }

    for (const batteryName of batteryDirs.slice(0, 3)) {
      const basePath = `/sys/class/power_supply/${batteryName}`;
      const laptopBattery: HealthSection = { path: basePath };

      const ueventPath = `${basePath}/uevent`;
      try {
        if (await fileExists(ueventPath)) {
          const ueventContent = await readFile(ueventPath);
          if (ueventContent) {
            const ueventData: Record<string, string> = {};
            for (const line of ueventContent.trim().split('\n')) {
              if (line.includes('=')) {
                const [k, v] = line.split(/=(.*)/s);
                ueventData[k!.trim()] = (v ?? '').trim();
              }
            }
            laptopBattery['uevent'] = ueventData;

            if ('POWER_SUPPLY_CAPACITY' in ueventData) {
              try {
                const capacity = Number.parseInt(ueventData['POWER_SUPPLY_CAPACITY']!, 10);
                laptopBattery['charge_percent'] = capacity;
                if (capacity < 20) {
                  batteryWarnings.push(`Laptop battery ${batteryName} low: ${capacity}%`);
                }
              } catch (error) {
                logger.trace('battery uevent capacity parse failed', {
                  battery: batteryName,
                  error: getErrorMessage(error),
                });
              }
            }

            if ('POWER_SUPPLY_STATUS' in ueventData) {
              laptopBattery['status'] = ueventData['POWER_SUPPLY_STATUS'];
            }

            if ('POWER_SUPPLY_HEALTH' in ueventData) {
              const health = ueventData['POWER_SUPPLY_HEALTH']!;
              laptopBattery['health'] = health;
              if (health !== 'Good') {
                batteryWarnings.push(`Laptop battery ${batteryName} health: ${health}`);
              }
            }

            const designCap =
              ueventData['POWER_SUPPLY_ENERGY_FULL_DESIGN'] ?? ueventData['POWER_SUPPLY_CHARGE_FULL_DESIGN'] ?? '';
            const actualCap = ueventData['POWER_SUPPLY_ENERGY_FULL'] ?? ueventData['POWER_SUPPLY_CHARGE_FULL'] ?? '';
            if (designCap && actualCap) {
              try {
                const d = parseFloat(designCap);
                const a = parseFloat(actualCap);
                if (d > 0) {
                  const wearPct = (a / d) * 100;
                  laptopBattery['capacity_pct_of_design'] = Math.round(wearPct * 10) / 10;
                  if (wearPct < 70) {
                    batteryWarnings.push(
                      `Laptop battery ${batteryName} degraded: ${wearPct.toFixed(1)}% of design capacity`,
                    );
                  }
                }
              } catch (error) {
                logger.trace('battery design capacity parse failed', {
                  battery: batteryName,
                  error: getErrorMessage(error),
                });
              }
            }
          }
        }
      } catch (error) {
        logger.trace('battery uevent read failed', { path: ueventPath, error: getErrorMessage(error) });
      }

      if (!('charge_percent' in laptopBattery)) {
        try {
          const capContent = await readFile(`${basePath}/capacity`);
          if (capContent) {
            const capacity = Number.parseInt(capContent.trim(), 10);
            laptopBattery['charge_percent'] = capacity;
            if (capacity < 20) {
              batteryWarnings.push(`Laptop battery ${batteryName} low: ${capacity}%`);
            }
          }
        } catch (error) {
          logger.trace('battery capacity read failed', { battery: batteryName, error: getErrorMessage(error) });
        }
      }

      if (!('status' in laptopBattery)) {
        try {
          const statusContent = await readFile(`${basePath}/status`);
          if (statusContent) laptopBattery['status'] = statusContent.trim();
        } catch (error) {
          logger.trace('battery status read failed', { battery: batteryName, error: getErrorMessage(error) });
        }
      }

      if (!('health' in laptopBattery)) {
        try {
          const healthContent = await readFile(`${basePath}/health`);
          if (healthContent) {
            const health = healthContent.trim();
            laptopBattery['health'] = health;
            if (health !== 'Good') {
              batteryWarnings.push(`Laptop battery ${batteryName} health: ${health}`);
            }
          }
        } catch (error) {
          logger.trace('battery health read failed', { battery: batteryName, error: getErrorMessage(error) });
        }
      }

      sections.laptopBatteries[batteryName] = laptopBattery;
    }
  } catch (error) {
    logger.debug('laptop battery scan failed', { error: getErrorMessage(error) });
  }
}

function buildRecommendations(sections: BatterySections, batteryIssues: string[], batteryWarnings: string[]): string[] {
  const recommendations: string[] = [];
  if (batteryIssues.length > 0) {
    recommendations.push('Battery issues detected - immediate attention required');
    if (batteryIssues.some((i) => i.toLowerCase().includes('critical'))) {
      recommendations.push('Replace failing batteries immediately');
    }
    if (batteryIssues.some((i) => i.toLowerCase().includes('voltage'))) {
      recommendations.push('Battery voltage indicates hardware failure');
    }
  } else if (batteryWarnings.length > 0) {
    recommendations.push('Monitor battery health closely');
    if (batteryWarnings.some((w) => w.toLowerCase().includes('age') || w.toLowerCase().includes('old'))) {
      recommendations.push('Plan for battery replacement due to age');
    }
    if (batteryWarnings.some((w) => w.toLowerCase().includes('runtime'))) {
      recommendations.push('Battery capacity declining - consider replacement');
    }
    if (batteryWarnings.some((w) => w.toLowerCase().includes('charge'))) {
      recommendations.push('Check charging systems and battery health');
    }
  } else {
    const upsCount = Object.keys(sections.upsBatteries).length;
    const laptopCount = Object.keys(sections.laptopBatteries).length;
    if (upsCount === 0 && laptopCount === 0) {
      recommendations.push('No batteries detected for monitoring');
    } else {
      recommendations.push('Battery systems appear healthy');
    }
  }
  return recommendations;
}

export async function runBatteryDiagnostic(): Promise<{ battery: Record<string, unknown> }> {
  const sections: BatterySections = {
    upsBatteries: {},
    laptopBatteries: {},
    batteryChemistry: {},
    capacityAnalysis: {},
    lifecycleAssessment: {},
  };

  const overallStatusRef: { value: 'healthy' | 'warning' | 'critical' } = { value: 'healthy' };
  const batteryIssues: string[] = [];
  const batteryWarnings: string[] = [];

  await checkApcUps(sections, overallStatusRef, batteryIssues, batteryWarnings);
  await checkGenericUps(sections, batteryWarnings);
  await checkLaptopBatteries(sections, batteryWarnings);

  const health_assessment: HealthSection = {
    overall_status: overallStatusRef.value,
    issues: batteryIssues,
    warnings: batteryWarnings,
    ups_batteries_detected: Object.keys(sections.upsBatteries).length,
    laptop_batteries_detected: Object.keys(sections.laptopBatteries).length,
    checks_performed: [
      'UPS battery capacity analysis',
      'Battery voltage assessment',
      'Runtime evaluation',
      'Battery age/lifecycle analysis',
      'Self-test result evaluation',
      'Laptop battery monitoring',
    ],
    recommendations: buildRecommendations(sections, batteryIssues, batteryWarnings),
  };

  return {
    battery: {
      status: overallStatusRef.value,
      timestamp: new Date().toISOString(),
      ups_batteries: sections.upsBatteries,
      laptop_batteries: sections.laptopBatteries,
      battery_chemistry: sections.batteryChemistry,
      capacity_analysis: sections.capacityAnalysis,
      lifecycle_assessment: sections.lifecycleAssessment,
      health_assessment,
    },
  };
}

export function registerBatteryDiagnostic(): void {
  registerOperation('diagnostic.battery', async () => runBatteryDiagnostic());
}
