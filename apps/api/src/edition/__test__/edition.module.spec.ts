import { editionOverrides, loadManagedEditionOverrides } from '@hydrahost/plugins-config';
import type { Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TenantType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  DesignationOperatorPolicy,
  OPERATOR_POLICY,
  type OperatorCandidateOrg,
  type OperatorPolicy,
} from '../../common/authz/operator-policy';
import {
  DefaultAllowedOrgTypesProvider,
  type AllowedOrgTypesProvider,
} from '../../organizations/allowed-org-types.provider';
import { ALLOWED_ORG_TYPES } from '../../organizations/organizations.tokens';
import { EditionModule } from '../edition.module';


async function registerEdition(overrides: Provider[]) {
  return Test.createTestingModule({ imports: [EditionModule.register(overrides)] }).compile();
}

describe('EditionModule self-degrading seam', () => {
  it('register([]) resolves to core BOSS defaults only (demand-only, default-deny)', async () => {
    const moduleRef = await registerEdition([]);

    const allowed = moduleRef.get<AllowedOrgTypesProvider>(ALLOWED_ORG_TYPES);
    expect(allowed).toBeInstanceOf(DefaultAllowedOrgTypesProvider);
    expect(allowed.getAllowedOrgTypes()).toEqual([TenantType.DemandCustomer]);

    const policy = moduleRef.get<OperatorPolicy>(OPERATOR_POLICY);
    expect(policy).toBeInstanceOf(DesignationOperatorPolicy);
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
  });

  it('loadManagedEditionOverrides() degrades to [] when the package is absent (MODULE_NOT_FOUND)', () => {
    const absent = () => {
      const err = new Error("Cannot find module '@hydrahost/managed-edition'") as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    };
    expect(loadManagedEditionOverrides(absent)).toEqual([]);
  });

  it('loadManagedEditionOverrides() returns the package overrides when present', () => {
    const sentinel: Provider = { provide: 'SENTINEL', useValue: 1 };
    const present = () => ({ editionOverrides: [sentinel] });
    expect(loadManagedEditionOverrides(present)).toEqual([sentinel]);
  });

  it('editionOverrides export is a well-formed Provider[]', () => {
    expect(Array.isArray(editionOverrides)).toBe(true);
    for (const provider of editionOverrides) {
      expect(provider).toHaveProperty('provide');
    }
  });

  it('register() merges overrides last-wins: a sentinel override shadows the core provider', async () => {
    class SentinelOperatorPolicy implements OperatorPolicy {
      isInstanceOperator(): boolean {
        return true;
      }
    }
    const sentinelOverride: Provider[] = [{ provide: OPERATOR_POLICY, useClass: SentinelOperatorPolicy }];

    const moduleRef = await registerEdition(sentinelOverride);
    const policy = moduleRef.get<OperatorPolicy>(OPERATOR_POLICY);
    expect(policy).toBeInstanceOf(SentinelOperatorPolicy);
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(true);
  });
});

class ManagedAllowedOrgTypesProvider implements AllowedOrgTypesProvider {
  getAllowedOrgTypes(): TenantType[] {
    return [TenantType.DemandCustomer, TenantType.SupplyCustomer];
  }
}
class ManagedOperatorPolicy implements OperatorPolicy {
  isInstanceOperator(_org: OperatorCandidateOrg): boolean {
    return false;
  }
}

type ExactParams<T, Expected extends Params<T>> = Expected;
type Params<T> = T extends (...a: infer P) => unknown ? P : never;
type _PinDefault = ExactParams<DesignationOperatorPolicy['isInstanceOperator'], [OperatorCandidateOrg]>;
type _PinManaged = ExactParams<ManagedOperatorPolicy['isInstanceOperator'], [OperatorCandidateOrg]>;
const managedOverrides: Provider[] = [
  { provide: ALLOWED_ORG_TYPES, useClass: ManagedAllowedOrgTypesProvider },
  { provide: OPERATOR_POLICY, useClass: ManagedOperatorPolicy },
];

async function compile(overrides?: Provider[]): Promise<TestingModule> {
  return Test.createTestingModule({ imports: [EditionModule.register(overrides)] }).compile();
}

describe('EditionModule.register', () => {
  describe('fail-closed defaults (empty overrides)', () => {
    it('binds ALLOWED_ORG_TYPES to the demand-only default', async () => {
      const moduleRef = await compile([]);
      const provider = moduleRef.get<AllowedOrgTypesProvider>(ALLOWED_ORG_TYPES);
      expect(provider).toBeInstanceOf(DefaultAllowedOrgTypesProvider);
      expect(provider.getAllowedOrgTypes()).toEqual([TenantType.DemandCustomer]);
    });

    it('binds OPERATOR_POLICY to the designation default that denies a non-designated org', async () => {
      const moduleRef = await compile([]);
      const policy = moduleRef.get<OperatorPolicy>(OPERATOR_POLICY);
      expect(policy).toBeInstanceOf(DesignationOperatorPolicy);
      expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
      expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(true);
    });

    it('fails closed when overrides arrive undefined', async () => {
      const moduleRef = await compile(undefined);
      expect(moduleRef.get<AllowedOrgTypesProvider>(ALLOWED_ORG_TYPES)).toBeInstanceOf(DefaultAllowedOrgTypesProvider);
      expect(moduleRef.get<OperatorPolicy>(OPERATOR_POLICY)).toBeInstanceOf(DesignationOperatorPolicy);
    });

    it('rejects a non-array overrides value', () => {
      expect(() => EditionModule.register('nope' as unknown as Provider[])).toThrow(/must be a Provider\[\]/);
    });
  });

  describe('managed override-wins (overrides appended last)', () => {
    it('resolves ALLOWED_ORG_TYPES to the managed override that allows supply', async () => {
      const moduleRef = await compile(managedOverrides);
      const provider = moduleRef.get<AllowedOrgTypesProvider>(ALLOWED_ORG_TYPES);
      expect(provider).toBeInstanceOf(ManagedAllowedOrgTypesProvider);
      expect(provider).not.toBeInstanceOf(DefaultAllowedOrgTypesProvider);
      expect(provider.getAllowedOrgTypes()).toEqual([TenantType.DemandCustomer, TenantType.SupplyCustomer]);
    });

    it('resolves OPERATOR_POLICY to the managed override that always denies', async () => {
      const moduleRef = await compile(managedOverrides);
      const policy = moduleRef.get<OperatorPolicy>(OPERATOR_POLICY);
      expect(policy).toBeInstanceOf(ManagedOperatorPolicy);
      expect(policy).not.toBeInstanceOf(DesignationOperatorPolicy);
      expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(false);
    });
  });

  it('exports both edition tokens', () => {
    expect(EditionModule.register([]).exports).toEqual(expect.arrayContaining([ALLOWED_ORG_TYPES, OPERATOR_POLICY]));
  });
});

describe('edition provider contracts', () => {
  it('DefaultAllowedOrgTypesProvider returns demand-only', () => {
    expect(new DefaultAllowedOrgTypesProvider().getAllowedOrgTypes()).toEqual([TenantType.DemandCustomer]);
  });

  it('DesignationOperatorPolicy reads the org designation', () => {
    const policy = new DesignationOperatorPolicy();
    expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(true);
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
  });

  it('OperatorPolicy.isInstanceOperator accepts the org argument', () => {
    const policy: OperatorPolicy = new ManagedOperatorPolicy();
    expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(false);
  });
});
