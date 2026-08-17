import type { SagaContext } from './saga.types';

export type SkipResult = { skipped: true; reason: string };

// Non-object brokkr_live_check is corrupt saga state: throw — treating it as not-ready would power-cycle hardware.
function requireMapping(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value === null ? 'null' : 'undefined'} (expected object)`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected object, got ${Array.isArray(value) ? 'Array' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

// Never skip after a rewind or a fresh deploy_os — both invalidate an earlier readiness check.
export function skipIfBrokkrLiveReady(ctx: SagaContext): SkipResult | null {
  const rewound = ctx.metadata['rewound'] ?? false;
  if (rewound !== null && rewound !== undefined && rewound !== false && rewound !== 0 && rewound !== '') return null;
  const deployOs = ctx.stepResults['deploy_os'] ?? undefined;
  if (deployOs !== null && deployOs !== undefined && deployOs !== false && deployOs !== 0 && deployOs !== '')
    return null;
  const checkResult = requireMapping(ctx.stepResults['brokkr_live_check'] ?? {});
  const ready = checkResult['ready'] ?? false;
  if (ready !== null && ready !== undefined && ready !== false && ready !== 0 && ready !== '') {
    return { skipped: true, reason: 'Brokkr Live already running' };
  }
  return null;
}
