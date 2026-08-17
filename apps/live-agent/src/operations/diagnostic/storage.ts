import { z } from 'zod';
import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { readFile, runStrict, sh, tryShell } from './utils';

const logger = makeLogger('diagnostic.storage');

const TIMEOUT_MS = 60_000;

const SmartRecord = z
  .object({
    temperature: z.union([z.number(), z.object({ current: z.number().optional() }).passthrough()]).optional(),
    power_on_time: z.union([z.number(), z.object({ hours: z.number().optional() }).passthrough()]).optional(),
    ata_smart_attributes: z
      .object({
        table: z
          .array(
            z
              .object({
                name: z.string().optional(),
                raw: z.object({ value: z.number().optional() }).passthrough().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    percentage_used: z.number().optional(),
    power_on_hours: z.number().optional(),
  })
  .passthrough();

async function listBlockDevices(): Promise<string[]> {
  const output = await tryShell('ls /dev/sd* /dev/nvme*n* 2>/dev/null || true', TIMEOUT_MS);
  if (!output || !output.trim()) return [];

  const devices: string[] = [];
  for (const devRaw of output.trim().split(/\s+/)) {
    const dev = devRaw.trim();
    if (!dev) continue;
    const base = dev.split('/').pop() ?? '';
    if (base.startsWith('sd') && base.length > 3) continue;
    if (base.startsWith('nvme') && base.includes('p')) continue;
    if (base.startsWith('sd') && base.length === 4 && /\d/.test(base[base.length - 1] ?? '')) {
      continue;
    }
    devices.push(dev);
  }

  return devices;
}

async function collectNvme(
  device: string,
  deviceHealth: Record<string, unknown>,
  wearWarnings: string[],
): Promise<void> {
  const result = await runStrict('nvme', ['smart-log', device, '--output-format=json'], TIMEOUT_MS);
  if (!result) return;

  const nvmeData = SmartRecord.parse(JSON.parse(result));
  deviceHealth['type'] = 'nvme';
  deviceHealth['smart_data'] = nvmeData;
  deviceHealth['temperature'] = typeof nvmeData.temperature === 'number' ? nvmeData.temperature : 0;
  deviceHealth['wear_level'] = nvmeData.percentage_used ?? 0;
  deviceHealth['power_on_hours'] = nvmeData.power_on_hours ?? 0;
  deviceHealth['status'] = 'healthy';

  const pctUsed = nvmeData.percentage_used ?? 0;
  if (pctUsed > 80) {
    wearWarnings.push(`${device}: ${pctUsed}% wear`);
  }
}

async function collectSata(
  device: string,
  deviceHealth: Record<string, unknown>,
  failingDrives: string[],
): Promise<void> {
  const result = await runStrict('smartctl', ['-A', '-j', device], TIMEOUT_MS);
  if (!result) return;

  const smartData = SmartRecord.parse(JSON.parse(result));
  deviceHealth['type'] = 'sata';
  deviceHealth['smart_data'] = smartData;
  deviceHealth['temperature'] = typeof smartData.temperature === 'object' ? (smartData.temperature.current ?? 0) : 0;
  deviceHealth['power_on_hours'] =
    typeof smartData.power_on_time === 'object' ? (smartData.power_on_time.hours ?? 0) : 0;
  deviceHealth['status'] = 'healthy';

  const attrs = smartData.ata_smart_attributes?.table ?? [];
  for (const attr of attrs) {
    if (attr.name === 'Reallocated_Sector_Ct') {
      const rawValue = attr.raw?.value ?? 0;
      if (rawValue > 0) {
        failingDrives.push(`${device}: ${rawValue} reallocated sectors`);
      }
    }
  }
}

async function checkRaid(): Promise<Record<string, unknown>> {
  const raidStatus: Record<string, unknown> = {};

  try {
    const raidOutput = await sh('mdadm --detail --scan 2>/dev/null || true', TIMEOUT_MS);
    if (raidOutput && raidOutput.trim()) {
      raidStatus['mdadm_scan'] = raidOutput.trim();
    }
  } catch (error) {
    logger.debug('mdadm scan failed', { error: getErrorMessage(error) });
  }

  try {
    const mdstatContent = await readFile('/proc/mdstat');
    if (mdstatContent) {
      raidStatus['mdstat'] = mdstatContent;
    }
  } catch (error) {
    logger.debug('mdstat read failed', { path: '/proc/mdstat', error: getErrorMessage(error) });
  }

  return raidStatus;
}

export async function runStorageDiagnostic(): Promise<{ storage: Record<string, unknown> }> {
  const storageHealth: Record<string, unknown> = {};
  const failingDrives: string[] = [];
  const wearWarnings: string[] = [];

  const devices = await listBlockDevices();

  for (const device of devices) {
    const deviceName = device.split('/').pop() ?? device;
    const deviceHealth: Record<string, unknown> = {
      device,
      type: 'unknown',
      status: 'unknown',
    };

    try {
      if (device.includes('nvme')) {
        await collectNvme(device, deviceHealth, wearWarnings);
      } else {
        await collectSata(device, deviceHealth, failingDrives);
      }
    } catch (error) {
      deviceHealth['error'] = getErrorMessage(error);
    }

    storageHealth[deviceName] = deviceHealth;
  }

  const raidStatus = await checkRaid();

  let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  if (failingDrives.length > 0) {
    overallStatus = 'critical';
  } else if (wearWarnings.length > 0) {
    overallStatus = 'warning';
  }

  return {
    storage: {
      status: overallStatus,
      devices: storageHealth,
      raid_status: raidStatus,
      health_assessment: {
        failing_drives: failingDrives,
        wear_warnings: wearWarnings,
        raid_issues: [],
      },
    },
  };
}

export function registerStorageDiagnostic(): void {
  registerOperation('diagnostic.storage', async () => runStorageDiagnostic());
}
