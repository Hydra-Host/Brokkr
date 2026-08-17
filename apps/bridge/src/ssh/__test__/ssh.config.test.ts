import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetSshConfigForTesting,
  getSshConfig,
  loadSshConfig,
  resolveBridgeSshPrivkeyPath,
  SSHConfigError,
} from '../ssh.config';

afterEach(() => {
  _resetSshConfigForTesting();
});

describe('loadSshConfig — defaults', () => {
  it('emits the canonical SSH defaults when env is empty', () => {
    const cfg = loadSshConfig({});
    expect(cfg.defaultUsername).toBe('root');
    expect(cfg.defaultPort).toBe(22);
    expect(cfg.defaultTimeout).toBe(30);
    expect(cfg.defaultKeyPath).toBe('/privkey');
    expect(cfg.strictHostKeyChecking).toBe(true);
    expect(cfg.knownHostsPath).toBe('');
    expect(cfg.commandTimeout).toBe(300);
  });
});

describe('loadSshConfig — host-key verification', () => {
  it('SSH_STRICT_HOST_KEY_CHECKING=false disables strict checking in local/dev', () => {
    expect(loadSshConfig({ BROKKR_ENV: 'local', SSH_STRICT_HOST_KEY_CHECKING: 'false' }).strictHostKeyChecking).toBe(
      false,
    );
    expect(loadSshConfig({ BROKKR_ENV: 'dev', SSH_STRICT_HOST_KEY_CHECKING: 'FALSE' }).strictHostKeyChecking).toBe(
      false,
    );
  });

  it('any non-false value keeps strict checking on', () => {
    expect(loadSshConfig({ SSH_STRICT_HOST_KEY_CHECKING: 'true' }).strictHostKeyChecking).toBe(true);
    expect(loadSshConfig({ SSH_STRICT_HOST_KEY_CHECKING: 'yes' }).strictHostKeyChecking).toBe(true);
  });

  it('SSH_KNOWN_HOSTS_PATH is threaded through', () => {
    expect(loadSshConfig({ SSH_KNOWN_HOSTS_PATH: '/etc/ssh/known_hosts' }).knownHostsPath).toBe('/etc/ssh/known_hosts');
  });
});

describe('loadSshConfig — strict host-key env gating', () => {
  it('refuses SSH_STRICT_HOST_KEY_CHECKING=false outside local/dev/sim', () => {
    for (const environment of ['prod', 'stg']) {
      expect(() => loadSshConfig({ BROKKR_ENV: environment, SSH_STRICT_HOST_KEY_CHECKING: 'false' })).toThrow(
        SSHConfigError,
      );
      expect(() => loadSshConfig({ BROKKR_ENV: environment, SSH_STRICT_HOST_KEY_CHECKING: 'false' })).toThrow(
        /SSH_STRICT_HOST_KEY_CHECKING=false/,
      );
    }
  });

  it('refuses SSH_STRICT_HOST_KEY_CHECKING=false when no environment is set (defaults to prod)', () => {
    expect(() => loadSshConfig({ SSH_STRICT_HOST_KEY_CHECKING: 'false' })).toThrow(SSHConfigError);
  });

  it('permits SSH_STRICT_HOST_KEY_CHECKING=false in local/dev environments', () => {
    for (const environment of ['local', 'dev', 'LOCAL']) {
      expect(() => loadSshConfig({ BROKKR_ENV: environment, SSH_STRICT_HOST_KEY_CHECKING: 'false' })).not.toThrow();
    }
  });

  it('permits SSH_STRICT_HOST_KEY_CHECKING=false when LOCAL_SIMULATION_ENABLED=true regardless of env', () => {
    expect(() =>
      loadSshConfig({ BROKKR_ENV: 'prod', LOCAL_SIMULATION_ENABLED: 'true', SSH_STRICT_HOST_KEY_CHECKING: 'false' }),
    ).not.toThrow();
  });

  it('honors BROKKR_ENV over legacy ENVIRONMENT for the guard', () => {
    expect(() =>
      loadSshConfig({ BROKKR_ENV: 'local', ENVIRONMENT: 'prod', SSH_STRICT_HOST_KEY_CHECKING: 'false' }),
    ).not.toThrow();
    expect(() =>
      loadSshConfig({ BROKKR_ENV: 'prod', ENVIRONMENT: 'dev', SSH_STRICT_HOST_KEY_CHECKING: 'false' }),
    ).toThrow(SSHConfigError);
  });

  it('does not gate the secure default (strict on)', () => {
    expect(() => loadSshConfig({ BROKKR_ENV: 'prod' })).not.toThrow();
  });
});

describe('resolveBridgeSshPrivkeyPath', () => {
  it('SSH_KEY_PATH wins over BRIDGE_SSH_PRIVKEY_PATH', () => {
    const path = resolveBridgeSshPrivkeyPath({
      SSH_KEY_PATH: '/custom/key',
      BRIDGE_SSH_PRIVKEY_PATH: '/secrets/privkey',
    });
    expect(path).toBe('/custom/key');
  });

  it('BRIDGE_SSH_PRIVKEY_PATH is used when SSH_KEY_PATH is unset', () => {
    const path = resolveBridgeSshPrivkeyPath({ BRIDGE_SSH_PRIVKEY_PATH: '/secrets/privkey' });
    expect(path).toBe('/secrets/privkey');
  });

  it('empty BRIDGE_SSH_PRIVKEY_PATH falls through to null', () => {
    expect(resolveBridgeSshPrivkeyPath({ BRIDGE_SSH_PRIVKEY_PATH: '' })).toBeNull();
  });

  it('empty SSH_KEY_PATH falls through to BRIDGE_SSH_PRIVKEY_PATH', () => {
    const path = resolveBridgeSshPrivkeyPath({
      SSH_KEY_PATH: '',
      BRIDGE_SSH_PRIVKEY_PATH: '/secrets/privkey',
    });
    expect(path).toBe('/secrets/privkey');
  });

  it('both empty falls through to null', () => {
    const path = resolveBridgeSshPrivkeyPath({ SSH_KEY_PATH: '', BRIDGE_SSH_PRIVKEY_PATH: '' });
    expect(path).toBeNull();
  });
});

describe('loadSshConfig — defaultKeyPath wiring', () => {
  it('SSH_KEY_PATH explicit override wins', () => {
    const cfg = loadSshConfig({
      SSH_KEY_PATH: '/custom/key',
      BRIDGE_SSH_PRIVKEY_PATH: '/secrets/privkey',
    });
    expect(cfg.defaultKeyPath).toBe('/custom/key');
  });

  it('falls back to /privkey when both keys unset/empty', () => {
    const cfg = loadSshConfig({ SSH_KEY_PATH: '', BRIDGE_SSH_PRIVKEY_PATH: '' });
    expect(cfg.defaultKeyPath).toBe('/privkey');
  });

  it('BRIDGE_SSH_PRIVKEY_PATH supplies the path when SSH_KEY_PATH unset', () => {
    const cfg = loadSshConfig({ BRIDGE_SSH_PRIVKEY_PATH: '/secrets/privkey' });
    expect(cfg.defaultKeyPath).toBe('/secrets/privkey');
  });
});

describe('getSshConfig singleton', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getSshConfig();
    const b = getSshConfig();
    expect(a).toBe(b);
  });
});
