import { TRANSITIONAL_POWER_STATUSES } from './enums';

export type PowerAction = 'on' | 'off' | 'power-cycle';

interface PowerControllableEntity {
  status?: { value?: string } | null;
  powerStatus?: { value?: string } | null;
  isLocked?: boolean;
  deployment?: { isLocked?: boolean } | null;
}

export function isPowerActionDisabled(entity: PowerControllableEntity, action: PowerAction): boolean {
  const isLocked = entity.isLocked ?? entity.deployment?.isLocked ?? false;
  const statusValue = entity.status?.value ?? '';
  const powerValue = entity.powerStatus?.value ?? '';
  const isTransitioning = TRANSITIONAL_POWER_STATUSES.includes(powerValue);

  switch (action) {
    case 'power-cycle':
      return (
        !['provisioned', 'failed', 'error', 'inventory'].includes(statusValue) ||
        isTransitioning ||
        powerValue === 'Powered Off' ||
        isLocked
      );
    case 'on':
      return powerValue !== 'Powered Off' || isLocked;
    case 'off':
      return (
        powerValue === 'Powered Off' || isTransitioning || ['queued', 'provisioning'].includes(statusValue) || isLocked
      );
  }
}
