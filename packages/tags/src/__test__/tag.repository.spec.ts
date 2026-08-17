import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TagRepository, type TagPrisma } from '../tag.repository';

describe('TagRepository', () => {
  let mockPrisma: {
    tag: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let repo: TagRepository;

  beforeEach(() => {
    mockPrisma = {
      tag: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
      },
    };
    repo = new TagRepository(mockPrisma as unknown as TagPrisma);
  });

  it('on customer scope, ignores client-supplied org and stamps caller org', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue(null);
    const created = { id: 'tag-1', name: 'production', organizationId: 'caller-org' };
    mockPrisma.tag.create.mockResolvedValue(created);

    await repo.create({ name: 'production', organizationId: 'attacker-org' }, 'caller-org');

    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: {
        name: 'production',
        slug: 'production',
        color: undefined,
        description: undefined,
        organizationId: 'caller-org',
      },
    });
  });

  it('on admin scope (null), honors client-supplied organizationId (incl. null for global)', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue(null);
    const created = { id: 'tag-g', name: 'shared', organizationId: null };
    mockPrisma.tag.create.mockResolvedValue(created);

    await repo.create({ name: 'shared', organizationId: null }, null);

    expect(mockPrisma.tag.create).toHaveBeenCalledWith({
      data: {
        name: 'shared',
        slug: 'shared',
        color: undefined,
        description: undefined,
        organizationId: null,
      },
    });
  });

  it('rejects duplicate name within same organization', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue({ id: 'existing', name: 'production' });

    await expect(repo.create({ name: 'production' }, 'org-1')).rejects.toThrow(ConflictException);
    await expect(repo.create({ name: 'production' }, 'org-1')).rejects.toThrow(
      'A tag with this name or slug already exists in the organization',
    );
  });

  it('rejects a name whose derived slug collides with another tag', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue({ id: 'existing', name: 'Foo Bar', slug: 'foo-bar' });

    await expect(repo.create({ name: 'foo-bar' }, 'org-1')).rejects.toThrow(ConflictException);
    await expect(repo.create({ name: 'foo-bar' }, 'org-1')).rejects.toThrow(
      'A tag with this name or slug already exists in the organization',
    );
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        OR: [{ name: 'foo-bar' }, { slug: 'foo-bar' }],
      },
    });
  });

  it('updates a tag scoped to the caller org', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({
      id: 'tag-1',
      name: 'production',
      organizationId: 'org-1',
    });
    mockPrisma.tag.findFirst.mockResolvedValue(null);
    const updated = { id: 'tag-1', name: 'staging', organizationId: 'org-1' };
    mockPrisma.tag.update.mockResolvedValue(updated);

    const result = await repo.update('tag-1', { name: 'staging' }, 'org-1');

    expect(result).toEqual(updated);
    expect(mockPrisma.tag.update).toHaveBeenCalledWith({
      where: { id: 'tag-1' },
      data: { name: 'staging', slug: 'staging' },
    });
  });

  it('customer cannot update a tag in another tenant (NotFound to avoid disclosure)', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({
      id: 'tag-other',
      name: 'foreign',
      organizationId: 'other-org',
    });

    await expect(repo.update('tag-other', { name: 'pwned' }, 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('customer cannot update a global tag', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({
      id: 'tag-global',
      name: 'system',
      organizationId: null,
    });

    await expect(repo.update('tag-global', { name: 'hijacked' }, 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.tag.update).not.toHaveBeenCalled();
  });

  it('admin can update any tag including globals', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({
      id: 'tag-global',
      name: 'system',
      organizationId: null,
    });
    mockPrisma.tag.findFirst.mockResolvedValue(null);
    mockPrisma.tag.update.mockResolvedValue({ id: 'tag-global', name: 'renamed', organizationId: null });

    await repo.update('tag-global', { name: 'renamed' }, null);

    expect(mockPrisma.tag.update).toHaveBeenCalled();
  });

  it('deletes a tag scoped to the caller org', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({ id: 'tag-1', organizationId: 'org-1' });

    await repo.delete('tag-1', 'org-1');

    expect(mockPrisma.tag.delete).toHaveBeenCalledWith({ where: { id: 'tag-1' } });
  });

  it('customer cannot delete a tag in another tenant', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({ id: 'tag-other', organizationId: 'other-org' });

    await expect(repo.delete('tag-other', 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });

  it('customer cannot delete a global tag', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue({ id: 'tag-global', organizationId: null });

    await expect(repo.delete('tag-global', 'caller-org')).rejects.toThrow(NotFoundException);
    expect(mockPrisma.tag.delete).not.toHaveBeenCalled();
  });

  it('customer findById returns own-org tags', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue({ id: 'tag-1', organizationId: 'caller-org' });

    await repo.findById('tag-1', 'caller-org');

    expect(mockPrisma.tag.findFirst).toHaveBeenCalledWith({
      where: { id: 'tag-1', OR: [{ organizationId: 'caller-org' }, { organizationId: null }] },
    });
  });

  it('customer findById returns NotFound for foreign-org tags', async () => {
    mockPrisma.tag.findFirst.mockResolvedValue(null);

    await expect(repo.findById('tag-foreign', 'caller-org')).rejects.toThrow(NotFoundException);
  });

  it('customer list includes global tags via OR-with-null filter', async () => {
    mockPrisma.tag.findMany.mockResolvedValue([]);

    await repo.list('caller-org');

    expect(mockPrisma.tag.findMany).toHaveBeenCalledWith({
      where: { OR: [{ organizationId: 'caller-org' }, { organizationId: null }] },
      orderBy: [{ organizationId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
  });

  it('admin list returns all tags (no scope filter)', async () => {
    mockPrisma.tag.findMany.mockResolvedValue([]);

    await repo.list(null);

    expect(mockPrisma.tag.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ organizationId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
  });

  it('listPaginated without organizationId returns all tags', async () => {
    mockPrisma.tag.findMany.mockResolvedValue([]);
    mockPrisma.tag.count.mockResolvedValue(0);

    await repo.listPaginated({ page: 1, pageSize: 20 });

    const findManyCall = mockPrisma.tag.findMany.mock.calls.at(-1)?.[0];
    expect(findManyCall?.where).toEqual({});
    expect(mockPrisma.tag.count).toHaveBeenCalled();
  });

  it('listPaginated with organizationId scopes strictly to that org', async () => {
    mockPrisma.tag.findMany.mockResolvedValue([]);
    mockPrisma.tag.count.mockResolvedValue(0);

    await repo.listPaginated({ page: 1 }, { organizationId: 'org-1' });

    const findManyCall = mockPrisma.tag.findMany.mock.calls.at(-1)?.[0];
    expect(findManyCall?.where).toEqual({ organizationId: 'org-1' });
  });

  it('throws NotFoundException when updating non-existent record', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    await expect(repo.update('tag-missing', { name: 'new-name' }, 'org-1')).rejects.toThrow(NotFoundException);
    await expect(repo.update('tag-missing', { name: 'new-name' }, 'org-1')).rejects.toThrow('Tag not found');
  });

  it('throws NotFoundException when deleting non-existent record', async () => {
    mockPrisma.tag.findUnique.mockResolvedValue(null);

    await expect(repo.delete('tag-missing', 'org-1')).rejects.toThrow(NotFoundException);
    await expect(repo.delete('tag-missing', 'org-1')).rejects.toThrow('Tag not found');
  });
});
