import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from 'src/prisma/prisma.client';

export interface CreateIpamRoleInput {
  name: string;
  slug: string;
  weight?: number;
  description?: string | null;
}

export interface UpdateIpamRoleInput {
  name?: string;
  slug?: string;
  weight?: number;
  description?: string | null;
}

@Injectable()
export class IpamRoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(search?: string) {
    return this.prisma.ipamPrefixVlanRole.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    const role = await this.prisma.ipamPrefixVlanRole.findUnique({ where: { id } });
    if (!role) {
      throw new NotFoundException('IPAM role not found');
    }
    return role;
  }

  async create(input: CreateIpamRoleInput) {
    await this.ensureSlugUnique(input.slug);
    const created = await this.prisma.ipamPrefixVlanRole.create({
      data: {
        name: input.name,
        slug: input.slug,
        weight: input.weight ?? 1000,
        description: input.description ?? undefined,
      },
    });
    return created;
  }

  async update(id: string, input: UpdateIpamRoleInput) {
    const existing = await this.prisma.ipamPrefixVlanRole.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('IPAM role not found');
    }

    if (input.slug !== undefined) {
      await this.ensureSlugUnique(input.slug, id);
    }

    const updated = await this.prisma.ipamPrefixVlanRole.update({ where: { id }, data: input });
    return updated;
  }

  async delete(id: string) {
    const existing = await this.prisma.ipamPrefixVlanRole.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('IPAM role not found');
    }
    await this.prisma.ipamPrefixVlanRole.delete({ where: { id } });
  }

  private async ensureSlugUnique(slug: string, excludeId?: string) {
    const existing = await this.prisma.ipamPrefixVlanRole.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('IPAM role slug must be unique');
    }
  }
}
