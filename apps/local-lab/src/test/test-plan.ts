import type { Customizations, DiskLayoutSelection, PlanCatalog, PlanJson, PlanStepJson, StepSpec } from '../contract';

export interface PlanOpts {
  base?: string;
  customizations?: Customizations;
  cloudInit?: string;
  rescueOs?: string;
  baseOses?: string[];
  ipxeUrl?: string;
  diskLayouts?: DiskLayoutSelection[];
  steps?: string[];
}

export function planForScenario(id: string, opts?: PlanOpts): PlanJson | null {
  const endRental: PlanStepJson = { step: 'end-rental', always: true };
  switch (id) {
    case 'lifecycle-quick': {
      const sel = opts?.steps?.length ? opts.steps : ['provision', 'deprovision'];
      const steps: PlanStepJson[] = [];
      if (sel.includes('provision')) {
        steps.push({ step: 'provision', params: { deploymentName: 'e2e-quick' } });
        steps.push({ step: 'verify-os' });
      }
      if (sel.includes('deprovision')) steps.push(endRental);
      // Deprovision-only must target a non-INVENTORY device, else end-rental is a no-op and the run falsely passes.
      return { name: 'lifecycle-quick', ...(sel.includes('provision') ? {} : { select: 'any' }), steps };
    }
    case 'lifecycle-full':
      return {
        name: 'lifecycle-full',
        steps: [
          { step: 'provision', params: { deploymentName: 'e2e-full' } },
          { step: 'reprovision', params: { deploymentName: 'e2e-full-reprov' } },
          { step: 'power-cycle' },
          endRental,
        ],
      };
    case 'rescue-boot':
      return {
        name: 'rescue',
        steps: [
          { step: 'provision', params: { deploymentName: 'e2e-rescue' } },
          { step: 'rescue-activate', params: opts?.rescueOs ? { rescueOs: opts.rescueOs } : {} },
          { step: 'rescue-deactivate' },
          endRental,
        ],
      };
    case 'layer-test':
      return {
        name: 'layers',
        steps: [
          {
            step: 'provision',
            params: {
              deploymentName: 'e2e-layers',
              ...(opts?.base ? { osSlug: opts.base } : {}),
              customizations: opts?.customizations ?? {},
            },
          },
          { step: 'verify-layers' },
          endRental,
        ],
      };
    case 'base-os-test': {
      const slugs: (string | undefined)[] = opts?.baseOses?.length ? opts.baseOses : [undefined];
      const steps: PlanStepJson[] = [];
      slugs.forEach((slug, i) => {
        steps.push({
          step: i === 0 ? 'provision' : 'reprovision',
          params: { deploymentName: `e2e-baseos-${slug ?? 'default'}`, ...(slug ? { osSlug: slug } : {}) },
        });
        steps.push({ step: 'verify-os' });
      });
      steps.push(endRental);
      return { name: 'base-os', steps };
    }
    case 'cloud-init':
      return {
        name: 'cloud-init',
        steps: [
          {
            step: 'provision',
            params: { deploymentName: 'e2e-cloudinit', ...(opts?.cloudInit ? { cloudInit: opts.cloudInit } : {}) },
          },
          { step: 'verify-cloud-init' },
          endRental,
        ],
      };
    case 'custom-ipxe':
      return {
        name: 'custom-ipxe',
        steps: [{ step: 'provision-ipxe-custom', params: opts?.ipxeUrl ? { ipxeUrl: opts.ipxeUrl } : {} }, endRental],
      };
    case 'spoke-failover':
      return { name: 'spoke-failover', steps: [{ step: 'spoke-failover' }, endRental] };
    case 'spoke-resume':
      return { name: 'spoke-resume', steps: [{ step: 'spoke-resume' }, endRental] };
    case 'disk-layout': {
      const sels: (DiskLayoutSelection | undefined)[] = opts?.diskLayouts?.length ? opts.diskLayouts : [undefined];
      const steps: PlanStepJson[] = [];
      sels.forEach((sel, i) => {
        steps.push({
          step: i === 0 ? 'provision' : 'reprovision',
          params: { deploymentName: `e2e-disklayout-${i}`, ...(sel ? { diskLayout: sel } : {}) },
        });
        steps.push({ step: 'verify-disk' });
      });
      steps.push(endRental);
      return { name: 'disk-layout', steps };
    }
    default:
      return null;
  }
}

const PROVISION_PARAMS: StepSpec['params'] = [
  { key: 'osSlug', label: 'OS slug', kind: 'string', optional: true },
  { key: 'deploymentName', label: 'Deployment name', kind: 'string', optional: true },
  { key: 'customizations', label: 'Customizations (JSON: {group: slug|[slug]})', kind: 'json', optional: true },
  { key: 'cloudInit', label: 'Cloud-init user-data (YAML or JSON)', kind: 'string', optional: true },
  { key: 'ipxeUrl', label: 'iPXE URL', kind: 'string', optional: true },
  { key: 'diskLayout', label: 'Disk layout (JSON: {os, data})', kind: 'json', optional: true },
];

export const STEP_CATALOG: StepSpec[] = [
  { id: 'provision', label: 'Provision', params: PROVISION_PARAMS },
  { id: 'reprovision', label: 'Reprovision', params: PROVISION_PARAMS },
  { id: 'power-cycle', label: 'Power cycle', params: [] },
  {
    id: 'verify-os',
    label: 'Verify booted OS',
    params: [{ key: 'osSlug', label: 'OS slug', kind: 'string', optional: true }],
  },
  { id: 'verify-layers', label: 'Verify OS-customization layers', params: [] },
  { id: 'verify-disk', label: 'Verify disk layout', params: [] },
  {
    id: 'rescue-activate',
    label: 'Activate rescue (boot live OS)',
    params: [{ key: 'rescueOs', label: 'Rescue OS slug', kind: 'string', optional: true }],
  },
  { id: 'rescue-deactivate', label: 'Exit rescue (installed OS)', params: [] },
  {
    id: 'verify-cloud-init',
    label: 'Verify cloud-init sections',
    params: [{ key: 'user', label: 'Login user', kind: 'string', optional: true }],
  },
  {
    id: 'provision-ipxe-custom',
    label: 'Provision custom iPXE (URL stored)',
    params: [{ key: 'ipxeUrl', label: 'iPXE URL', kind: 'string', optional: true }],
  },
  { id: 'spoke-failover', label: 'Spoke failover (kill working spoke)', params: [] },
  { id: 'spoke-resume', label: 'Spoke restart-resume', params: [] },
  { id: 'end-rental', label: 'End rental → INVENTORY', params: [] },
];

function defaultCloudInit(pubkey: string): string {
  return [
    '#cloud-config',
    'users:',
    '  - name: brokkre2e',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    `      - ${pubkey}`,
    'write_files:',
    '  - path: /etc/brokkr-e2e.txt',
    '    content: "hydra-host cloud-init e2e"',
    'packages:',
    '  - sl',
    'runcmd:',
    '  - [ sh, -c, "echo cloud-init-ran > /var/log/brokkr-e2e.log" ]',
  ].join('\n');
}

/** custom-iPXE and layers each need a FRESH INVENTORY device (hence the end-rentals); layers uses docker only (sim cpu nodes have no GPU); the cloud-init segment needs the operator pubkey or verify-cloud-init's SSH gate can never pass. */
export function fullSuitePlan(opts: { operatorPubkey: string | null }): PlanJson {
  const steps: PlanStepJson[] = [
    { step: 'provision', params: { osSlug: 'ubuntu-24.04', deploymentName: 'e2e-suite' } },
    { step: 'verify-os' },
    { step: 'verify-disk' },
    { step: 'power-cycle' },
    { step: 'rescue-activate' },
    { step: 'rescue-deactivate' },
  ];
  if (opts.operatorPubkey) {
    steps.push({
      step: 'reprovision',
      params: { deploymentName: 'e2e-suite-ci', cloudInit: defaultCloudInit(opts.operatorPubkey) },
    });
    steps.push({ step: 'verify-cloud-init' });
  }
  steps.push({ step: 'reprovision', params: { osSlug: 'debian-12', deploymentName: 'e2e-suite-debian' } });
  steps.push({ step: 'verify-os' });
  steps.push({ step: 'end-rental' });
  steps.push({ step: 'provision-ipxe-custom' });
  steps.push({ step: 'end-rental' });
  steps.push({
    step: 'provision',
    params: {
      osSlug: 'ubuntu-24.04',
      deploymentName: 'e2e-suite-layers',
      customizations: { miscSoftware: ['docker'] },
    },
  });
  steps.push({ step: 'verify-layers' });
  steps.push({ step: 'end-rental', always: true });
  return { name: 'full-suite', steps };
}

const PRESET_SCENARIO_IDS = [
  'lifecycle-quick',
  'lifecycle-full',
  'base-os-test',
  'disk-layout',
  'rescue-boot',
  'custom-ipxe',
];

export function planCatalog(opts: { operatorPubkey: string | null }): PlanCatalog {
  return {
    steps: STEP_CATALOG,
    presets: PRESET_SCENARIO_IDS.flatMap((id) => {
      const plan = planForScenario(id);
      return plan ? [{ id, plan }] : [];
    }),
    fullSuite: fullSuitePlan(opts),
  };
}
