import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { ContextService } from 'src/common/context/context.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitTypeService } from '../circuit-type/circuit-type.service';
import { ProviderNetworkService } from '../provider-network/provider-network.service';
import { ProviderService } from '../provider/provider.service';

const denyOperator = () => {
  throw new ForbiddenException('operator only');
};

const mockContext = (requireInstanceOperator: () => void): ContextService =>
  ({ requireInstanceOperator }) as unknown as ContextService;

interface Writes {
  create: () => Promise<unknown>;
  update: () => Promise<unknown>;
  delete: () => Promise<unknown>;
}

afterEach(() => {
  ActiveRecordRegistry.configureForTest({}, null);
  vi.restoreAllMocks();
});

function operatorGateSuite(name: string, model: string, build: (ctx: ContextService) => Writes) {
  describe(`${name} catalog writes are operator-only`, () => {
    it('denies create/update/delete for a non-operator and never reaches the delegate', async () => {
      const delegate = { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
      ActiveRecordRegistry.configureForTest({ [model]: delegate }, () => ({ organizationId: 'org-1', system: true }));
      const writes = build(mockContext(denyOperator));

      await expect(writes.create()).rejects.toThrow(ForbiddenException);
      await expect(writes.update()).rejects.toThrow(ForbiddenException);
      await expect(writes.delete()).rejects.toThrow(ForbiddenException);

      expect(delegate.create).not.toHaveBeenCalled();
      expect(delegate.update).not.toHaveBeenCalled();
      expect(delegate.delete).not.toHaveBeenCalled();
    });

    it('reaches the record once the operator gate passes', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      ActiveRecordRegistry.configureForTest({ [model]: { findUnique } }, () => ({
        organizationId: 'org-1',
        system: true,
      }));
      const writes = build(mockContext(vi.fn()));

      await expect(writes.delete()).rejects.toThrow(NotFoundException);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'missing' } });
    });
  });
}

operatorGateSuite('Provider', 'provider', (ctx) => {
  const s = new ProviderService(ctx);
  return {
    create: () => s.create({ name: 'n', slug: 's' }),
    update: () => s.update('missing', { name: 'n2' }),
    delete: () => s.delete('missing'),
  };
});

operatorGateSuite('ProviderNetwork', 'providerNetwork', (ctx) => {
  const s = new ProviderNetworkService(ctx);
  return {
    create: () => s.create({ name: 'n', providerId: 'p1' }),
    update: () => s.update('missing', { name: 'n2' }),
    delete: () => s.delete('missing'),
  };
});

operatorGateSuite('CircuitType', 'circuitType', (ctx) => {
  const s = new CircuitTypeService(ctx);
  return {
    create: () => s.create({ name: 'n', slug: 's' }),
    update: () => s.update('missing', { name: 'n2' }),
    delete: () => s.delete('missing'),
  };
});
