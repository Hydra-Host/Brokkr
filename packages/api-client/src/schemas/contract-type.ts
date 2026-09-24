import { ContractType, SELECTABLE_CONTRACT_TYPES } from '@repo/utils';
import { z } from 'zod';

/** Full contract-type enum for read/response schemas. */
export const ContractTypeSchema = z.nativeEnum(ContractType).describe('Type of compute reservation contract');

/** Write-site types (RESERVED_ROLLING only); keep in sync with SELECTABLE_CONTRACT_TYPES. */
export const SelectableContractTypeSchema = z
  .enum(SELECTABLE_CONTRACT_TYPES)
  .describe(
    'Contract type accepted on create/update/provision/rent until commerce billing can price other terms. Only RESERVED_ROLLING is accepted.',
  );

export type SelectableContractTypeInput = z.infer<typeof SelectableContractTypeSchema>;
