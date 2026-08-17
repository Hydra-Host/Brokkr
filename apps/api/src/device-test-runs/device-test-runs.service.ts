import { Injectable, NotFoundException } from '@nestjs/common';
import { DeviceTestStatus, DeviceTestType, Prisma } from '@repo/database';
import type { PaginationQuery } from '@repo/database/pagination';
import { PaginatedResult, paginateQuery } from '@repo/database/pagination';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { deviceTestRunsPaginationConfig } from './device-test-runs.pagination';
import type { UpdateDeviceTestRunInput } from './device-test-runs.types';

interface FindByOrganizationOptions {
  deviceId?: string;
  type?: DeviceTestType;
  status?: DeviceTestStatus;
}

@Injectable()
export class DeviceTestRunsService {
  constructor(
    private readonly prismaService: PrismaClient,
    private readonly contextService: ContextService,
    @Logger(DeviceTestRunsService.name) private readonly logger: LoggerService,
  ) {}

  // `expectedDeviceId` must match the run's device id, or anyone publishing on the shared results queue could corrupt other tenants' runs by guessing UUIDs.
  async update(id: string, dto: UpdateDeviceTestRunInput, expectedDeviceId: string) {
    const existing = await this.prismaService.deviceTestRun.findUnique({
      where: { id },
      include: { device: { select: { id: true } } },
    });

    if (!existing) {
      throw new NotFoundException(`DeviceTestRun with id ${id} not found`);
    }

    if (existing.device?.id !== expectedDeviceId) {
      throw new NotFoundException(`DeviceTestRun with id ${id} not found`);
    }

    const endTime = new Date();
    const durationSeconds = existing.startTime
      ? Math.round((endTime.getTime() - existing.startTime.getTime()) / 1000)
      : undefined;

    const testRun = await this.prismaService.deviceTestRun.update({
      where: { id },
      data: {
        status: dto.status,
        endTime,
        durationSeconds,
        testPassed: dto.testPassed,
        data: dto.data as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`Updated test run ${testRun.id} - status: ${testRun.status}`);

    return testRun;
  }

  async findAll(query: PaginationQuery) {
    type AdminTestRunWithDevice = Prisma.DeviceTestRunGetPayload<{
      include: {
        device: {
          select: { id: true; name: true; gpus: { select: { model: true } } };
        };
      };
    }>;

    const result = (await paginateQuery(this.prismaService.deviceTestRun, query, deviceTestRunsPaginationConfig, {
      include: {
        device: {
          select: { id: true, name: true, gpus: { select: { model: true }, orderBy: { index: 'asc' } } },
        },
      },
    })) as PaginatedResult<AdminTestRunWithDevice>;

    return {
      meta: result.meta,
      data: result.data.map(({ device, ...rest }) => ({
        ...rest,
        device: device
          ? {
              id: device.id,
              name: device.name,
              gpuModel: device.gpus[0]?.model ?? null,
            }
          : null,
        startTime: rest.startTime.toISOString(),
        endTime: rest.endTime?.toISOString() ?? null,
        createdAt: rest.createdAt.toISOString(),
        updatedAt: rest.updatedAt.toISOString(),
      })),
    };
  }

  async findAllByOrganization(query: PaginationQuery, options: FindByOrganizationOptions = {}) {
    const organizationId = this.contextService.organizationId;
    const whereClause: Prisma.DeviceTestRunWhereInput = {};

    if (options.deviceId) {
      const device = await this.prismaService.device.findUnique({
        where: { id: options.deviceId, supplierId: organizationId },
        select: { id: true },
      });

      if (!device) {
        throw new NotFoundException('Device not found');
      }

      whereClause.deviceId = device.id;
    } else {
      whereClause.device = { supplierId: organizationId };
    }

    if (options.type) {
      whereClause.type = options.type;
    }

    if (options.status) {
      whereClause.status = options.status;
    }

    type DcimTestRunWithDevice = Prisma.DeviceTestRunGetPayload<{
      include: {
        device: {
          select: { id: true; name: true; gpus: { select: { model: true } } };
        };
      };
    }>;

    const result = (await paginateQuery(this.prismaService.deviceTestRun, query, deviceTestRunsPaginationConfig, {
      where: whereClause,
      include: {
        device: {
          select: { id: true, name: true, gpus: { select: { model: true }, orderBy: { index: 'asc' } } },
        },
      },
    })) as PaginatedResult<DcimTestRunWithDevice>;

    return {
      meta: result.meta,
      data: result.data.map(({ device, ...rest }) => ({
        ...rest,
        device: device
          ? {
              id: device.id,
              name: device.name,
              gpuModel: device.gpus[0]?.model ?? null,
            }
          : null,
        startTime: rest.startTime.toISOString(),
        endTime: rest.endTime?.toISOString() ?? null,
        createdAt: rest.createdAt.toISOString(),
        updatedAt: rest.updatedAt.toISOString(),
      })),
    };
  }
}
