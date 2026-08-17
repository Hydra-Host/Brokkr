import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  envLoadBridgeSsh,
  getBridgeSshConfig,
  isBridgeSshComplete,
  resetBridgeSshConfigForTests,
  resolveEnvSecret,
  sshFingerprint,
} from '../bridge-ssh.config.js';

const VALID_PUBKEY_BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID_PUBKEY = `ssh-ed25519 ${VALID_PUBKEY_BLOB} fake@bridge`;

describe('sshFingerprint', () => {
  it('returns sha256-prefixed string for valid pubkey', () => {
    const fp = sshFingerprint(VALID_PUBKEY);
    expect(fp.startsWith('SHA256:')).toBe(true);
    expect(fp.length).toBe('SHA256:'.length + 43);
  });

  it('returns the same fingerprint for the same pubkey', () => {
    expect(sshFingerprint(VALID_PUBKEY)).toBe(sshFingerprint(VALID_PUBKEY));
  });

  it('returns empty string for malformed pubkey', () => {
    expect(sshFingerprint('not-a-pubkey')).toBe('');
    expect(sshFingerprint('ssh-ed25519 not-valid-base64!')).toBe('');
    expect(sshFingerprint('')).toBe('');
  });

  it('returns empty string when blob portion is missing', () => {
    expect(sshFingerprint('ssh-ed25519')).toBe('');
  });
});

describe('isBridgeSshComplete', () => {
  it('returns true when all fields populated', () => {
    expect(isBridgeSshComplete({ privateKey: 'p', publicKey: 'k', fingerprint: 'f' })).toBe(true);
  });

  it('returns false when any field is missing', () => {
    expect(isBridgeSshComplete({ privateKey: '', publicKey: 'k', fingerprint: 'f' })).toBe(false);
    expect(isBridgeSshComplete({ privateKey: 'p', publicKey: '', fingerprint: 'f' })).toBe(false);
    expect(isBridgeSshComplete({ privateKey: 'p', publicKey: 'k', fingerprint: '' })).toBe(false);
    expect(isBridgeSshComplete({ privateKey: '', publicKey: '', fingerprint: '' })).toBe(false);
  });
});

describe('envLoadBridgeSsh', () => {
  let tmp: string;
  let prevPriv: string | undefined;
  let prevSsh: string | undefined;
  let prevPub: string | undefined;

  beforeEach(async () => {
    prevPriv = process.env.BRIDGE_SSH_PRIVKEY_PATH;
    prevSsh = process.env.SSH_KEY_PATH;
    prevPub = process.env.BRIDGE_SSH_PUBKEY_PATH;
    delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
    delete process.env.SSH_KEY_PATH;
    delete process.env.BRIDGE_SSH_PUBKEY_PATH;
    resetBridgeSshConfigForTests();
    tmp = await mkdtemp(join(tmpdir(), 'bridge-ssh-'));
  });

  afterEach(async () => {
    if (prevPriv === undefined) delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
    else process.env.BRIDGE_SSH_PRIVKEY_PATH = prevPriv;
    if (prevSsh === undefined) delete process.env.SSH_KEY_PATH;
    else process.env.SSH_KEY_PATH = prevSsh;
    if (prevPub === undefined) delete process.env.BRIDGE_SSH_PUBKEY_PATH;
    else process.env.BRIDGE_SSH_PUBKEY_PATH = prevPub;
    resetBridgeSshConfigForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns null when privkey path unset', async () => {
    expect(await envLoadBridgeSsh()).toBeNull();
  });

  it('returns dict with derived fingerprint', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;

    const payload = await envLoadBridgeSsh();
    expect(payload).not.toBeNull();
    expect(payload?.privkey).toBe('PRIVATE-KEY-BYTES');
    expect(payload?.pubkey).toBe(VALID_PUBKEY);
    expect(payload?.fingerprint).toBe(sshFingerprint(VALID_PUBKEY));
    expect(payload?.fingerprint.startsWith('SHA256:')).toBe(true);
  });

  it('derives pubkey path from privkey path, ignoring BRIDGE_SSH_PUBKEY_PATH', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
    process.env.BRIDGE_SSH_PUBKEY_PATH = '/nowhere/this-must-be-ignored.pub';

    const payload = await envLoadBridgeSsh();
    expect(payload).not.toBeNull();
    expect(payload?.pubkey).toBe(VALID_PUBKEY);
  });

  it('returns null when privkey file missing', async () => {
    process.env.BRIDGE_SSH_PRIVKEY_PATH = join(tmp, 'does-not-exist');
    expect(await envLoadBridgeSsh()).toBeNull();
  });

  it('returns null when pubkey file missing', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
    expect(await envLoadBridgeSsh()).toBeNull();
  });

  it('returns null when files empty', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, '', 'utf-8');
    await writeFile(`${priv}.pub`, '', 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
    expect(await envLoadBridgeSsh()).toBeNull();
  });

  it('returns null when pubkey malformed', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, 'ssh-ed25519 not-valid-base64!\n', 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;
    expect(await envLoadBridgeSsh()).toBeNull();
  });

  it('SSH_KEY_PATH overrides BRIDGE_SSH_PRIVKEY_PATH', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.SSH_KEY_PATH = priv;
    process.env.BRIDGE_SSH_PRIVKEY_PATH = '/should-not-be-used';

    const payload = await envLoadBridgeSsh();
    expect(payload).not.toBeNull();
    expect(payload?.pubkey).toBe(VALID_PUBKEY);
  });
});

describe('resolveEnvSecret', () => {
  it('returns the loader payload verbatim', async () => {
    const result = await resolveEnvSecret({
      slug: 'bridge_ssh',
      envLoader: async () => ({ privkey: 'p', pubkey: 'k', fingerprint: 'f' }),
      required: true,
    });
    expect(result).toEqual({ privkey: 'p', pubkey: 'k', fingerprint: 'f' });
  });

  it('throws on missing required env with the slug name in the message', async () => {
    await expect(resolveEnvSecret({ slug: 'bridge_ssh', envLoader: async () => null, required: true })).rejects.toThrow(
      /Required env vars for slug 'bridge_ssh' are missing/,
    );
  });

  it('returns null when optional and loader returns null', async () => {
    const result = await resolveEnvSecret({
      slug: 'bridge_ssh',
      envLoader: async () => null,
      required: false,
    });
    expect(result).toBeNull();
  });
});

describe('getBridgeSshConfig', () => {
  let tmp: string;
  let prevPriv: string | undefined;
  let prevSsh: string | undefined;

  beforeEach(async () => {
    prevPriv = process.env.BRIDGE_SSH_PRIVKEY_PATH;
    prevSsh = process.env.SSH_KEY_PATH;
    delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
    delete process.env.SSH_KEY_PATH;
    resetBridgeSshConfigForTests();
    tmp = await mkdtemp(join(tmpdir(), 'get-ssh-'));
  });

  afterEach(async () => {
    if (prevPriv === undefined) delete process.env.BRIDGE_SSH_PRIVKEY_PATH;
    else process.env.BRIDGE_SSH_PRIVKEY_PATH = prevPriv;
    if (prevSsh === undefined) delete process.env.SSH_KEY_PATH;
    else process.env.SSH_KEY_PATH = prevSsh;
    resetBridgeSshConfigForTests();
    await rm(tmp, { recursive: true, force: true });
  });

  it('env values returned and fields populated', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;

    const cfg = await getBridgeSshConfig();
    expect(cfg.privateKey).toBe('PRIVATE-KEY-BYTES');
    expect(cfg.publicKey).toBe(VALID_PUBKEY);
    expect(cfg.fingerprint).toBe(sshFingerprint(VALID_PUBKEY));
  });

  it('missing env raises with the expected slug message', async () => {
    await expect(getBridgeSshConfig()).rejects.toThrow(/Required env vars for slug 'bridge_ssh' are missing/);
  });

  it('caches across calls (identity-stable)', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;

    const a = await getBridgeSshConfig();
    const b = await getBridgeSshConfig();
    expect(a).toBe(b);
  });

  it('concurrent first callers share a single resolution (single-flight)', async () => {
    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;

    const [a, b, c] = await Promise.all([getBridgeSshConfig(), getBridgeSshConfig(), getBridgeSshConfig()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('failed resolution does not poison the cache', async () => {
    await expect(getBridgeSshConfig()).rejects.toThrow();

    const priv = join(tmp, 'id_ed25519');
    await writeFile(priv, 'PRIVATE-KEY-BYTES\n', 'utf-8');
    await writeFile(`${priv}.pub`, `${VALID_PUBKEY}\n`, 'utf-8');
    process.env.BRIDGE_SSH_PRIVKEY_PATH = priv;

    const cfg = await getBridgeSshConfig();
    expect(cfg.publicKey).toBe(VALID_PUBKEY);
  });
});
