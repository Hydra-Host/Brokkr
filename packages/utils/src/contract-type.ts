import { ContractType } from './enums';

/** Contract types offered on provision/invite create-edit surfaces until commerce billing is ready. */
export const SELECTABLE_CONTRACT_TYPES: [ContractType, ...ContractType[]] = [ContractType.RESERVED_ROLLING];
export type SelectableContractType = (typeof SELECTABLE_CONTRACT_TYPES)[number];

// Shared select options for provision/invite UIs.
export const CONTRACT_TYPE_OPTIONS: ReadonlyArray<{ label: string; value: ContractType }> = [
  // Only Reserved Rolling until commerce billing can price the other terms.
  // { label: 'On Demand', value: ContractType.ON_DEMAND },
  { label: 'Reserved Rolling', value: ContractType.RESERVED_ROLLING },
  // { label: 'Interruptible', value: ContractType.INTERRUPTIBLE },
  // { label: 'Reserved', value: ContractType.RESERVED },
];

const CONTRACT_TYPE_LABELS = {
  [ContractType.RESERVED_ROLLING]: 'Reserved Rolling',
  [ContractType.RESERVED]: 'Reserved',
  [ContractType.ON_DEMAND]: 'On Demand',
  [ContractType.INTERRUPTIBLE]: 'Interruptible',
} as const satisfies Record<ContractType, string>;

export function formatContractType(contractType: string): string {
  return CONTRACT_TYPE_LABELS[contractType as ContractType] ?? contractType;
}

export function reservedRollingOnlyRejectionMessage(contractType: string): string {
  return `This device isn't available for ${formatContractType(contractType)} contract type, please use Reserved Rolling`;
}

export function newContractTypeRejectionMessage(contractType: string): string | null {
  if (contractType === ContractType.RESERVED_ROLLING) return null;
  return reservedRollingOnlyRejectionMessage(contractType);
}

/** Shared write-site gate: resolve provision contract type, return rejection or null. */
export function provisionContractTypeWriteRejection(input: {
  contractType?: string | null;
  isInterruptible?: boolean | null;
}): string | null {
  return newContractTypeRejectionMessage(resolveProvisionContractType(input));
}

/** Shared write-site gate: resolve invite contract type, return rejection or null. */
export function inviteContractTypeWriteRejection(input: {
  contractType?: string | null;
  interruptibleNoticePeriod?: number | null;
}): string | null {
  return newContractTypeRejectionMessage(resolveInviteContractType(input));
}

/** Clearer than framing a notice-period reject as an Interruptible contract-type reject. */
export function interruptibleNoticePeriodRejectionMessage(): string {
  return (
    'Interruptible notice period is not supported until commerce billing is ready; ' +
    'omit interruptibleNoticePeriod and use Reserved Rolling'
  );
}

export function resolveProvisionContractType(input: {
  contractType?: string | null;
  isInterruptible?: boolean | null;
}): string {
  if (input.contractType != null && input.contractType !== '') {
    return input.contractType;
  }
  // Omitted contractType defaults to RESERVED_ROLLING for legacy callers.
  if (input.isInterruptible === true) return ContractType.INTERRUPTIBLE;
  return ContractType.RESERVED_ROLLING;
}

export function resolveInviteContractType(input: {
  contractType?: string | null;
  interruptibleNoticePeriod?: number | null;
}): string {
  if (input.contractType != null && input.contractType !== '') {
    return input.contractType;
  }
  if (input.interruptibleNoticePeriod != null) return ContractType.INTERRUPTIBLE;
  return ContractType.RESERVED_ROLLING;
}
