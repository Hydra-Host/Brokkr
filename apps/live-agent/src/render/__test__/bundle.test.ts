import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderCloudInitBundle, renderPhoneHomeCredsJson } from '../cloudinit';

type BundleInput = Parameters<typeof renderCloudInitBundle>[0];

const baseInput = (): BundleInput => ({
  hostname: 'lc-test',
  distro: 'ubuntu',
  cloudInit: {
    deviceId: '452',
    sshPubkeys: ['ssh-ed25519 AAA kent@hydra'],
    passwordHash: undefined,
    netplanYaml: 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n',
    customUserDataYaml: undefined,
    phoneHomeCreds: {
      deployment_os_token: 'brk_dev_os_test_token',
      endpoint: 'https://bridge.test/phone-home',
    },
  } as never,
  roce: { enabled: false, docaRepoUrl: '' } as never,
});

describe('renderCloudInitBundle', () => {
  it('emits the 6 file specs in the expected order with correct paths and modes', () => {
    const out = renderCloudInitBundle(baseInput());
    expect(out.map((f) => f.path)).toEqual([
      'etc/cloud/cloud.cfg',
      'var/lib/cloud/seed/nocloud/meta-data',
      'var/lib/cloud/seed/nocloud/user-data',
      'var/lib/cloud/seed/nocloud/network-config',
      'var/lib/brokkr/phone-home-creds.json',
      'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
    ]);
    expect(out.map((f) => f.mode)).toEqual([0o644, 0o644, 0o644, 0o644, 0o600, 0o700]);
  });

  it('threads deviceId into both meta-data and phone-home-creds.json', () => {
    const out = renderCloudInitBundle(baseInput());
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    expect(byPath['var/lib/cloud/seed/nocloud/meta-data']).toBe('instance-id: 452');
    const creds = JSON.parse(byPath['var/lib/brokkr/phone-home-creds.json']!);
    expect(creds.device_id).toBe('452');
  });

  it('writes the netplan_yaml verbatim to network-config', () => {
    const out = renderCloudInitBundle(baseInput());
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    expect(byPath['var/lib/cloud/seed/nocloud/network-config']).toBe(baseInput().cloudInit.netplanYaml);
  });

  it('binds phone-home bearer/endpoint as shell-quoted variables in the script', () => {
    const out = renderCloudInitBundle(baseInput());
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    const script = byPath['var/lib/cloud/scripts/per-boot/90-phone-home.sh']!;
    expect(script).toContain("DEPLOYMENT_OS_TOKEN='brk_dev_os_test_token'");
    expect(script).toContain("PHONE_HOME_ENDPOINT='https://bridge.test/phone-home'");
    expect(script).toContain('Authorization: Bearer ${DEPLOYMENT_OS_TOKEN}');
  });

  it('renders the bridge default into user-data when customer ships nothing', () => {
    const out = renderCloudInitBundle(baseInput());
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    const users = userData['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['name']).toBe('ubuntu');
    expect(users[0]!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAA kent@hydra']);
    expect(userData['hostname']).toBe('lc-test');
  });

  it('merges a customer cloud-config into the seed user-data: bridge user kept at index 0, customer user appended, no cfg.d fragment', () => {
    const customer = [
      '#cloud-config',
      'users:',
      '  - name: brokkre2e',
      '    ssh_authorized_keys:',
      '      - ssh-ed25519 AAA operator@hydra',
      'packages:',
      '  - vim',
    ].join('\n');
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect(userData['hostname']).toBe('lc-test');
    const users = userData['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['name']).toBe('ubuntu');
    expect(users[0]!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAA kent@hydra']);
    expect(users.map((u) => u['name'])).toContain('brokkre2e');
    expect(users.find((u) => u['name'] === 'brokkre2e')!['ssh_authorized_keys']).toEqual([
      'ssh-ed25519 AAA operator@hydra',
    ]);
    expect(userData['packages']).toEqual(['vim']);

    expect(byPath['etc/cloud/cloud.cfg.d/01-brokkr-custom.cfg']).toBeUndefined();
  });

  it('keeps base scalars locked when a customer tries to override them: ssh_pwauth stays false, hostname unchanged', () => {
    const customer = ['#cloud-config', 'ssh_pwauth: true', 'hostname: attacker-chosen', 'packages:', '  - vim'].join(
      '\n',
    );
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect(userData['ssh_pwauth']).toBe(false);
    expect(userData['hostname']).toBe('lc-test');
    expect(userData['packages']).toEqual(['vim']);
  });

  it('preserves the base array when a customer supplies a non-list for a list key (users: null must not wipe the bridge account)', () => {
    const customer = ['#cloud-config', 'users:', 'bootcmd:', 'runcmd:', 'packages:', '  - vim'].join('\n');
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    const users = userData['users'] as Array<Record<string, unknown>>;
    expect(users).toHaveLength(1);
    expect(users[0]!['name']).toBe('ubuntu');
    expect(userData['bootcmd']).toContain(
      "sh -c 'if [ -S /run/dbus/system_bus_socket ]; then netplan apply; else touch /run/brokkr-netplan-deferred; fi'",
    );
    expect(userData['runcmd']).toEqual(["sh -c '[ -f /run/brokkr-netplan-deferred ] && netplan apply || true'"]);
    expect(userData['packages']).toEqual(['vim']);
  });

  it('dedupes a customer user that collides with the bridge account name: one ubuntu entry, base account wins', () => {
    const customer = [
      '#cloud-config',
      'users:',
      '  - name: ubuntu',
      '    ssh_authorized_keys:',
      '      - ssh-ed25519 AAA attacker@evil',
      '  - name: brokkre2e',
      '    ssh_authorized_keys:',
      '      - ssh-ed25519 AAA operator@hydra',
    ].join('\n');
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    const users = userData['users'] as Array<Record<string, unknown>>;
    expect(users.filter((u) => u['name'] === 'ubuntu')).toHaveLength(1);
    expect(users.find((u) => u['name'] === 'ubuntu')!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAA kent@hydra']);
    expect(users.map((u) => u['name'])).toContain('brokkre2e');
  });

  it('falls back to a cloud.cfg.d fragment for non-mapping user-data (shell script), leaving the seed bridge-only', () => {
    const customer = '#!/bin/bash\necho hi';
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect((userData['users'] as unknown[]).length).toBe(1);
    expect(byPath['etc/cloud/cloud.cfg.d/01-brokkr-custom.cfg']).toBeDefined();
  });

  it('adds cloud.cfg.d/02-brokkr-roce.cfg when roce.enabled=true (user-data untouched)', () => {
    const out = renderCloudInitBundle({
      ...baseInput(),
      roce: { enabled: true, docaRepoUrl: 'https://linux.mellanox.com/repo/doca/X' },
    });
    expect(out.map((f) => f.path)).toContain('etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg');
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    const roceCfg = yaml.load(byPath['etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg']!) as Record<string, unknown>;
    const writeFiles = roceCfg['write_files'] as { path: string }[];
    const runcmd = roceCfg['runcmd'] as string[];
    expect(writeFiles.map((f) => f.path)).toContain('/etc/apt/preferences.d/doca-pin');
    expect(runcmd.some((c) => c.includes('https://linux.mellanox.com/repo/doca/X'))).toBe(true);
    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect(userData['users']).toBeDefined();
    expect(userData['write_files']).toBeUndefined();
  });

  it('adds cloud.cfg.d/03-brokkr-infiniband.cfg when infiniband.enabled=true (user-data untouched)', () => {
    const out = renderCloudInitBundle({
      ...baseInput(),
      infiniband: { enabled: true, nodeDesc: 'compute-42' },
    });
    expect(out.map((f) => f.path)).toContain('etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg');
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));
    const ibCfg = yaml.load(byPath['etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg']!) as Record<string, unknown>;
    const writeFiles = ibCfg['write_files'] as { path: string; content: string }[];
    expect(ibCfg['runcmd']).toBeUndefined();
    expect(writeFiles.map((f) => f.path)).toContain('/etc/udev/rules.d/99-infiniband-node-desc.rules');
    expect(writeFiles.map((f) => f.path)).toContain('/etc/systemd/system/brokkr-ib-node-desc.service');
    expect(writeFiles.map((f) => f.path)).toContain('/usr/local/sbin/brokkr-ib-node-desc.sh');
    expect(writeFiles.some((f) => f.content.includes('compute-42'))).toBe(true);
    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect(userData['users']).toBeDefined();
    expect(userData['write_files']).toBeUndefined();
  });

  it('merges the infiniband write_files into the seed user-data when the customer mapping carries write_files, and omits the fragment', () => {
    const customer = [
      '#cloud-config',
      'write_files:',
      '  - path: /etc/motd',
      '    content: hello',
      '    permissions: "0644"',
    ].join('\n');
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
      infiniband: { enabled: true, nodeDesc: 'compute-42' },
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    expect(byPath['etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg']).toBeUndefined();
    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    const writeFiles = userData['write_files'] as { path: string; content: string }[];
    expect(writeFiles.map((f) => f.path)).toEqual([
      '/etc/udev/rules.d/99-infiniband-node-desc.rules',
      '/etc/systemd/system/brokkr-ib-node-desc.service',
      '/usr/local/sbin/brokkr-ib-node-desc.sh',
      '/var/lib/cloud/scripts/per-instance/50-brokkr-ib-node-desc.sh',
      '/etc/motd',
    ]);
    expect(writeFiles.some((f) => f.content.includes('compute-42'))).toBe(true);
  });

  it('keeps the infiniband fragment when the customer mapping has no write_files key', () => {
    const customer = ['#cloud-config', 'packages:', '  - vim'].join('\n');
    const out = renderCloudInitBundle({
      ...baseInput(),
      cloudInit: { ...baseInput().cloudInit, customUserDataYaml: customer } as never,
      infiniband: { enabled: true, nodeDesc: 'compute-42' },
    });
    const byPath = Object.fromEntries(out.map((f) => [f.path, f.content]));

    expect(byPath['etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg']).toBeDefined();
    const userData = yaml.load(byPath['var/lib/cloud/seed/nocloud/user-data']!) as Record<string, unknown>;
    expect(userData['write_files']).toBeUndefined();
  });

  it('omits the infiniband fragment when infiniband is disabled or absent', () => {
    const disabled = renderCloudInitBundle({
      ...baseInput(),
      infiniband: { enabled: false, nodeDesc: '' },
    });
    expect(disabled.map((f) => f.path)).not.toContain('etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg');
    const absent = renderCloudInitBundle(baseInput());
    expect(absent.map((f) => f.path)).not.toContain('etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg');
  });

  it('throws clearly when phoneHomeCreds is missing', () => {
    expect(() =>
      renderCloudInitBundle({
        ...baseInput(),
        cloudInit: { ...baseInput().cloudInit, phoneHomeCreds: undefined } as never,
      }),
    ).toThrow(/phoneHomeCreds is required/);
  });
});

describe('renderPhoneHomeCredsJson', () => {
  it('emits the 3-key forensic shape', () => {
    const json = renderPhoneHomeCredsJson({
      deviceId: '452',
      phoneHomeCreds: { deployment_os_token: 'T' },
    });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(['deployment_os_token', 'device_id']);
    expect(parsed.deployment_os_token).toBe('T');
    expect(parsed.device_id).toBe('452');
  });

  it('emits 2-space indented JSON', () => {
    const json = renderPhoneHomeCredsJson({
      deviceId: '452',
      phoneHomeCreds: { deployment_os_token: 'T' },
    });
    expect(json).toBe('{\n  "deployment_os_token": "T",\n  "device_id": "452"\n}');
  });

  it('treats deviceId as a string verbatim (UUID forward-compat)', () => {
    const json = renderPhoneHomeCredsJson({
      deviceId: 'd35be446-5fc9-4c5a-b4fe-4dc83ff7eb19',
      phoneHomeCreds: { deployment_os_token: 'T' },
    });
    const parsed = JSON.parse(json);
    expect(parsed.device_id).toBe('d35be446-5fc9-4c5a-b4fe-4dc83ff7eb19');
    expect(typeof parsed.device_id).toBe('string');
  });
});
