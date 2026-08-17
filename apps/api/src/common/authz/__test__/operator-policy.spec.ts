import { editionOverrides } from '@hydrahost/plugins-config';
import { ForbiddenException, Logger, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditionModule } from '../../../edition/edition.module';
import { ALLOWED_ORG_TYPES } from '../../../organizations/organizations.tokens';
import {
  DesignationOperatorPolicy,
  OPERATOR_POLICY,
  type OperatorCandidateOrg,
  type OperatorPolicy,
} from '../operator-policy';
import { SUPPLY_TENANCY_POLICY } from '../supply-tenancy-policy';


const malformedOrg: OperatorCandidateOrg = JSON.parse('{}');

function bindsOperatorPolicy(p: Provider): boolean {
  return typeof p === 'object' && p !== null && 'provide' in p && p.provide === OPERATOR_POLICY;
}

describe('DesignationOperatorPolicy (BOSS default-deny)', () => {
  const policy = new DesignationOperatorPolicy();

  it('grants operator only to the explicitly designated org', () => {
    expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(true);
  });

  it('denies a non-designated org', () => {
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
  });

  it('fails closed on a missing/undefined designation', () => {
    expect(policy.isInstanceOperator(malformedOrg)).toBe(false);
  });
});

describe('ContextService.requireInstanceOperator', () => {
  afterEach(() => vi.restoreAllMocks());

  function serviceWithPolicy(policy: OperatorPolicy): ContextService {
    const svc = new ContextService(policy);
    vi.spyOn(ContextService.prototype, 'organization', 'get').mockReturnValue(JSON.parse('{}'));
    return svc;
  }

  it('is a no-op when the policy allows', () => {
    const svc = serviceWithPolicy({ isInstanceOperator: () => true });
    expect(() => svc.requireInstanceOperator()).not.toThrow();
  });

  it('throws ForbiddenException when the policy denies', () => {
    const svc = serviceWithPolicy({ isInstanceOperator: () => false });
    expect(() => svc.requireInstanceOperator()).toThrow(ForbiddenException);
  });
});

describe('EditionModule OPERATOR_POLICY binding (open-core seam)', () => {
  async function resolvePolicy(overrides: Provider[]): Promise<OperatorPolicy> {
    const moduleRef = await Test.createTestingModule({
      imports: [EditionModule.register(overrides)],
    }).compile();
    return moduleRef.get<OperatorPolicy>(OPERATOR_POLICY);
  }

  it('binds the default-deny DesignationOperatorPolicy with no overrides (BOSS)', async () => {
    const policy = await resolvePolicy([]);
    expect(policy).toBeInstanceOf(DesignationOperatorPolicy);
    expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(true);
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
  });

  it('lets an appended override win over the default (last-registration-wins)', async () => {
    class AlwaysDenyPolicy implements OperatorPolicy {
      isInstanceOperator(): boolean {
        return false;
      }
    }
    const policy = await resolvePolicy([{ provide: OPERATOR_POLICY, useClass: AlwaysDenyPolicy }]);
    expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(false);
  });

  it("denies even a designated org when the build's edition overrides bind OPERATOR_POLICY", async () => {
    const policy = await resolvePolicy(editionOverrides);
    expect(policy.isInstanceOperator({ isInstanceOperator: false })).toBe(false);
    if (editionOverrides.some(bindsOperatorPolicy)) {
      expect(policy.isInstanceOperator({ isInstanceOperator: true })).toBe(false);
    } else {
      expect(policy).toBeInstanceOf(DesignationOperatorPolicy);
    }
  });
});

describe('EditionModule.register argument handling', () => {
  afterEach(() => vi.restoreAllMocks());

  function overrideProviders(mod: ReturnType<typeof EditionModule.register>): Provider[] {
    return mod.providers!.filter(
      (p) => !bindsOperatorPolicy(p) && !bindsAllowedOrgTypes(p) && !bindsSupplyTenancyPolicy(p),
    );
  }
  function bindsAllowedOrgTypes(p: Provider): boolean {
    return typeof p === 'object' && p !== null && 'provide' in p && p.provide === ALLOWED_ORG_TYPES;
  }
  function bindsSupplyTenancyPolicy(p: Provider): boolean {
    return typeof p === 'object' && p !== null && 'provide' in p && p.provide === SUPPLY_TENANCY_POLICY;
  }

  it('warns and fails closed (no override providers, no throw) on undefined — botched redaction', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let mod!: ReturnType<typeof EditionModule.register>;
    expect(() => (mod = EditionModule.register(undefined))).not.toThrow();
    expect(overrideProviders(mod)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('throws on null', () => {
    expect(() => EditionModule.register(null as unknown as Provider[])).toThrow(/Provider\[\]/);
  });

  it('throws on a non-array value', () => {
    expect(() => EditionModule.register('x' as unknown as Provider[])).toThrow(/Provider\[\]/);
  });

  it('keeps a valid override provider', () => {
    const override: Provider = { provide: 'EDITION_TEST_TOKEN', useValue: 1 };
    const mod = EditionModule.register([override]);
    expect(overrideProviders(mod)).toContain(override);
  });
});
