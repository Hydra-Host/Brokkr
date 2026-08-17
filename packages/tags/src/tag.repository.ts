import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@repo/database';
import { paginateQuery, type PaginationQuery } from '@repo/database/pagination';
import { slugify } from '@repo/utils';
import { tagsPaginationConfig } from './tag.pagination';

export interface CreateTagInput {
  name?: string;
  color?: string | null;
  description?: string | null;
  organizationId?: string | null;
}

export interface UpdateTagInput {
  name?: string;
  color?: string | null;
  description?: string | null;
}

export type TagPrisma = Pick<PrismaClient, 'tag'>;

const DUPLICATE_TAG_MESSAGE = (organizationId: string | null) =>
  organizationId === null
    ? 'A tag with this name or slug already exists globally'
    : 'A tag with this name or slug already exists in the organization';

function rethrowUniqueViolation(error: unknown, organizationId: string | null): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(DUPLICATE_TAG_MESSAGE(organizationId));
  }
  throw error;
}

// null org = admin scope (unfiltered); the caller must be admin-protected. Non-null org =
// customer scope: reads union own-org + global tags; writes restricted to own-org tags.
function readScope(organizationId: string | null) {
  return organizationId !== null ? { OR: [{ organizationId }, { organizationId: null }] } : {};
}

// Nest-free tag persistence shared by the hub and admin-api. Construct with a
// Prisma client (or `{ tag }` pick); the app owns DI, permissions, and audit.
export class TagRepository {
  constructor(private readonly prisma: TagPrisma) {}

  async list(organizationId: string | null) {
    return this.prisma.tag.findMany({
      where: readScope(organizationId),
      orderBy: [{ organizationId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
  }

  // No organizationId → all tags across tenants; with it → strict org scope
  // (no global-tag union).
  async listPaginated(paginationQuery: PaginationQuery, options: { organizationId?: string } = {}) {
    const where = options.organizationId !== undefined ? { organizationId: options.organizationId } : readScope(null);

    return paginateQuery(this.prisma.tag, paginationQuery, tagsPaginationConfig, { where });
  }

  async findById(id: string, organizationId: string | null) {
    const tag = await this.prisma.tag.findFirst({
      where: { id, ...readScope(organizationId) },
    });
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  async create(input: CreateTagInput, organizationId: string | null) {
    // Customer scope stamps the caller's org, ignoring client input (blocks customer-created globals);
    // admin scope (null) honors input.organizationId (null = global system tag).
    const resolvedOrganizationId = organizationId !== null ? organizationId : (input.organizationId ?? null);

    if (!input.name) {
      throw new BadRequestException('Tag name is required');
    }
    const slug = slugify(input.name);
    await this.ensureNameOrSlugUnique(resolvedOrganizationId, input.name, slug);

    try {
      return await this.prisma.tag.create({
        data: {
          name: input.name,
          slug,
          color: input.color ?? undefined,
          description: input.description ?? undefined,
          organizationId: resolvedOrganizationId,
        },
      });
    } catch (error) {
      rethrowUniqueViolation(error, resolvedOrganizationId);
    }
  }

  async update(id: string, input: UpdateTagInput, organizationId: string | null) {
    const existing = await this.prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Tag not found');
    }

    // Customer scope: reject foreign-org and global tags (read-only to customers),
    // guarding against IDOR and global-tag tampering.
    if (organizationId !== null && existing.organizationId !== organizationId) {
      // Surface a 404 rather than a 403 so we don't disclose which IDs map to
      // existing-but-foreign records.
      throw new NotFoundException('Tag not found');
    }

    let slug: string | undefined;
    if (input.name !== undefined) {
      slug = slugify(input.name);
      await this.ensureNameOrSlugUnique(existing.organizationId, input.name, slug, id);
    }

    const data = {
      ...(input.name !== undefined ? { name: input.name, slug } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };

    try {
      return await this.prisma.tag.update({ where: { id }, data });
    } catch (error) {
      rethrowUniqueViolation(error, existing.organizationId);
    }
  }

  async delete(id: string, organizationId: string | null) {
    const existing = await this.prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Tag not found');
    }

    if (organizationId !== null && existing.organizationId !== organizationId) {
      throw new NotFoundException('Tag not found');
    }

    return this.prisma.tag.delete({ where: { id } });
  }

  // `null` org is its own uniqueness namespace (matches the DB @@unique constraints).
  // Distinct names can collide on the derived slug (e.g. "Foo Bar" / "foo-bar") — check both.
  private async ensureNameOrSlugUnique(organizationId: string | null, name: string, slug: string, excludeId?: string) {
    const duplicate = await this.prisma.tag.findFirst({
      where: {
        organizationId,
        OR: [{ name }, { slug }],
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (duplicate) {
      throw new ConflictException(DUPLICATE_TAG_MESSAGE(organizationId));
    }
  }
}
