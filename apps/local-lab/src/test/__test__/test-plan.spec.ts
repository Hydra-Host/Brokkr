import { describe, expect, it } from 'vitest';

import { fullSuitePlan, planForScenario } from '../test-plan';

describe('planForScenario (picker → plan translation)', () => {
  it('returns null for non-plan-backed scenarios', () => {
    expect(planForScenario('smoke')).toBeNull();
    expect(planForScenario('unknown')).toBeNull();
  });

  it('lifecycle-quick honors the provision/deprovision step multiselect', () => {
    expect(planForScenario('lifecycle-quick', { steps: ['provision'] })?.steps.map((s) => s.step)).toEqual([
      'provision',
      'verify-os',
    ]);
    const decomOnly = planForScenario('lifecycle-quick', { steps: ['deprovision'] })!;
    expect(decomOnly.steps.map((s) => s.step)).toEqual(['end-rental']);
    expect(decomOnly.select).toBe('any');
    const both = planForScenario('lifecycle-quick')!;
    expect(both.steps.map((s) => s.step)).toEqual(['provision', 'verify-os', 'end-rental']);
    expect(both.select).toBeUndefined();
  });

  it('lifecycle-full is the full journey ending in cleanup', () => {
    const p = planForScenario('lifecycle-full')!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'reprovision', 'power-cycle', 'end-rental']);
    expect(p.steps.at(-1)?.always).toBe(true);
  });

  it('rescue-boot threads the chosen rescue OS into rescue-activate', () => {
    const p = planForScenario('rescue-boot', { rescueOs: 'ubuntu-rescue-os' })!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'rescue-activate', 'rescue-deactivate', 'end-rental']);
    expect(p.steps[1]?.params).toEqual({ rescueOs: 'ubuntu-rescue-os' });
  });

  it('layer-test carries base + customizations onto the provision step', () => {
    const p = planForScenario('layer-test', { base: 'ubuntu-24.04', customizations: { gpuFramework: 'cuda-12' } })!;
    expect(p.steps[0]).toMatchObject({
      step: 'provision',
      params: { osSlug: 'ubuntu-24.04', customizations: { gpuFramework: 'cuda-12' } },
    });
    expect(p.steps[1]?.step).toBe('verify-layers');
  });

  it('base-os matrix expands to provision/reprovision + verify-os per slug', () => {
    const p = planForScenario('base-os-test', { baseOses: ['ubuntu-24.04', 'debian-12'] })!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'verify-os', 'reprovision', 'verify-os', 'end-rental']);
    expect(p.steps[0]?.params).toMatchObject({ osSlug: 'ubuntu-24.04' });
    expect(p.steps[2]?.params).toMatchObject({ osSlug: 'debian-12' });
    expect(p.steps.at(-1)?.always).toBe(true);
  });

  it('base-os with no slugs runs a single default-OS pass (no osSlug)', () => {
    const p = planForScenario('base-os-test')!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'verify-os', 'end-rental']);
    expect(p.steps[0]?.params).not.toHaveProperty('osSlug');
  });

  it('cloud-init carries the composed user-data onto provision + verifies it', () => {
    const p = planForScenario('cloud-init', { cloudInit: '#cloud-config\nusers: []' })!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'verify-cloud-init', 'end-rental']);
    expect(p.steps[0]?.params).toMatchObject({ cloudInit: '#cloud-config\nusers: []' });
  });

  it('custom-ipxe threads the iPXE URL onto provision-ipxe-custom', () => {
    const p = planForScenario('custom-ipxe', { ipxeUrl: 'https://boot.hydrahost.com/x.ipxe' })!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision-ipxe-custom', 'end-rental']);
    expect(p.steps[0]?.params).toEqual({ ipxeUrl: 'https://boot.hydrahost.com/x.ipxe' });
  });

  it('spoke HA scenarios map to a single composite step + cleanup', () => {
    expect(planForScenario('spoke-failover')!.steps.map((s) => s.step)).toEqual(['spoke-failover', 'end-rental']);
    expect(planForScenario('spoke-resume')!.steps.map((s) => s.step)).toEqual(['spoke-resume', 'end-rental']);
  });

  describe('fullSuitePlan', () => {
    it('with a pubkey: covers lifecycle + cloud-init + iPXE + docker-layers, ending in always-cleanup', () => {
      const p = fullSuitePlan({ operatorPubkey: 'ssh-ed25519 AAAATEST' });
      const ids = p.steps.map((s) => s.step);
      expect(ids).toEqual([
        'provision',
        'verify-os',
        'verify-disk',
        'power-cycle',
        'rescue-activate',
        'rescue-deactivate',
        'reprovision',
        'verify-cloud-init',
        'reprovision',
        'verify-os',
        'end-rental',
        'provision-ipxe-custom',
        'end-rental',
        'provision',
        'verify-layers',
        'end-rental',
      ]);
      expect(p.steps.filter((s) => s.always).length).toBe(1);
      expect(p.steps.at(-1)).toMatchObject({ step: 'end-rental', always: true });
      const ci = p.steps.find((s) => s.step === 'reprovision' && typeof s.params?.cloudInit === 'string');
      expect(String(ci?.params?.cloudInit)).toContain('ssh-ed25519 AAAATEST');
      const layers = p.steps.find((s) => s.params?.customizations);
      expect(layers?.params?.customizations).toEqual({ miscSoftware: ['docker'] });
    });

    it('without a pubkey: drops the cloud-init segment (its SSH gate could never pass)', () => {
      const ids = fullSuitePlan({ operatorPubkey: null }).steps.map((s) => s.step);
      expect(ids).not.toContain('verify-cloud-init');
    });
  });

  it('disk-layout matrix expands to provision/reprovision + verify-disk per selection', () => {
    const sel1 = { os: { group: 'g', config: 'lvm', file_system: 'ext4', mountpoint: '/' } };
    const sel2 = { os: { group: 'g', config: 'raid1', file_system: 'ext4', mountpoint: '/' } };
    const p = planForScenario('disk-layout', { diskLayouts: [sel1, sel2] })!;
    expect(p.steps.map((s) => s.step)).toEqual([
      'provision',
      'verify-disk',
      'reprovision',
      'verify-disk',
      'end-rental',
    ]);
    expect(p.steps[0]?.params).toMatchObject({ diskLayout: sel1 });
    expect(p.steps[2]?.params).toMatchObject({ diskLayout: sel2 });
  });
});
