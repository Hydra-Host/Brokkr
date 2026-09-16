import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderCloudCfg,
  renderCustomUserDataCfg,
  renderInfinibandCfg,
  renderMetaData,
  renderPhoneHomeScript,
  renderRoceCfg,
  renderUserData,
} from '../cloudinit';

const FIXTURES = join(__dirname, 'fixtures');
const lcTestNoble = (name: string): string => readFileSync(join(FIXTURES, 'lc-test-noble', name), 'utf-8');
const synthetic = (name: string): string => readFileSync(join(FIXTURES, 'synthetic', name), 'utf-8');

describe('renderMetaData', () => {
  it('reproduces the captured production output for the real device fixture', () => {
    const out = renderMetaData({ deviceId: '452' });
    expect(out).toBe('instance-id: 452');
  });

  it('handles uuid-shaped device ids', () => {
    const out = renderMetaData({ deviceId: 'd35be446-5fc9-4c5a-b4fe-4dc83ff7eb19' });
    expect(out).toBe('instance-id: d35be446-5fc9-4c5a-b4fe-4dc83ff7eb19');
  });

  it('throws when deviceId is missing', () => {
    expect(() => renderMetaData({ deviceId: undefined as unknown as string })).toThrow();
  });
});

describe('renderCloudCfg', () => {
  it('reproduces the captured production output (lc-test, ubuntu)', () => {
    const out = renderCloudCfg({ distro: 'ubuntu' });
    expect(out).toBe(lcTestNoble('cloud.cfg'));
  });

  it('selects the debian system_info block when distro=debian', () => {
    const out = renderCloudCfg({ distro: 'debian' });
    expect(out).toBe(synthetic('cloud.cfg.debian'));
  });

  it('outputs empty system_info block for unknown distros', () => {
    const out = renderCloudCfg({ distro: 'fedora' });
    expect(out).toContain('system_info:');
    expect(out).not.toContain('distro: ubuntu');
    expect(out).not.toContain('distro: debian');
  });
});

describe('renderPhoneHomeScript', () => {
  it('reproduces the captured production script with the same bearer token', () => {
    const captured = lcTestNoble('90-phone-home.sh');

    const tokenMatch = captured.match(/^DEPLOYMENT_OS_TOKEN='([^']+)'$/m);
    const endpointMatch = captured.match(/^PHONE_HOME_ENDPOINT='(https?:\/\/[^']+)'$/m);
    expect(tokenMatch).not.toBeNull();
    expect(endpointMatch).not.toBeNull();

    const out = renderPhoneHomeScript({
      phoneHomeCreds: {
        deployment_os_token: tokenMatch![1]!,
        endpoint: endpointMatch![1]!,
      },
    });
    expect(out).toBe(captured);
  });

  it('binds bearer token and endpoint as shell-quoted variables consumed by curl', () => {
    const out = renderPhoneHomeScript({
      phoneHomeCreds: {
        deployment_os_token: 'TEST_TOKEN',
        endpoint: 'https://bridge.test/phone-home',
      },
    });
    expect(out).toContain("DEPLOYMENT_OS_TOKEN='TEST_TOKEN'");
    expect(out).toContain("PHONE_HOME_ENDPOINT='https://bridge.test/phone-home'");
    expect(out).toContain('Authorization: Bearer ${DEPLOYMENT_OS_TOKEN}');
    expect(out).toContain('"${PHONE_HOME_ENDPOINT}"');
  });

  it('leaves shell variable references intact (no $-interpolation by nunjucks)', () => {
    const out = renderPhoneHomeScript({
      phoneHomeCreds: { deployment_os_token: 't', endpoint: 'http://x' },
    });
    expect(out).toContain('$(date');
    expect(out).toContain('$response_code');
  });
});

describe('renderUserData', () => {
  it('renders the bridge default template when the customer ships nothing', () => {
    const out = renderUserData({
      hostname: 'lc-test',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA kent@hydra'],
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    expect(parsed['hostname']).toBe('lc-test');
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['name']).toBe('ubuntu');
    expect(users[0]!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAA kent@hydra']);
    const bootcmd = parsed['bootcmd'] as string[];
    expect(bootcmd).toContain(
      "sh -c 'if [ -S /run/dbus/system_bus_socket ]; then netplan apply; else touch /run/brokkr-netplan-deferred; fi'",
    );
    expect(bootcmd).toContain('userdel -r packer || true');
    expect(parsed['runcmd']).toEqual(["sh -c '[ -f /run/brokkr-netplan-deferred ] && netplan apply || true'"]);
  });

  it('keeps the deferred netplan apply ahead of customer runcmd entries', () => {
    const out = renderUserData({
      hostname: 'lc-test',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA kent@hydra'],
      customUserData: { runcmd: ['echo customer'] },
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    expect(parsed['runcmd']).toEqual([
      "sh -c '[ -f /run/brokkr-netplan-deferred ] && netplan apply || true'",
      'echo customer',
    ]);
  });

  it('emits both password_hash and hashed_passwd on the default user when password set', () => {
    const out = renderUserData({
      hostname: 'h-1',
      distro: 'debian',
      sshPubkeys: ['ssh-ed25519 AAA k@h'],
      passwordHash: '$6$rounds=4096$saltsalt$hashhash',
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['lock_passwd']).toBe(false);
    expect(users[0]!['passwd']).toBe('$6$rounds=4096$saltsalt$hashhash');
    expect(users[0]!['hashed_passwd']).toBe('$6$rounds=4096$saltsalt$hashhash');
  });

  it('locks the default user when no password_hash is set', () => {
    const out = renderUserData({
      hostname: 'h-1',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA k@h'],
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['lock_passwd']).toBe(true);
    expect(users[0]!['passwd']).toBeUndefined();
  });

  it('treats an empty password_hash as absent and keeps the user locked', () => {
    const out = renderUserData({
      hostname: 'h-1',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA k@h'],
      passwordHash: '',
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['lock_passwd']).toBe(true);
    expect(users[0]!['passwd']).toBeUndefined();
    expect(users[0]!['hashed_passwd']).toBeUndefined();
  });

  it('allows password access when every provided pubkey sanitizes to empty', () => {
    const out = renderUserData({
      hostname: 'h-1',
      distro: 'ubuntu',
      sshPubkeys: ['\r\n', '# only a comment\n'],
      passwordHash: '$6$rounds=4096$saltsalt$hashhash',
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['lock_passwd']).toBe(false);
    expect(users[0]!['ssh_authorized_keys']).toEqual([]);
  });

  it('sanitizes pubkeys with embedded newlines instead of corrupting the YAML', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA\nINJECT: evil\nBBB k@h'],
    });
    expect(out).toContain('ssh-ed25519 AAABBB k@h');
    expect(out).not.toMatch(/^INJECT/m);
    expect(out).not.toContain('INJECT: evil');
  });

  it('preserves the separator when a newline precedes the key comment', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAAA\nuser@host'],
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAAA user@host']);
  });

  it('keeps complete keys on separate authorized-key lines', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA first@host\nssh-rsa BBB second@host'],
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['ssh_authorized_keys']).toEqual(['ssh-ed25519 AAA first@host', 'ssh-rsa BBB second@host']);
  });

  it('sanitizes trailing newlines, CRLF, comment lines, and surrounding whitespace', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-ed25519 AAA k@h\n', 'ssh-ed25519 BBB k@h\r\n', '# comment\n  ssh-ed25519 CCC k@h  \n'],
    });
    expect(out).toContain('ssh-ed25519 AAA k@h');
    expect(out).toContain('ssh-ed25519 BBB k@h');
    expect(out).toContain('ssh-ed25519 CCC k@h');
    expect(out).not.toContain('# comment');
  });

  it('strips interior whitespace from indented wrap continuations', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['ssh-rsa AAAABBBB\n  CCCCDDDD user@host', '  # indented comment\nssh-ed25519 EEE k@h'],
    });
    expect(out).toContain('ssh-rsa AAAABBBBCCCCDDDD user@host');
    expect(out).toContain('ssh-ed25519 EEE k@h');
    expect(out).not.toContain('indented comment');
  });

  it('preserves authorized_keys options while joining wrapped key data', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['from="10.0.0.0/8",no-pty ssh-ed25519 AAAA\nBBBB user@host'],
    });
    const parsed = yaml.load(out) as Record<string, unknown>;
    const users = parsed['users'] as Array<Record<string, unknown>>;
    expect(users[0]!['ssh_authorized_keys']).toEqual(['from="10.0.0.0/8",no-pty ssh-ed25519 AAAABBBB user@host']);
  });

  it('drops keys that sanitize to empty but keeps the rest', () => {
    const out = renderUserData({
      hostname: 'h',
      distro: 'ubuntu',
      sshPubkeys: ['\n', 'ssh-ed25519 AAA k@h'],
    });
    expect(out).toContain('ssh-ed25519 AAA k@h');
  });

  it('throws when every provided pubkey sanitizes to empty', () => {
    expect(() =>
      renderUserData({
        hostname: 'h',
        distro: 'ubuntu',
        sshPubkeys: ['\r\n', '# only a comment\n'],
      }),
    ).toThrow(/sanitized to empty/);
  });
});

describe('renderCustomUserDataCfg', () => {
  it('prepends #cloud-config when the customer payload lacks the header', () => {
    const customer = 'packages:\n  - vim';
    expect(renderCustomUserDataCfg(customer)).toBe(`#cloud-config\n${customer}\n`);
  });

  it('preserves an existing #cloud-config header (no double-prefix)', () => {
    const customer = '#cloud-config\npackages:\n  - vim';
    const out = renderCustomUserDataCfg(customer)!;
    expect(out).toBe(`${customer}\n`);
    expect(out).not.toContain('#cloud-config\n#cloud-config');
  });

  it('returns null for absent or whitespace-only payloads', () => {
    expect(renderCustomUserDataCfg(undefined)).toBeNull();
    expect(renderCustomUserDataCfg('   \n\n')).toBeNull();
  });
});

describe('deploy-template injection hardening', () => {
  describe('renderPhoneHomeScript', () => {
    it('neutralizes shell metacharacters in the token (no command-substitution breakout)', () => {
      const out = renderPhoneHomeScript({
        phoneHomeCreds: {
          deployment_os_token: '"; rm -rf / #',
          endpoint: 'https://bridge.test/$(touch /pwned)`whoami`',
        },
      });
      expect(out).toContain(`DEPLOYMENT_OS_TOKEN='"; rm -rf / #'`);
      expect(out).toContain(`PHONE_HOME_ENDPOINT='https://bridge.test/$(touch /pwned)\`whoami\`'`);
      expect(out).not.toContain('Bearer "; rm');
    });

    it("escapes an embedded single quote via the '\\'' idiom", () => {
      const out = renderPhoneHomeScript({
        phoneHomeCreds: { deployment_os_token: "tok'en", endpoint: 'https://x' },
      });
      expect(out).toContain(`DEPLOYMENT_OS_TOKEN='tok'\\''en'`);
    });

    it('rejects control characters (newline) in token/endpoint at the boundary', () => {
      expect(() =>
        renderPhoneHomeScript({
          phoneHomeCreds: { deployment_os_token: 'a\nb', endpoint: 'https://x' },
        }),
      ).toThrow(/control characters/);
      expect(() =>
        renderPhoneHomeScript({
          phoneHomeCreds: { deployment_os_token: 't', endpoint: 'https://x\nrm -rf /' },
        }),
      ).toThrow(/control characters/);
    });
  });

  describe('renderUserData', () => {
    it('keeps YAML well-formed when hostname/distro contain YAML metacharacters', () => {
      const out = renderUserData({
        hostname: 'evil: value #comment',
        distro: 'ub: untu',
        sshPubkeys: ['ssh-ed25519 AAA k@h'],
      });
      const parsed = yaml.load(out) as Record<string, unknown>;
      expect(parsed['hostname']).toBe('evil: value #comment');
      const users = parsed['users'] as Array<Record<string, unknown>>;
      expect(users[0]!['name']).toBe('ub: untu');
    });

    it('rejects control characters in hostname/distro/passwordHash at the boundary', () => {
      expect(() =>
        renderUserData({ hostname: 'h\nost', distro: 'ubuntu', sshPubkeys: ['ssh-ed25519 AAA k@h'] }),
      ).toThrow(/control characters/);
      expect(() => renderUserData({ hostname: 'h', distro: 'ub\runtu', sshPubkeys: ['ssh-ed25519 AAA k@h'] })).toThrow(
        /control characters/,
      );
      expect(() =>
        renderUserData({
          hostname: 'h',
          distro: 'ubuntu',
          sshPubkeys: ['ssh-ed25519 AAA k@h'],
          passwordHash: '$6$salt$hash\ninjected: true',
        }),
      ).toThrow(/control characters/);
    });
  });

  describe('renderInfinibandCfg', () => {
    it('rejects a nodeDesc containing a single quote', () => {
      expect(renderInfinibandCfg({ enabled: true, nodeDesc: "gpu'node" })).toBeNull();
    });

    it('rejects a nodeDesc containing a newline', () => {
      expect(renderInfinibandCfg({ enabled: true, nodeDesc: 'gpu\nnode' })).toBeNull();
    });

    it('rejects a nodeDesc containing a backtick', () => {
      expect(renderInfinibandCfg({ enabled: true, nodeDesc: 'gpu`node' })).toBeNull();
    });
  });
});

describe('renderRoceCfg', () => {
  it('returns null when RoCE is disabled (no cloud.cfg.d fragment to ship)', () => {
    expect(renderRoceCfg({ enabled: false, docaRepoUrl: '' })).toBeNull();
  });

  it('emits write_files + runcmd in a cloud.cfg.d fragment when enabled', () => {
    const out = renderRoceCfg({ enabled: true, docaRepoUrl: 'https://linux.mellanox.com/repo/doca/X' });
    expect(out).not.toBeNull();
    expect(out!.startsWith('#cloud-config\n')).toBe(true);
    const parsed = yaml.load(out!) as Record<string, unknown>;
    const writeFiles = parsed['write_files'] as { path: string }[];
    const runcmd = parsed['runcmd'] as string[];
    expect(writeFiles.map((f) => f.path)).toContain('/etc/apt/preferences.d/doca-pin');
    expect(writeFiles.map((f) => f.path)).toContain('/etc/systemd/system/hydra-roce-qos.service');
    expect(runcmd.some((c) => c.includes('https://linux.mellanox.com/repo/doca/X'))).toBe(true);
  });
});

describe('renderInfinibandCfg', () => {
  it('returns null when disabled (no cloud.cfg.d fragment to ship)', () => {
    expect(renderInfinibandCfg({ enabled: false, nodeDesc: '' })).toBeNull();
  });

  it('returns null when enabled but nodeDesc is empty', () => {
    expect(renderInfinibandCfg({ enabled: true, nodeDesc: '' })).toBeNull();
  });

  it('returns null when nodeDesc contains shell metacharacters', () => {
    expect(renderInfinibandCfg({ enabled: true, nodeDesc: 'bad name!' })).toBeNull();
  });

  it('emits the udev rule + systemd oneshot + helper script + per-instance activator (no runcmd)', () => {
    const out = renderInfinibandCfg({ enabled: true, nodeDesc: 'compute-42' });
    expect(out).not.toBeNull();
    expect(out!.startsWith('#cloud-config\n')).toBe(true);
    const parsed = yaml.load(out!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('runcmd');
    const writeFiles = parsed['write_files'] as { path: string; content: string; permissions?: string }[];
    expect(writeFiles).toHaveLength(4);

    const byPath = Object.fromEntries(writeFiles.map((f) => [f.path, f]));

    expect(byPath['/etc/udev/rules.d/99-infiniband-node-desc.rules']).toBeDefined();
    expect(byPath['/etc/udev/rules.d/99-infiniband-node-desc.rules']!.content).toContain('SUBSYSTEM=="infiniband"');
    expect(byPath['/etc/udev/rules.d/99-infiniband-node-desc.rules']!.content).toContain('echo -n compute-42 %k');

    expect(byPath['/etc/systemd/system/brokkr-ib-node-desc.service']).toBeDefined();
    const unit = byPath['/etc/systemd/system/brokkr-ib-node-desc.service']!.content;
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('ExecStart=/usr/local/sbin/brokkr-ib-node-desc.sh');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=multi-user.target');

    expect(byPath['/usr/local/sbin/brokkr-ib-node-desc.sh']).toBeDefined();
    expect(byPath['/usr/local/sbin/brokkr-ib-node-desc.sh']!.permissions).toBe('0755');
    const script = byPath['/usr/local/sbin/brokkr-ib-node-desc.sh']!.content;
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain("NODE_DESC='compute-42'");
    expect(script).toContain('ls -1 /sys/class/infiniband/');
    expect(script).toContain('grep -q INIT');
    expect(script).toMatch(/for attempt in .*seq 1 12/);
    expect(script).toMatch(/if \[ "\$current" != "\$expected" \]/);
    expect(script).toContain('exit $fail');

    expect(byPath['/var/lib/cloud/scripts/per-instance/50-brokkr-ib-node-desc.sh']).toBeDefined();
    expect(byPath['/var/lib/cloud/scripts/per-instance/50-brokkr-ib-node-desc.sh']!.permissions).toBe('0755');
    const activator = byPath['/var/lib/cloud/scripts/per-instance/50-brokkr-ib-node-desc.sh']!.content;
    expect(activator).toContain('systemctl daemon-reload');
    expect(activator).toContain('systemctl enable --now brokkr-ib-node-desc.service');
  });
});
