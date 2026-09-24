import { ContractType } from '../enums';
import {
  interruptibleNoticePeriodRejectionMessage,
  inviteContractTypeWriteRejection,
  newContractTypeRejectionMessage,
  provisionContractTypeWriteRejection,
  resolveInviteContractType,
  resolveProvisionContractType,
  reservedRollingOnlyRejectionMessage,
  SELECTABLE_CONTRACT_TYPES,
} from '../contract-type';

describe('formatContractType helpers via rejection message', () => {
  it('allows Reserved Rolling', () => {
    expect(newContractTypeRejectionMessage(ContractType.RESERVED_ROLLING)).toBeNull();
  });

  it('rejects On Demand with the product message', () => {
    expect(newContractTypeRejectionMessage(ContractType.ON_DEMAND)).toBe(
      reservedRollingOnlyRejectionMessage(ContractType.ON_DEMAND),
    );
    expect(reservedRollingOnlyRejectionMessage(ContractType.ON_DEMAND)).toBe(
      "This device isn't available for On Demand contract type, please use Reserved Rolling",
    );
  });

  it('rejects Interruptible and Reserved with human labels', () => {
    expect(reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE)).toBe(
      "This device isn't available for Interruptible contract type, please use Reserved Rolling",
    );
    expect(reservedRollingOnlyRejectionMessage(ContractType.RESERVED)).toBe(
      "This device isn't available for Reserved contract type, please use Reserved Rolling",
    );
  });

  it('exposes only Reserved Rolling as selectable until commerce billing is ready', () => {
    expect(SELECTABLE_CONTRACT_TYPES).toEqual([ContractType.RESERVED_ROLLING]);
  });
});

describe('provisionContractTypeWriteRejection', () => {
  it('allows Reserved Rolling and omitted non-interruptible defaults', () => {
    expect(provisionContractTypeWriteRejection({ contractType: ContractType.RESERVED_ROLLING })).toBeNull();
    expect(provisionContractTypeWriteRejection({})).toBeNull();
  });

  it('rejects On Demand and legacy isInterruptible', () => {
    expect(provisionContractTypeWriteRejection({ contractType: ContractType.ON_DEMAND })).toBe(
      reservedRollingOnlyRejectionMessage(ContractType.ON_DEMAND),
    );
    expect(provisionContractTypeWriteRejection({ isInterruptible: true })).toBe(
      reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE),
    );
  });
});

describe('inviteContractTypeWriteRejection', () => {
  it('allows Reserved Rolling and omitted defaults', () => {
    expect(inviteContractTypeWriteRejection({ contractType: ContractType.RESERVED_ROLLING })).toBeNull();
    expect(inviteContractTypeWriteRejection({})).toBeNull();
  });

  it('rejects Interruptible via notice period or explicit type', () => {
    expect(inviteContractTypeWriteRejection({ interruptibleNoticePeriod: 300_000 })).toBe(
      reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE),
    );
    expect(inviteContractTypeWriteRejection({ contractType: ContractType.INTERRUPTIBLE })).toBe(
      reservedRollingOnlyRejectionMessage(ContractType.INTERRUPTIBLE),
    );
  });
});

describe('resolveProvisionContractType', () => {
  it('prefers an explicit contractType', () => {
    expect(
      resolveProvisionContractType({ contractType: ContractType.RESERVED_ROLLING, isInterruptible: true }),
    ).toBe(ContractType.RESERVED_ROLLING);
  });

  it('defaults omitted contractType to Reserved Rolling', () => {
    expect(resolveProvisionContractType({ isInterruptible: false })).toBe(ContractType.RESERVED_ROLLING);
    expect(resolveProvisionContractType({})).toBe(ContractType.RESERVED_ROLLING);
  });

  it('maps legacy isInterruptible:true when contractType is omitted', () => {
    expect(resolveProvisionContractType({ isInterruptible: true })).toBe(ContractType.INTERRUPTIBLE);
  });
});

describe('resolveInviteContractType', () => {
  it('defaults omitted invites to Reserved Rolling', () => {
    expect(resolveInviteContractType({})).toBe(ContractType.RESERVED_ROLLING);
  });

  it('treats a notice period without contractType as Interruptible', () => {
    expect(resolveInviteContractType({ interruptibleNoticePeriod: 300_000 })).toBe(ContractType.INTERRUPTIBLE);
  });

  it('lets an explicit contractType win over a notice period', () => {
    expect(
      resolveInviteContractType({
        contractType: ContractType.RESERVED_ROLLING,
        interruptibleNoticePeriod: 300_000,
      }),
    ).toBe(ContractType.RESERVED_ROLLING);
  });
});

describe('interruptibleNoticePeriodRejectionMessage', () => {
  it('explains that notice period is unsupported in the interim', () => {
    expect(interruptibleNoticePeriodRejectionMessage()).toContain('omit interruptibleNoticePeriod');
  });
});
