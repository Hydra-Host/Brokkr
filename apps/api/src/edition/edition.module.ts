import { DynamicModule, Global, Logger, Module, Provider } from '@nestjs/common';
import { DesignationOperatorPolicy, OPERATOR_POLICY } from '../common/authz/operator-policy';
import { SingleSupplyTenancyPolicy, SUPPLY_TENANCY_POLICY } from '../common/authz/supply-tenancy-policy';
import { DefaultAllowedOrgTypesProvider } from '../organizations/allowed-org-types.provider';
import { ALLOWED_ORG_TYPES } from '../organizations/organizations.tokens';

@Global()
@Module({})
export class EditionModule {
  static register(overrides?: Provider[]): DynamicModule {
    if (overrides === undefined) {
      new Logger('EditionModule').warn(
        'register: overrides arrived undefined (likely a botched edition redaction); defaulting to core BOSS providers',
      );
      overrides = [];
    } else if (!Array.isArray(overrides)) {
      throw new Error('EditionModule.register: overrides must be a Provider[]');
    }
    return {
      module: EditionModule,
      providers: [
        { provide: ALLOWED_ORG_TYPES, useClass: DefaultAllowedOrgTypesProvider },
        { provide: OPERATOR_POLICY, useClass: DesignationOperatorPolicy },
        { provide: SUPPLY_TENANCY_POLICY, useClass: SingleSupplyTenancyPolicy },
        ...overrides,
      ],
      exports: [ALLOWED_ORG_TYPES, OPERATOR_POLICY, SUPPLY_TENANCY_POLICY],
    };
  }
}
