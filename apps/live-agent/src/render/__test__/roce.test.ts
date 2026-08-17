import { describe, expect, it } from 'vitest';
import {
  DOCA_APT_PIN,
  HYDRA_ACS_DISABLE_SERVICE,
  HYDRA_ROCE_ECMP_SERVICE,
  HYDRA_ROCE_ECMP_SH,
  HYDRA_ROCE_QOS_SERVICE,
  renderRoceUserDataExtras,
} from '../roce/index';

const ENABLED = { enabled: true, docaRepoUrl: 'https://linux.mellanox.com/public/repo/doca/3.0.0/ubuntu24.04/amd64' };

describe('renderRoceUserDataExtras when disabled', () => {
  it('returns empty arrays so the caller can merge unconditionally', () => {
    const out = renderRoceUserDataExtras({ roce: { enabled: false, docaRepoUrl: '' } });
    expect(out.writeFiles).toEqual([]);
    expect(out.runcmd).toEqual([]);
  });

  it('ignores docaRepoUrl when enabled=false (no leak)', () => {
    const out = renderRoceUserDataExtras({
      roce: { enabled: false, docaRepoUrl: 'https://malicious.example/repo' },
    });
    expect(out.writeFiles).toEqual([]);
    expect(out.runcmd).toEqual([]);
  });
});

describe('renderRoceUserDataExtras when enabled', () => {
  it('emits the 5 expected write_files entries', () => {
    const out = renderRoceUserDataExtras({ roce: ENABLED });
    expect(out.writeFiles).toHaveLength(5);
    expect(out.writeFiles.map((f) => f.path)).toEqual([
      '/etc/apt/preferences.d/doca-pin',
      '/etc/systemd/system/hydra-roce-qos.service',
      '/etc/systemd/system/hydra-acs-disable.service',
      '/etc/systemd/system/hydra-roce-ecmp.service',
      '/usr/local/sbin/hydra-roce-ecmp.sh',
    ]);
  });

  it('uses 0755 for the shell script and 0644 for config files', () => {
    const out = renderRoceUserDataExtras({ roce: ENABLED });
    const byPath = Object.fromEntries(out.writeFiles.map((f) => [f.path, f.permissions]));
    expect(byPath['/etc/apt/preferences.d/doca-pin']).toBe('0644');
    expect(byPath['/etc/systemd/system/hydra-roce-qos.service']).toBe('0644');
    expect(byPath['/etc/systemd/system/hydra-acs-disable.service']).toBe('0644');
    expect(byPath['/etc/systemd/system/hydra-roce-ecmp.service']).toBe('0644');
    expect(byPath['/usr/local/sbin/hydra-roce-ecmp.sh']).toBe('0755');
  });

  it('embeds the bundled assets byte-identical to the originals', () => {
    const out = renderRoceUserDataExtras({ roce: ENABLED });
    const byPath = Object.fromEntries(out.writeFiles.map((f) => [f.path, f.content]));
    expect(byPath['/etc/apt/preferences.d/doca-pin']).toBe(DOCA_APT_PIN);
    expect(byPath['/etc/systemd/system/hydra-roce-qos.service']).toBe(HYDRA_ROCE_QOS_SERVICE);
    expect(byPath['/etc/systemd/system/hydra-acs-disable.service']).toBe(HYDRA_ACS_DISABLE_SERVICE);
    expect(byPath['/etc/systemd/system/hydra-roce-ecmp.service']).toBe(HYDRA_ROCE_ECMP_SERVICE);
    expect(byPath['/usr/local/sbin/hydra-roce-ecmp.sh']).toBe(HYDRA_ROCE_ECMP_SH);
  });

  it('emits the 5 expected runcmd entries in order', () => {
    const out = renderRoceUserDataExtras({ roce: ENABLED });
    expect(out.runcmd).toHaveLength(5);
    expect(out.runcmd[0]).toContain('GPG-KEY-Mellanox.pub');
    expect(out.runcmd[0]).toContain('gpg --dearmor');
    expect(out.runcmd[2]).toBe('apt-get update -y');
    expect(out.runcmd[3]).toContain('apt-get install -y mft kernel-mft-dkms dkms');
    expect(out.runcmd[4]).toBe(
      'systemctl daemon-reload && systemctl enable --now hydra-roce-qos.service hydra-acs-disable.service hydra-roce-ecmp.service',
    );
  });

  it('substitutes the bridge-provided docaRepoUrl into the apt sources entry', () => {
    const out = renderRoceUserDataExtras({ roce: ENABLED });
    expect(out.runcmd[1]).toContain(ENABLED.docaRepoUrl);
    expect(out.runcmd[1]).toContain('signed-by=/etc/apt/trusted.gpg.d/GPG-KEY-Mellanox.pub');
    expect(out.runcmd[1]).toContain('/etc/apt/sources.list.d/doca.list');
  });

  it('different repo URLs produce different runcmd output (no caching bug)', () => {
    const a = renderRoceUserDataExtras({
      roce: { enabled: true, docaRepoUrl: 'https://example.test/A' },
    });
    const b = renderRoceUserDataExtras({
      roce: { enabled: true, docaRepoUrl: 'https://example.test/B' },
    });
    expect(a.runcmd[1]).toContain('https://example.test/A');
    expect(b.runcmd[1]).toContain('https://example.test/B');
  });
});

describe('bundled RoCE static assets (sanity)', () => {
  it('hydra-roce-qos.service contains the expected mlnx_qos exec line', () => {
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('mlnx_qos');
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('[Unit]');
    expect(HYDRA_ROCE_QOS_SERVICE).toContain('[Install]');
  });

  it('hydra-acs-disable.service contains the setpci PCIe ACS sequence', () => {
    expect(HYDRA_ACS_DISABLE_SERVICE).toContain('setpci');
    expect(HYDRA_ACS_DISABLE_SERVICE).toContain('ECAP_ACS');
  });

  it('hydra-roce-ecmp.sh is a bash script and references the ECMP rails', () => {
    expect(HYDRA_ROCE_ECMP_SH).toMatch(/^#!\/bin\/bash/);
    expect(HYDRA_ROCE_ECMP_SH).toContain('rail_a');
    expect(HYDRA_ROCE_ECMP_SH).toContain('rail_b');
  });
});
