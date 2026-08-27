import { getErrorMessage } from '@repo/utils';
import { registerOperation } from '../../dispatch/registry';
import { makeLogger } from '../../logger';
import { readFile, sh, tryShell } from './utils';

const logger = makeLogger('diagnostic.thermal');

const TIMEOUT_MS = 60_000;

const THERMAL_THRESHOLDS: Record<string, { warning: number; critical: number }> = {
  cpu_temp: { warning: 80, critical: 90 },
  gpu_temp: { warning: 85, critical: 95 },
  motherboard_temp: { warning: 75, critical: 85 },
};

function assessHealth(thermalMetrics: Record<string, number>): {
  status: string;
  issues: string[];
  warnings: string[];
} {
  let status = 'healthy';
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const [metricName, value] of Object.entries(thermalMetrics)) {
    const metricLower = metricName.toLowerCase();
    for (const [thresholdKey, limits] of Object.entries(THERMAL_THRESHOLDS)) {
      const keyParts = thresholdKey.split('_');
      if (!keyParts.every((part) => metricLower.includes(part))) continue;

      if (value >= limits.critical) {
        status = 'critical';
        issues.push(`${metricName}: ${value}\u00b0C exceeds critical threshold (${limits.critical}\u00b0C)`);
      } else if (value >= limits.warning) {
        if (status === 'healthy') status = 'warning';
        warnings.push(`${metricName}: ${value}\u00b0C exceeds warning threshold (${limits.warning}\u00b0C)`);
      }
    }
  }

  return { status, issues, warnings };
}

async function parseSensors(
  thermalMetrics: Record<string, number>,
  fanStatus: Record<string, unknown>,
): Promise<Record<string, Record<string, { input: number }>>> {
  const sensorsData: Record<string, Record<string, { input: number }>> = {};

  let rawOutput: string | undefined;
  try {
    rawOutput = await sh('sensors -A', TIMEOUT_MS);
  } catch {
    return sensorsData;
  }
  if (!rawOutput) return sensorsData;

  let currentChip = 'unknown';

  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    if (!line.startsWith(' ') && !line.includes(':')) {
      currentChip = line.trim();
      if (!sensorsData[currentChip]) sensorsData[currentChip] = {};
      continue;
    }

    const tempMatch = line.match(/^\s*(.*?):\s*[+-]?([\d.]+)\s*°?\s*C/);
    const fanMatch = line.match(/^\s*(.*?):\s*([\d.]+)\s*RPM/);

    if (tempMatch) {
      const sensorName = tempMatch[1]!.trim();
      const tempVal = parseFloat(tempMatch[2]!);
      if (!sensorsData[currentChip]) sensorsData[currentChip] = {};
      sensorsData[currentChip]![sensorName] = { input: tempVal };
      thermalMetrics[`${currentChip}_${sensorName}`] = tempVal;
    } else if (fanMatch) {
      const sensorName = fanMatch[1]!.trim();
      const fanVal = parseFloat(fanMatch[2]!);
      if (!sensorsData[currentChip]) sensorsData[currentChip] = {};
      sensorsData[currentChip]![sensorName] = { input: fanVal };
      fanStatus[`${currentChip}_${sensorName}`] = fanVal;
    }
  }

  return sensorsData;
}

async function readAcpiFans(fanStatus: Record<string, unknown>, failedFans: string[]): Promise<void> {
  const fanDirs = await tryShell('ls -d /proc/acpi/fan/*/state 2>/dev/null || true', TIMEOUT_MS);
  if (!fanDirs || !fanDirs.trim()) return;

  for (const fanPathRaw of fanDirs.trim().split('\n')) {
    const fanPath = fanPathRaw.trim();
    if (!fanPath) continue;
    try {
      const fanStateRaw = await readFile(fanPath);
      const fanState = fanStateRaw.trim();
      const parts = fanPath.split('/');
      const fanName = parts.length >= 2 ? parts[parts.length - 2]! : 'unknown';
      fanStatus[`acpi_${fanName}`] = fanState;
      if (fanState.toLowerCase().includes('off')) {
        failedFans.push(`acpi_${fanName}`);
      }
    } catch (error) {
      logger.trace('acpi fan state read failed', { path: fanPath, error: getErrorMessage(error) });
    }
  }
}

export async function runThermalDiagnostic(): Promise<{ thermal: Record<string, unknown> }> {
  const thermalMetrics: Record<string, number> = {};
  const fanStatus: Record<string, unknown> = {};
  const highTemps: string[] = [];
  const failedFans: string[] = [];

  const sensorsData = await parseSensors(thermalMetrics, fanStatus);

  for (const [sensorKey, tempValue] of Object.entries(thermalMetrics)) {
    if (tempValue > 80) {
      highTemps.push(`${sensorKey}: ${tempValue}\u00b0C`);
    }
  }

  for (const [fanKey, fanSpeed] of Object.entries(fanStatus)) {
    if (typeof fanSpeed === 'number' && fanSpeed === 0) {
      failedFans.push(fanKey);
    }
  }

  await readAcpiFans(fanStatus, failedFans);

  const healthAssessment = assessHealth(thermalMetrics);

  if (highTemps.length > 0) {
    healthAssessment.warnings.push(...highTemps);
    if (healthAssessment.status === 'healthy') healthAssessment.status = 'warning';
  }

  if (failedFans.length > 0) {
    healthAssessment.issues.push(...failedFans.map((fan) => `Failed fan: ${fan}`));
    healthAssessment.status = 'critical';
  }

  return {
    thermal: {
      status: healthAssessment.status,
      sensors_data: sensorsData,
      thermal_metrics: thermalMetrics,
      fan_status: fanStatus,
      health_assessment: {
        high_temperatures: highTemps,
        failed_fans: failedFans,
        thermal_throttling: false,
      },
      issues: healthAssessment.issues,
      warnings: healthAssessment.warnings,
    },
  };
}

export function registerThermalDiagnostic(): void {
  registerOperation('diagnostic.thermal', async () => runThermalDiagnostic());
}
