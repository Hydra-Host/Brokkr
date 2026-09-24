import { ContractType } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import {
  inventoryRentConfirmationLabel,
  resolveInventoryRentContractType,
} from '../rent.js';

describe('resolveInventoryRentContractType', () => {
  it('rejects an invalid --contract-type flag', () => {
    const result = resolveInventoryRentContractType({ contractType: ContractType.ON_DEMAND });
    expect(result.rejection).toBe(
      "This device isn't available for On Demand contract type, please use Reserved Rolling",
    );
    expect(result.contractType).toBe(ContractType.ON_DEMAND);
  });

  it('accepts a valid RESERVED_ROLLING --contract-type', () => {
    const result = resolveInventoryRentContractType({ contractType: ContractType.RESERVED_ROLLING });
    expect(result.rejection).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.contractType).toBe(ContractType.RESERVED_ROLLING);
  });

  it('auto-selects RESERVED_ROLLING when the flag is omitted', () => {
    const result = resolveInventoryRentContractType({});
    expect(result.rejection).toBeUndefined();
    expect(result.contractType).toBe(ContractType.RESERVED_ROLLING);
  });

  it('maps deprecated --interruptible to RESERVED_ROLLING with a warning and does not reject', () => {
    const result = resolveInventoryRentContractType({ interruptible: true });
    expect(result.rejection).toBeUndefined();
    expect(result.contractType).toBe(ContractType.RESERVED_ROLLING);
    expect(result.warning).toContain('deprecated');
    expect(result.warning).toContain('RESERVED_ROLLING');
  });

  it('keeps an explicit --contract-type when --interruptible is also passed', () => {
    const result = resolveInventoryRentContractType({
      interruptible: true,
      contractType: ContractType.RESERVED_ROLLING,
    });
    expect(result.rejection).toBeUndefined();
    expect(result.contractType).toBe(ContractType.RESERVED_ROLLING);
    expect(result.warning).toContain('deprecated');
  });

  it('still rejects a non-selectable explicit type even with --interruptible', () => {
    const result = resolveInventoryRentContractType({
      interruptible: true,
      contractType: ContractType.INTERRUPTIBLE,
    });
    expect(result.rejection).toContain('Interruptible');
    expect(result.warning).toContain('deprecated');
  });
});

describe('inventoryRentConfirmationLabel', () => {
  it('labels Reserved Rolling for confirmation copy', () => {
    expect(inventoryRentConfirmationLabel(ContractType.RESERVED_ROLLING)).toBe('Reserved Rolling');
  });
});
