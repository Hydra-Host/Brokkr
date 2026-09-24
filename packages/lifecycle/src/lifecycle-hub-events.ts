// eventType values the hub stamps on LifecycleJobEvent rows itself; every other value came from a bridge
export const PHONE_HOME_EVENT_TYPE = 'phone_home';
export const POWER_WATCHDOG_EVENT_TYPE = 'power_watchdog';
export const STUCK_SWEEP_EVENT_TYPE = 'stuck_sweep';

// step labels for those same rows; a bridge row carries the label the bridge declared on its step
export const PHONE_HOME_OPERATION = 'Wait for phone home';
export const POWER_WATCHDOG_OPERATION = 'Power saga watchdog';
export const STUCK_SWEEP_OPERATION = 'Stuck job sweep';

export const HUB_STAMPED_EVENT_TYPES: ReadonlySet<string> = new Set([
  PHONE_HOME_EVENT_TYPE,
  POWER_WATCHDOG_EVENT_TYPE,
  STUCK_SWEEP_EVENT_TYPE,
]);
