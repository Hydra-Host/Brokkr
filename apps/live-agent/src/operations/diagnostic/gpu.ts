import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { sh } from './utils';

const logger = makeLogger('diagnostic.gpu');

const TIMEOUT_MS = 60_000;

interface DeviceData {
  index: string;
  name: string;
  temperature: number | null;
  utilization: number | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
  status: string;
  issues?: string[];
  warnings?: string[];
  power_usage_percentage?: number;
  memory_usage_percentage?: number;
}

function parseInt10(s: string): number | null {
  return /^\d+$/.test(s) ? Number.parseInt(s, 10) : null;
}

function parseFloatStrict(s: string): number | null {
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

export async function runGpuDiagnostic(): Promise<{ gpu: Record<string, unknown> }> {
  const gpuHealth: Record<string, unknown> = {};
  let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  const gpuIssues: string[] = [];
  const gpuWarnings: string[] = [];

  const nvidiaGpus: string[] = [];
  try {
    const lspciOutput = await sh('lspci', TIMEOUT_MS);
    if (lspciOutput) {
      for (const line of lspciOutput.split('\n')) {
        if (line.includes('NVIDIA') || line.includes('GeForce') || line.includes('Quadro') || line.includes('Tesla')) {
          nvidiaGpus.push(line.trim());
        }
      }
    }
    gpuHealth['detected_nvidia_gpus'] = nvidiaGpus;
    gpuHealth['device_count'] = nvidiaGpus.length;

    if (nvidiaGpus.length === 0) {
      return {
        gpu: {
          status: 'unavailable',
          message: 'No NVIDIA GPUs detected via lspci',
          gpu_data: gpuHealth,
          setup_required: false,
        },
      };
    }
  } catch (error) {
    return {
      gpu: {
        status: 'unavailable',
        error: `GPU detection failed: ${getErrorMessage(error)}`,
      },
    };
  }

  try {
    const nvidiaSmiOutput = await sh(
      'nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit --format=csv,noheader,nounits',
      TIMEOUT_MS,
    );

    if (nvidiaSmiOutput) {
      const devices: Record<string, DeviceData> = {};
      const lines = nvidiaSmiOutput.trim().split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;

        const parts = line.split(',').map((p) => p.trim());
        if (parts.length < 8) continue;
        const idx = parts[0]!;
        const name = parts[1]!;
        const temp = parts[2]!;
        const util = parts[3]!;
        const memUsed = parts[4]!;
        const memTotal = parts[5]!;
        const powerDraw = parts[6]!;
        const powerLimit = parts[7]!;

        const deviceData: DeviceData = {
          index: idx,
          name,
          temperature: parseInt10(temp),
          utilization: parseInt10(util),
          memory_used_mb: parseInt10(memUsed),
          memory_total_mb: parseInt10(memTotal),
          power_draw_w: parseFloatStrict(powerDraw),
          power_limit_w: parseFloatStrict(powerLimit),
          status: 'healthy',
        };

        const issues: string[] = [];
        const warnings: string[] = [];

        if (deviceData.temperature !== null) {
          const temp = deviceData.temperature;
          if (temp > 90) {
            deviceData.status = 'critical';
            issues.push(`Critical temperature: ${temp}\u00b0C`);
          } else if (temp > 85) {
            deviceData.status = 'warning';
            warnings.push(`High temperature: ${temp}\u00b0C`);
          } else if (temp > 80) {
            warnings.push(`Elevated temperature: ${temp}\u00b0C`);
          }
        }

        if (deviceData.power_draw_w && deviceData.power_limit_w) {
          const powerPct = (deviceData.power_draw_w / deviceData.power_limit_w) * 100;
          deviceData.power_usage_percentage = Math.round(powerPct * 10) / 10;
          if (powerPct > 95) {
            warnings.push(`High power usage: ${powerPct.toFixed(1)}%`);
          }
        }

        if (deviceData.memory_used_mb && deviceData.memory_total_mb) {
          const memPct = (deviceData.memory_used_mb / deviceData.memory_total_mb) * 100;
          deviceData.memory_usage_percentage = Math.round(memPct * 10) / 10;
          if (memPct > 95) {
            warnings.push(`High memory usage: ${memPct.toFixed(1)}%`);
          }
        }

        deviceData.issues = issues;
        deviceData.warnings = warnings;
        devices[`gpu_${i}`] = deviceData;

        if (issues.length > 0) {
          overallStatus = 'critical';
          gpuIssues.push(...issues);
        } else if (warnings.length > 0 && overallStatus === 'healthy') {
          overallStatus = 'warning';
          gpuWarnings.push(...warnings);
        }
      }

      gpuHealth['devices'] = devices;
    }

    try {
      const gpuListOutput = await sh('nvidia-smi -L', TIMEOUT_MS);
      if (gpuListOutput) {
        gpuHealth['gpu_list'] = gpuListOutput.trim();
      }
    } catch (error) {
      logger.debug('nvidia-smi -L failed', { error: getErrorMessage(error) });
    }
  } catch (error) {
    const errorStr = getErrorMessage(error);
    if (errorStr.toLowerCase().includes('not found') || errorStr.includes('No such file')) {
      return {
        gpu: {
          status: 'unavailable',
          message: 'NVIDIA drivers not installed or nvidia-smi not available',
          detected_nvidia_gpus: nvidiaGpus,
          setup_required: true,
          setup_instructions: {
            ubuntu_setup: [
              '1. Install NVIDIA drivers: sudo apt update && sudo apt install nvidia-driver-525',
              '2. Reboot the system: sudo reboot',
              '3. Verify installation: nvidia-smi',
              '4. For container support: sudo apt install nvidia-container-toolkit',
            ],
            verification_command: 'nvidia-smi',
          },
        },
      };
    }
    return {
      gpu: {
        status: 'unavailable',
        message: `NVIDIA tools error: ${errorStr}`,
        detected_nvidia_gpus: nvidiaGpus,
        setup_required: true,
        setup_instructions: {
          ubuntu_setup: [
            '1. Verify NVIDIA driver installation: nvidia-smi',
            '2. If command not found, install drivers: sudo apt install nvidia-driver-525',
            '3. Reboot system if new drivers installed',
            '4. Check GPU detection: lspci | grep -i nvidia',
          ],
        },
      },
    };
  }

  return {
    gpu: {
      status: overallStatus,
      gpu_data: gpuHealth,
      health_assessment: {
        issues: gpuIssues,
        warnings: gpuWarnings,
      },
    },
  };
}

export function registerGpuDiagnostic(): void {
  registerOperation('diagnostic.gpu', async () => runGpuDiagnostic());
}
