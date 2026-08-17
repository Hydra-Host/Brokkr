import { Injectable } from '@nestjs/common';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class AuthRepository {
  constructor(private readonly prismaService: PrismaClient) {}

  async findOrganizationMember(userId: string, organizationId: string) {
    return await this.prismaService.member.findFirst({
      where: {
        organizationId,
        userId,
        deletedAt: null,
      },
      include: {
        user: true,
        organization: {
          include: {
            members: { where: { deletedAt: null } },
          },
        },
      },
    });
  }
}
