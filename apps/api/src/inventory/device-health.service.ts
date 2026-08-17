import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

export interface DeviceHealthStatus {
  isHealthy: boolean;
  reason?: string;
  lastChecked?: Date;
  checks?: {
    primaryReachable?: boolean | null;
    bmcIcmpReachable?: boolean | null;
    bmcIpmiReachable?: boolean | null;
    bmcRedfishReachable?: boolean | null;
    bmcCredsValid?: boolean | null;
    poweredOn?: boolean | null;
    brokkrLiveRunning?: boolean | null;
  };
}

@Injectable()
export class DeviceHealthService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DeviceHealthService.name) private readonly logger: LoggerService,
  ) {}

  async isDeviceHealthy(deviceId: string, ecoMode?: boolean) {
    try {
      const latestHealthCheck = await this.prisma.deviceHealthCheck.findFirst({
        where: { deviceId },
        orderBy: { testedAt: 'desc' },
        select: {
          primaryReachable: true,
          bmcIcmpReachable: true,
          bmcIpmiReachable: true,
          bmcRedfishReachable: true,
          bmcCredsValid: true,
          poweredOn: true,
          brokkrLiveRunning: true,
          testedAt: true,
        },
      });

      if (!latestHealthCheck) {
        return {
          isHealthy: true,
          reason: 'No health check data available (new inventory)',
        };
      }

      if (ecoMode === undefined) {
        const device = await this.prisma.device.findUnique({
          where: { id: deviceId },
          select: { server: { select: { ecoMode: true } } },
        });
        ecoMode = device?.server?.ecoMode ?? false;
      }

      const checks = {
        primaryReachable: latestHealthCheck.primaryReachable,
        bmcIcmpReachable: latestHealthCheck.bmcIcmpReachable,
        bmcIpmiReachable: latestHealthCheck.bmcIpmiReachable,
        bmcRedfishReachable: latestHealthCheck.bmcRedfishReachable,
        bmcCredsValid: latestHealthCheck.bmcCredsValid,
        poweredOn: latestHealthCheck.poweredOn,
        brokkrLiveRunning: latestHealthCheck.brokkrLiveRunning,
      };

      if (latestHealthCheck.bmcIcmpReachable !== true) {
        return {
          isHealthy: false,
          reason: 'BMC interface not reachable via ICMP',
          lastChecked: latestHealthCheck.testedAt,
          checks,
        };
      }

      if (latestHealthCheck.bmcIpmiReachable !== true) {
        return {
          isHealthy: false,
          reason: 'BMC not accessible via IPMI',
          lastChecked: latestHealthCheck.testedAt,
          checks,
        };
      }

      if (latestHealthCheck.bmcRedfishReachable !== true) {
        return {
          isHealthy: false,
          reason: 'BMC not accessible via Redfish API',
          lastChecked: latestHealthCheck.testedAt,
          checks,
        };
      }

      if (latestHealthCheck.bmcCredsValid !== true) {
        return {
          isHealthy: false,
          reason: 'BMC credentials are invalid',
          lastChecked: latestHealthCheck.testedAt,
          checks,
        };
      }

      if (!ecoMode) {
        if (latestHealthCheck.poweredOn !== true) {
          return {
            isHealthy: false,
            reason: 'Device is not powered on',
            lastChecked: latestHealthCheck.testedAt,
            checks,
          };
        }
      }

      return {
        isHealthy: true,
        lastChecked: latestHealthCheck.testedAt,
        checks,
      };
    } catch (error) {
      this.logger.error(`Error checking device health for ${deviceId}: ${(error as Error).message}`);
      return {
        isHealthy: false,
        reason: `Health check failed: ${(error as Error).message}`,
      };
    }
  }

  async checkDevicesHealth(deviceIds: string[]): Promise<Map<string, DeviceHealthStatus>> {
    const results = new Map<string, DeviceHealthStatus>();

    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds } },
      select: {
        id: true,
        server: { select: { ecoMode: true } },
      },
    });

    const deviceEcoModeMap = new Map(devices.map((d) => [d.id, d.server?.ecoMode ?? false]));

    const healthChecks = await this.prisma.deviceHealthCheck.findMany({
      where: { deviceId: { in: deviceIds } },
      orderBy: { testedAt: 'desc' },
      distinct: ['deviceId'],
      select: {
        deviceId: true,
        primaryReachable: true,
        bmcIcmpReachable: true,
        bmcIpmiReachable: true,
        bmcRedfishReachable: true,
        bmcCredsValid: true,
        poweredOn: true,
        brokkrLiveRunning: true,
        testedAt: true,
      },
    });

    for (const deviceId of deviceIds) {
      const ecoMode = deviceEcoModeMap.get(deviceId) ?? false;
      const healthCheck = healthChecks.find((hc) => hc.deviceId === deviceId);

      if (!healthCheck) {
        results.set(deviceId, {
          isHealthy: true,
          reason: 'No health check data available (new inventory)',
        });
        continue;
      }

      const checks = {
        primaryReachable: healthCheck.primaryReachable,
        bmcIcmpReachable: healthCheck.bmcIcmpReachable,
        bmcIpmiReachable: healthCheck.bmcIpmiReachable,
        bmcRedfishReachable: healthCheck.bmcRedfishReachable,
        bmcCredsValid: healthCheck.bmcCredsValid,
        poweredOn: healthCheck.poweredOn,
        brokkrLiveRunning: healthCheck.brokkrLiveRunning,
      };

      const requiredChecks = [
        {
          field: 'bmcIcmpReachable',
          value: healthCheck.bmcIcmpReachable,
          reason: 'BMC not reachable via ICMP',
        },
        {
          field: 'bmcIpmiReachable',
          value: healthCheck.bmcIpmiReachable,
          reason: 'BMC not accessible via IPMI',
        },
        {
          field: 'bmcRedfishReachable',
          value: healthCheck.bmcRedfishReachable,
          reason: 'BMC not accessible via Redfish',
        },
        {
          field: 'bmcCredsValid',
          value: healthCheck.bmcCredsValid,
          reason: 'BMC credentials invalid',
        },
      ];

      if (!ecoMode) {
        requiredChecks.push({
          field: 'poweredOn',
          value: healthCheck.poweredOn,
          reason: 'Device not powered on',
        });
      }

      const failedCheck = requiredChecks.find((check) => check.value !== true);

      if (failedCheck) {
        results.set(deviceId, {
          isHealthy: false,
          reason: failedCheck.reason,
          lastChecked: healthCheck.testedAt,
          checks,
        });
      } else {
        results.set(deviceId, {
          isHealthy: true,
          lastChecked: healthCheck.testedAt,
          checks,
        });
      }
    }

    return results;
  }
}
