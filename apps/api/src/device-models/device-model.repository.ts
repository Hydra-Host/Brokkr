import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateDeviceModelRequest, UpdateDeviceModelRequest } from '@repo/api-client';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class DeviceModelRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(manufacturer?: string) {
    return this.prisma.deviceModel.findMany({
      where: manufacturer ? { manufacturer: { equals: manufacturer, mode: 'insensitive' } } : undefined,
      orderBy: [{ manufacturer: 'asc' }, { model: 'asc' }],
    });
  }

  async findById(id: string) {
    const deviceModel = await this.prisma.deviceModel.findUnique({ where: { id } });
    if (!deviceModel) {
      throw new NotFoundException('Device model not found');
    }
    return deviceModel;
  }

  async create(input: CreateDeviceModelRequest) {
    const created = await this.prisma.deviceModel.create({
      data: {
        manufacturer: input.manufacturer,
        model: input.model,
        formFactor: input.formFactor ?? undefined,
        description: input.description ?? undefined,
        isFullDepth: input.isFullDepth ?? undefined,
        heightU: input.heightU ?? undefined,
        maxPowerW: input.maxPowerW ?? undefined,
      },
    });
    return created;
  }

  async update(id: string, input: UpdateDeviceModelRequest) {
    const existing = await this.prisma.deviceModel.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Device model not found');
    }

    const updated = await this.prisma.deviceModel.update({ where: { id }, data: input });
    return updated;
  }

  async delete(id: string) {
    const existing = await this.prisma.deviceModel.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Device model not found');
    }
    await this.prisma.deviceModel.delete({ where: { id } });
  }
}
