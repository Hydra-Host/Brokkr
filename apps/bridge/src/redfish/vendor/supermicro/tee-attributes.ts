import type { JsonRecord, RedfishDevice } from '../base/base.js';
import { asArray, asRecord, isEmptyRecord } from '../base/base.js';

export type SupermicroTeeSettingId =
  | 'limitPa'
  | 'tme'
  | 'tmeMt'
  | 'tmeBypass'
  | 'tdx'
  | 'seamLoader'
  | 'keySplit'
  | 'sgx'
  | 'sgxPackageInfo'
  | 'sgxFactoryReset';

export type SupermicroTeeDirection = 'enable' | 'disable';

export type SupermicroTeeSource = Pick<RedfishDevice, 'biosParams' | 'displayNameToAttr' | 'registry'>;

export interface SupermicroTeeAttribute {
  /** `AttributeName` candidates, newest board first. */
  names: readonly string[];
  /** Second tier, resolved through `device.displayNameToAttr`. */
  displayNames: readonly string[];
  /** Desired value when enabling, in display form for enumerations. */
  on: string | number;
  /** Desired value when disabling; omitted when disabling leaves the setting untouched. */
  off?: string | number;
  presence: 'required' | 'optional';
  /** One-shot action: on enable it fires only in a run that also turns this setting on. */
  firesOnceWhenEnabling?: SupermicroTeeSettingId;
}

const ATTRIBUTES = {
  limitPa: {
    names: ['LimitCPUPAto46bits', 'LimitCPUPAto46Bits'],
    displayNames: ['Limit CPU PA to 46 bits'],
    on: 'Disabled',
    off: 'Enabled',
    presence: 'optional',
  },
  tme: {
    names: ['MemoryEncryption_TME_'],
    displayNames: ['Memory Encryption (TME)'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  tmeMt: {
    names: ['TotalMemoryEncryptionMulti_Tenant_TME_MT_'],
    displayNames: ['Total Memory Encryption Multi-Tenant(TME-MT)'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  tmeBypass: {
    names: ['TotalMemoryEncryption_TME_Bypass'],
    displayNames: ['Total Memory Encryption (TME) Bypass'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'optional',
  },
  tdx: {
    names: ['TrustDomainExtensions_TDX_', 'TrustDomainExtension_TDX_'],
    displayNames: ['Trust Domain Extensions (TDX)', 'Trust Domain Extension (TDX)'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  seamLoader: {
    names: ['TDXSecureArbitrationModeLoader_SEAMLoader_'],
    displayNames: ['TDX Secure Arbitration Mode Loader (SEAM Loader)'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  keySplit: {
    names: ['TME_MT_TDXKeySplit'],
    displayNames: ['TME-MT/TDX Key Split'],
    on: 1,
    presence: 'optional',
  },
  sgx: {
    names: ['SWGuardExtensions_SGX_'],
    displayNames: ['SW Guard Extensions (SGX)'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  sgxPackageInfo: {
    names: ['SGXPackageInfoIn_BandAccess'],
    displayNames: ['SGX Package Info In-Band Access'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'required',
  },
  // reads Disabled again after it fires, so it can never look satisfied
  sgxFactoryReset: {
    names: ['SGXFactoryReset'],
    displayNames: ['SGX Factory Reset'],
    on: 'Enabled',
    off: 'Disabled',
    presence: 'optional',
    firesOnceWhenEnabling: 'sgx',
  },
} satisfies Record<SupermicroTeeSettingId, SupermicroTeeAttribute>;

export const SUPERMICRO_TEE_ATTRIBUTES: Record<SupermicroTeeSettingId, SupermicroTeeAttribute> = ATTRIBUTES;

/** Ids whose descriptor carries an `off` value; disabling leaves the others alone. */
export type SupermicroTeeDisableId = {
  [K in SupermicroTeeSettingId]: 'off' extends keyof (typeof ATTRIBUTES)[K] ? K : never;
}[SupermicroTeeSettingId];

export type SupermicroTeeStages = readonly (readonly SupermicroTeeSettingId[])[];

// resolves to never, and so fails the satisfies below, unless the staged ids are exactly Ids
type StagingExactly<Ids extends SupermicroTeeSettingId, S extends SupermicroTeeStages> = [
  Exclude<Ids, S[number][number]> | Exclude<S[number][number], Ids>,
] extends [never]
  ? S
  : never;

// each stage needs the previous one live (TME before TME-MT, TDX before SGX), hence a fence between stages
const ENABLE_STAGES = [
  ['limitPa', 'tme'],
  ['tmeMt', 'tmeBypass'],
  ['tdx', 'seamLoader'],
  ['keySplit', 'sgx', 'sgxPackageInfo'],
  ['sgxFactoryReset'],
] satisfies SupermicroTeeStages;

const DISABLE_STAGES = [
  ['sgxPackageInfo', 'sgx', 'sgxFactoryReset'],
  ['seamLoader', 'tmeBypass', 'tdx', 'tmeMt'],
  ['tme'],
  ['limitPa'],
] satisfies SupermicroTeeStages;

export const SUPERMICRO_TEE_STAGES: Record<SupermicroTeeDirection, SupermicroTeeStages> = {
  enable: ENABLE_STAGES,
  disable: DISABLE_STAGES,
} satisfies {
  enable: StagingExactly<SupermicroTeeSettingId, typeof ENABLE_STAGES>;
  disable: StagingExactly<SupermicroTeeDisableId, typeof DISABLE_STAGES>;
};

// deliberately a subset: the five settings the tee readback contract names, not every staged one
export const SUPERMICRO_TEE_VERIFY_IDS: readonly SupermicroTeeSettingId[] = [
  'tme',
  'tmeMt',
  'tdx',
  'seamLoader',
  'sgx',
];

export type SupermicroTeeFailureReason = 'absent' | 'ambiguous' | 'hidden' | 'value-not-in-vocabulary';
export type SupermicroTeeSkipReason = 'absent' | 'hidden' | 'fire-once';

export interface SupermicroTeeFailure {
  id: SupermicroTeeSettingId;
  reason: SupermicroTeeFailureReason;
  detail: string;
}

export interface SupermicroTeeSkip {
  id: SupermicroTeeSettingId;
  reason: SupermicroTeeSkipReason;
  key: string | null;
  detail: string;
}

export interface SupermicroTeeResolvedSetting {
  key: string;
  /** Every form the BMC may report for the desired value, the descriptor's own value first. */
  desired: readonly unknown[];
}

export interface SupermicroTeeResolution {
  /** One `applyTeeStage` payload per stage; satisfied settings and empty stages are dropped. */
  stages: Record<string, number | string>[];
  failures: SupermicroTeeFailure[];
  skipped: SupermicroTeeSkip[];
  /** Per resolved setting, whether or not it still needs a write. */
  resolved: Partial<Record<SupermicroTeeSettingId, SupermicroTeeResolvedSetting>>;
}

// AMI appends a form id to hidden or duplicated attributes: LimitCPUPAto46bits_F319, TME_MT_TDXKeySplit_F31D
const FORM_ID_SUFFIX = /_F[0-9A-F]{3,4}$/i;

function normalizeAttributeName(name: string): string {
  return name.replace(FORM_ID_SUFFIX, '').toLowerCase();
}

interface AttributeNameIndex {
  keys: Set<string>;
  byNormalized: Map<string, string[]>;
}

function indexAttributeNames(keys: readonly string[]): AttributeNameIndex {
  const byNormalized = new Map<string, string[]>();
  for (const key of keys) {
    const normalized = normalizeAttributeName(key);
    byNormalized.set(normalized, [...(byNormalized.get(normalized) ?? []), key]);
  }
  return { keys: new Set(keys), byNormalized };
}

export type SupermicroTeeKeyLookup = { key: string } | { reason: 'absent' | 'ambiguous'; detail: string };

function lookupKey(
  attribute: SupermicroTeeAttribute,
  index: AttributeNameIndex,
  displayNameToAttr: Record<string, string> | undefined,
): SupermicroTeeKeyLookup {
  for (const name of attribute.names) {
    if (index.keys.has(name)) return { key: name };
  }
  for (const name of attribute.names) {
    const hits = index.byNormalized.get(normalizeAttributeName(name)) ?? [];
    const [only] = hits;
    if (hits.length === 1 && only !== undefined) return { key: only };
    if (hits.length > 1) return { reason: 'ambiguous', detail: `${name} matches ${hits.join(', ')}` };
  }
  for (const displayName of attribute.displayNames) {
    const key = displayNameToAttr?.[displayName];
    if (key !== undefined && index.keys.has(key)) return { key };
  }
  return { reason: 'absent', detail: `none of ${attribute.names.join(', ')} is present` };
}

/** Resolves a descriptor against any attribute-name list with the rules the registry resolution uses. */
export function resolveAttributeName(
  attribute: SupermicroTeeAttribute,
  keys: readonly string[],
  displayNameToAttr?: Record<string, string>,
): SupermicroTeeKeyLookup {
  return lookupKey(attribute, indexAttributeNames(keys), displayNameToAttr);
}

interface DesiredValue {
  /** What to PATCH: the display form for enumerations, the value itself otherwise. */
  value: string | number;
  /** Every representation the BMC may report for it. */
  forms: unknown[];
}

function desiredValueFor(entry: JsonRecord, desired: string | number): DesiredValue | null {
  if (entry['Type'] !== 'Enumeration') return { value: desired, forms: [desired, String(desired)] };
  const option = asArray(entry['Value'])
    .map(asRecord)
    .find(
      (candidate) =>
        String(candidate['ValueName']) === String(desired) || String(candidate['ValueDisplayName']) === String(desired),
    );
  if (option === undefined) return null;
  const displayName = option['ValueDisplayName'];
  return {
    value: typeof displayName === 'string' ? displayName : desired,
    forms: [option['ValueName'], option['ValueDisplayName']].filter((form) => form !== undefined && form !== null),
  };
}

function holds(actual: unknown, forms: readonly unknown[]): boolean {
  return (
    actual !== undefined && actual !== null && forms.some((form) => form === actual || String(form) === String(actual))
  );
}

type Evaluation =
  | { resolved: false; reason: 'absent' | 'ambiguous'; detail: string }
  | { resolved: true; key: string; target: DesiredValue | null; satisfied: boolean; hidden: boolean };

export function resolveSupermicroTee(
  device: SupermicroTeeSource,
  direction: SupermicroTeeDirection,
): SupermicroTeeResolution {
  const registryIndex = indexAttributeNames(Object.keys(device.registry));
  const resolution: SupermicroTeeResolution = { stages: [], failures: [], skipped: [], resolved: {} };
  const evaluations = new Map<SupermicroTeeSettingId, Evaluation>();

  const evaluate = (id: SupermicroTeeSettingId, desired: string | number): Evaluation => {
    const cached = evaluations.get(id);
    if (cached !== undefined) return cached;
    const lookup = lookupKey(SUPERMICRO_TEE_ATTRIBUTES[id], registryIndex, device.displayNameToAttr);
    let evaluation: Evaluation;
    if (!('key' in lookup)) {
      evaluation = { resolved: false, reason: lookup.reason, detail: lookup.detail };
    } else {
      const entry = device.registry[lookup.key] ?? {};
      const target = desiredValueFor(entry, desired);
      const live = device.biosParams[lookup.key];
      const current = live !== undefined ? live : entry['CurrentValue'];
      evaluation = {
        resolved: true,
        key: lookup.key,
        target,
        satisfied: target !== null && holds(current, target.forms),
        hidden: entry['Hidden'] === true,
      };
    }
    evaluations.set(id, evaluation);
    return evaluation;
  };

  for (const stageIds of SUPERMICRO_TEE_STAGES[direction]) {
    const stage: Record<string, number | string> = {};
    for (const id of stageIds) {
      const attribute = SUPERMICRO_TEE_ATTRIBUTES[id];
      const desired = direction === 'enable' ? attribute.on : attribute.off;
      if (desired === undefined) continue;

      const evaluation = evaluate(id, desired);
      if (evaluation.resolved === false) {
        if (evaluation.reason === 'absent' && attribute.presence === 'optional') {
          resolution.skipped.push({ id, reason: 'absent', key: null, detail: evaluation.detail });
        } else {
          resolution.failures.push({ id, reason: evaluation.reason, detail: evaluation.detail });
        }
        continue;
      }

      const { key, target } = evaluation;
      resolution.resolved[id] = { key, desired: [...new Set([desired, ...(target?.forms ?? [])])] };
      if (target === null) {
        resolution.failures.push({
          id,
          reason: 'value-not-in-vocabulary',
          detail: `${key} has no value ${String(desired)}`,
        });
        continue;
      }
      if (evaluation.satisfied) continue;

      if (evaluation.hidden) {
        const detail = `${key} is hidden and not at ${String(desired)}`;
        if (attribute.presence === 'optional') {
          resolution.skipped.push({ id, reason: 'hidden', key, detail });
        } else {
          resolution.failures.push({ id, reason: 'hidden', detail });
        }
        continue;
      }

      const companion = direction === 'enable' ? attribute.firesOnceWhenEnabling : undefined;
      if (companion !== undefined) {
        const companionOn = SUPERMICRO_TEE_ATTRIBUTES[companion].on;
        const companionEvaluation = evaluate(companion, companionOn);
        if (companionEvaluation.resolved === true && companionEvaluation.satisfied) {
          resolution.skipped.push({
            id,
            reason: 'fire-once',
            key,
            detail: `${companionEvaluation.key} already ${String(companionOn)}; ${key} not re-fired`,
          });
          continue;
        }
      }

      stage[key] = target.value;
    }
    if (!isEmptyRecord(stage)) resolution.stages.push(stage);
  }

  return resolution;
}
