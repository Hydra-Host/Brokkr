import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AgentUnitRenderStartupFs, AgentUnitRenderStartupLogger } from '../agent-unit-render-startup.service';
import {
  AGENT_UNIT_RENDER_STARTUP_LOGGER,
  AgentUnitRenderStartupService,
  BEGIN_MARKER,
  END_MARKER,
  MarkerImbalanceError,
  buildAgentBundleConfig,
  getAgentSystemdEnvironment,
  isSafeOperatorEnvEntry,
  mergeOperatorEnv,
} from '../agent-unit-render-startup.service';

const BASE_UNIT = [
  '[Unit]',
  'Description=Brokkr Bridge Agent',
  '',
  '[Service]',
  'Type=simple',
  'ExecStart=/usr/bin/node /opt/brokkr/agent/main.js',
  'Environment=NODE_ENV=production',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n');

describe('mergeOperatorEnv', () => {
  it('empty_env_strips_block_and_leaves_unit_as_is', () => {
    const out = mergeOperatorEnv(BASE_UNIT, {});
    expect(out).not.toContain(BEGIN_MARKER);
    expect(out).not.toContain(END_MARKER);
    expect(out).toContain('Environment=NODE_ENV=production');
    expect(out).toContain('[Install]');
    expect(out).toContain('WantedBy=multi-user.target');
  });

  it('single_env_var_inserts_block_before_install', () => {
    const out = mergeOperatorEnv(BASE_UNIT, { NODE_EXTRA_CA_CERTS: '1' });
    expect(out).toContain(BEGIN_MARKER);
    expect(out).toContain(END_MARKER);
    expect(out).toContain('Environment=NODE_EXTRA_CA_CERTS=1');

    expect(out.indexOf(BEGIN_MARKER)).toBeLessThan(out.indexOf('[Install]'));
  });

  it('multiple_env_vars_emit_one_line_each_sorted', () => {
    const out = mergeOperatorEnv(BASE_UNIT, {
      Z_LAST: 'z',
      A_FIRST: 'a',
      M_MIDDLE: 'm',
    });
    const aPos = out.indexOf('Environment=A_FIRST=a');
    const mPos = out.indexOf('Environment=M_MIDDLE=m');
    const zPos = out.indexOf('Environment=Z_LAST=z');
    expect(aPos).toBeLessThan(mPos);
    expect(mPos).toBeLessThan(zPos);
  });

  it('idempotent_re_render_replaces_existing_block', () => {
    const once = mergeOperatorEnv(BASE_UNIT, { KEY_A: '1' });
    const twice = mergeOperatorEnv(once, { KEY_A: '1' });
    expect(once).toBe(twice);
    expect(once.split(BEGIN_MARKER).length - 1).toBe(1);
    expect(once.split(END_MARKER).length - 1).toBe(1);
  });

  it('re_render_with_new_env_swaps_block', () => {
    const first = mergeOperatorEnv(BASE_UNIT, { KEY_OLD: '1' });
    const second = mergeOperatorEnv(first, { KEY_NEW: '2' });
    expect(second).not.toContain('KEY_OLD');
    expect(second).toContain('Environment=KEY_NEW=2');
    expect(second.split(BEGIN_MARKER).length - 1).toBe(1);
    expect(second.split(END_MARKER).length - 1).toBe(1);
  });

  it('re_render_with_empty_env_strips_existing_block', () => {
    const withBlock = mergeOperatorEnv(BASE_UNIT, { KEY: 'v' });
    expect(withBlock).toContain(BEGIN_MARKER);
    const stripped = mergeOperatorEnv(withBlock, {});
    expect(stripped).not.toContain(BEGIN_MARKER);
    expect(stripped).not.toContain(END_MARKER);
    expect(stripped).not.toContain('KEY');
    expect(stripped).toContain('[Service]');
    expect(stripped).toContain('[Install]');
  });

  it('marker_imbalance_raises', () => {
    const badUnit = `[Service]\n${BEGIN_MARKER}\nEnvironment=ORPHAN=1\n[Install]\n`;
    expect(() => mergeOperatorEnv(badUnit, { K: 'v' })).toThrow(MarkerImbalanceError);
    expect(() => mergeOperatorEnv(badUnit, { K: 'v' })).toThrow(/unbalanced markers/);
  });

  it('unit_without_install_section_appends_block_at_end', () => {
    const unitNoInstall = '[Service]\nExecStart=/usr/bin/true\nEnvironment=NODE_ENV=production\n';
    const out = mergeOperatorEnv(unitNoInstall, { KEY: 'v' });
    expect(out).toContain('Environment=KEY=v');
    expect(out.indexOf('[Service]')).toBeLessThan(out.indexOf(BEGIN_MARKER));
  });

  it('rejects_value_with_newline_so_service_block_is_not_corrupted', () => {
    const malicious = '1\nExecStart=/bin/rm -rf /\n[Service]\nUser=root';
    const out = mergeOperatorEnv(BASE_UNIT, { NODE_EXTRA_CA_CERTS: malicious });

    expect(out).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(out).not.toContain('ExecStart=/bin/rm');
    expect(out).not.toContain(BEGIN_MARKER);
    expect(out.split('[Service]').length - 1).toBe(1);
    expect(out).toBe(mergeOperatorEnv(BASE_UNIT, {}));
  });

  it('rejects_value_with_space_so_it_cannot_inject_a_second_env_var', () => {
    const out = mergeOperatorEnv(BASE_UNIT, { AGENT_LOG_LEVEL: 'debug INJECTED=x' });
    expect(out).not.toContain('INJECTED');
    expect(out).not.toContain('Environment=AGENT_LOG_LEVEL');
    expect(out).not.toContain(BEGIN_MARKER);
    expect(out).toBe(mergeOperatorEnv(BASE_UNIT, {}));
  });

  it('rejects_value_with_quote_or_backslash_systemd_metacharacters', () => {
    const clean = mergeOperatorEnv(BASE_UNIT, {});
    expect(mergeOperatorEnv(BASE_UNIT, { AGENT_LOG_LEVEL: 'a"b' })).toBe(clean);
    expect(mergeOperatorEnv(BASE_UNIT, { AGENT_LOG_LEVEL: "a'b" })).toBe(clean);
    expect(mergeOperatorEnv(BASE_UNIT, { AGENT_LOG_LEVEL: 'a\\b' })).toBe(clean);
  });

  it('mixed_safe_and_spaced_values_render_only_the_safe_entry_intact', () => {
    const out = mergeOperatorEnv(BASE_UNIT, {
      AGENT_LOG_LEVEL: 'debug INJECTED=x',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    });
    expect(out).not.toContain('INJECTED');
    expect(out).not.toContain('AGENT_LOG_LEVEL');
    const envLines = out.split('\n').filter((l) => l.startsWith('Environment=NODE_EXTRA_CA_CERTS'));
    expect(envLines).toEqual(['Environment=NODE_EXTRA_CA_CERTS=/etc/ca.pem']);
  });

  it('malicious_value_keeps_sha256_stable_against_empty_render', () => {
    const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
    const malicious = mergeOperatorEnv(BASE_UNIT, { AGENT_LOG_LEVEL: 'debug\r\nUser=root' });
    const clean = mergeOperatorEnv(BASE_UNIT, {});
    expect(sha(malicious)).toBe(sha(clean));
  });

  it('drops_invalid_key_but_keeps_valid_entries', () => {
    const out = mergeOperatorEnv(BASE_UNIT, {
      'BAD KEY': 'x',
      AGENT_LOG_LEVEL: 'debug',
    });
    expect(out).not.toContain('BAD KEY');
    expect(out).toContain('Environment=AGENT_LOG_LEVEL=debug');
  });
});

describe('isSafeOperatorEnvEntry', () => {
  it('accepts_plain_identifier_key_and_simple_value', () => {
    expect(isSafeOperatorEnvEntry('NODE_EXTRA_CA_CERTS', '/etc/ca.pem')).toBe(true);
  });

  it('rejects_newline_carriage_return_and_control_chars_in_value', () => {
    expect(isSafeOperatorEnvEntry('K', 'a\nb')).toBe(false);
    expect(isSafeOperatorEnvEntry('K', 'a\rb')).toBe(false);
    expect(isSafeOperatorEnvEntry('K', 'a\tb')).toBe(false);
    expect(isSafeOperatorEnvEntry('K', 'a\u0000b')).toBe(false);
  });

  it('rejects_space_and_systemd_quoting_metacharacters_in_value', () => {
    expect(isSafeOperatorEnvEntry('K', 'a b')).toBe(false);
    expect(isSafeOperatorEnvEntry('K', 'a"b')).toBe(false);
    expect(isSafeOperatorEnvEntry('K', "a'b")).toBe(false);
    expect(isSafeOperatorEnvEntry('K', 'a\\b')).toBe(false);
  });

  it('rejects_non_identifier_keys', () => {
    expect(isSafeOperatorEnvEntry('BAD KEY', 'v')).toBe(false);
    expect(isSafeOperatorEnvEntry('1LEADING', 'v')).toBe(false);
    expect(isSafeOperatorEnvEntry('A=B', 'v')).toBe(false);
  });
});

describe('buildAgentBundleConfig', () => {
  it('defaults_when_env_unset', () => {
    const cfg = buildAgentBundleConfig({});
    expect(cfg.bundlePath).toBe('/opt/brokkr/agent/main.js');
    expect(cfg.unitPath).toBe('/opt/brokkr/agent/brokkr-bridge-agent.service');
  });

  it('overrides_via_env', () => {
    const cfg = buildAgentBundleConfig({
      AGENT_BUNDLE_PATH: '/custom/bundle.js',
      AGENT_UNIT_PATH: '/custom/unit.service',
    });
    expect(cfg.bundlePath).toBe('/custom/bundle.js');
    expect(cfg.unitPath).toBe('/custom/unit.service');
  });
});

describe('getAgentSystemdEnvironment', () => {
  it('empty_when_no_passthrough_keys_set', () => {
    expect(getAgentSystemdEnvironment({})).toEqual({});
  });

  it('returns_only_allowlisted_keys', () => {
    const env = getAgentSystemdEnvironment({
      AGENT_LOG_LEVEL: 'debug',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      PATH: '/usr/bin',
      HOME: '/root',
    });
    expect(env).toEqual({
      AGENT_LOG_LEVEL: 'debug',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    });
  });

  it('skips_empty_string_values', () => {
    expect(
      getAgentSystemdEnvironment({
        AGENT_LOG_LEVEL: '',
        NODE_EXTRA_CA_CERTS: '1',
      }),
    ).toEqual({ NODE_EXTRA_CA_CERTS: '1' });
  });
});

interface FakeFsHandle extends AgentUnitRenderStartupFs {
  files: Map<string, string>;
  failReadWith: Error | null;
  failWriteWith: Error | null;
  readCalls: string[];
  writeCalls: Array<{ path: string; data: string }>;
  renameCalls: Array<{ from: string; to: string }>;
  unlinkCalls: string[];
}

function makeFakeFs(initial: Record<string, string> = {}): FakeFsHandle {
  const files = new Map<string, string>(Object.entries(initial));
  const fake: FakeFsHandle = {
    files,
    failReadWith: null,
    failWriteWith: null,
    readCalls: [],
    writeCalls: [],
    renameCalls: [],
    unlinkCalls: [],
    async readFile(path) {
      fake.readCalls.push(path);
      if (fake.failReadWith) throw fake.failReadWith;
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file '${path}'`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    async writeFile(path, data) {
      fake.writeCalls.push({ path, data });
      if (fake.failWriteWith) throw fake.failWriteWith;
      files.set(path, data);
    },
    async rename(oldPath, newPath) {
      fake.renameCalls.push({ from: oldPath, to: newPath });
      const data = files.get(oldPath);
      if (data === undefined) {
        const err = new Error(`ENOENT: no such file '${oldPath}'`) as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(oldPath);
      files.set(newPath, data);
    },
    async unlink(path) {
      fake.unlinkCalls.push(path);
      files.delete(path);
    },
  };
  return fake;
}

function makeLogger(): {
  logger: AgentUnitRenderStartupLogger;
  infos: string[];
  warns: string[];
} {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    logger: {
      info: async (msg) => {
        infos.push(msg);
      },
      warning: async (msg) => {
        warns.push(msg);
      },
    },
    infos,
    warns,
  };
}

describe('AgentUnitRenderStartupService.renderAgentUnitAtStartup', () => {
  const UNIT_PATH = '/opt/brokkr/agent/brokkr-bridge-agent.service';

  it('skips_when_unit_file_missing', async () => {
    const fs = makeFakeFs();
    const { logger, warns, infos } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {});

    await service.renderAgentUnitAtStartup('job-1');

    expect(fs.readCalls).toEqual([UNIT_PATH]);
    expect(fs.writeCalls).toEqual([]);
    expect(fs.renameCalls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('file missing');
    expect(infos).toEqual([]);
  });

  it('skips_when_read_fails_with_unexpected_error', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    fs.failReadWith = new Error('disk eaten by gremlins');
    const { logger, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {});

    await service.renderAgentUnitAtStartup('job-2');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('read failed');
    expect(warns[0]).toContain('gremlins');
    expect(fs.writeCalls).toEqual([]);
  });

  it('skips_and_warns_on_marker_imbalance', async () => {
    const bad = `[Service]\n${BEGIN_MARKER}\nEnvironment=ORPHAN=1\n[Install]\n`;
    const fs = makeFakeFs({ [UNIT_PATH]: bad });
    const { logger, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {
      NODE_EXTRA_CA_CERTS: '1',
    });

    await service.renderAgentUnitAtStartup();

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('marker imbalance');
    expect(fs.writeCalls).toEqual([]);
    expect(fs.files.get(UNIT_PATH)).toBe(bad);
  });

  it('logs_no_change_when_render_equals_input', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    const env = { NODE_EXTRA_CA_CERTS: '1' };
    const rendered = mergeOperatorEnv(BASE_UNIT, env);
    fs.files.set(UNIT_PATH, rendered);

    const { logger, infos, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, env);
    await service.renderAgentUnitAtStartup('job-3');

    expect(warns).toEqual([]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('no change');
    expect(infos[0]).toContain("'NODE_EXTRA_CA_CERTS'");
    expect(fs.writeCalls).toEqual([]);
  });

  it('writes_atomically_then_renames_on_render_diff', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    const env = { NODE_EXTRA_CA_CERTS: '1' };
    const { logger, infos } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, env);

    await service.renderAgentUnitAtStartup('job-4');

    expect(fs.writeCalls).toHaveLength(1);
    expect(fs.writeCalls[0].path).toBe(`${UNIT_PATH}.new`);
    expect(fs.renameCalls).toEqual([{ from: `${UNIT_PATH}.new`, to: UNIT_PATH }]);
    expect(fs.files.get(UNIT_PATH)).toBe(mergeOperatorEnv(BASE_UNIT, env));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('rewrote');
  });

  it('cleans_up_tmp_file_on_write_failure', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    fs.failWriteWith = new Error('disk full');
    const { logger, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {
      NODE_EXTRA_CA_CERTS: '1',
    });

    await service.renderAgentUnitAtStartup();

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('write failed');
    expect(fs.unlinkCalls).toEqual([`${UNIT_PATH}.new`]);
    expect(fs.files.get(UNIT_PATH)).toBe(BASE_UNIT);
  });

  it('swallows_unlink_error_when_cleaning_tmp_file', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    fs.failWriteWith = new Error('disk full');
    const unlinkSpy = vi.fn(async () => {
      throw new Error('cannot unlink');
    });
    fs.unlink = unlinkSpy;
    const { logger, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {
      NODE_EXTRA_CA_CERTS: '1',
    });

    await expect(service.renderAgentUnitAtStartup()).resolves.toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);
  });

  it('warns_and_does_not_emit_operator_env_value_with_newline', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    const { logger, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {
      AGENT_LOG_LEVEL: 'debug\nExecStart=/bin/sh -c pwned',
    });

    await service.renderAgentUnitAtStartup('job-evil');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('skipping operator env key=AGENT_LOG_LEVEL');
    expect(fs.writeCalls).toEqual([]);
    expect(fs.files.get(UNIT_PATH)).toBe(BASE_UNIT);
    expect(fs.files.get(UNIT_PATH)).not.toContain('pwned');
  });

  it('no_change_log_omits_dropped_keys', async () => {
    const fs = makeFakeFs({ [UNIT_PATH]: BASE_UNIT });
    const { logger, infos, warns } = makeLogger();
    const service = new AgentUnitRenderStartupService(logger, fs, {
      AGENT_LOG_LEVEL: 'debug INJECTED=x',
    });

    await service.renderAgentUnitAtStartup('job-drop');

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('skipping operator env key=AGENT_LOG_LEVEL');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('no change');
    expect(infos[0]).not.toContain('AGENT_LOG_LEVEL');
    expect(infos[0]).toContain('[]');
    expect(fs.writeCalls).toEqual([]);
  });

  it('default_job_id_is_empty_string', async () => {
    const fs = makeFakeFs();
    const service = new AgentUnitRenderStartupService(undefined, fs, {});
    await expect(service.renderAgentUnitAtStartup()).resolves.toBeUndefined();
  });

  it('silent_logger_used_when_token_not_provided', () => {
    const fs = makeFakeFs();
    expect(() => new AgentUnitRenderStartupService(undefined, fs, {})).not.toThrow();
  });
});

void AGENT_UNIT_RENDER_STARTUP_LOGGER;
