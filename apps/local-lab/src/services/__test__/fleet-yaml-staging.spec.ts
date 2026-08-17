import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProcessComposeClient } from '../process-compose.client';
import { extractFleetPaths, RenderedConfigService } from '../rendered-config.service';

const { fsMock } = vi.hoisted(
  (): {
    fsMock: {
      copies: { src: string; dst: string }[];
      renames: { tmp: string; dst: string }[];
      unlinked: string[];
      ops: string[];
    };
  } => ({ fsMock: { copies: [], renames: [], unlinked: [], ops: [] } }),
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    rmSync: vi.fn((p: string, opts?: { force?: boolean }) => {
      if (!opts?.force) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      fsMock.ops.push(`rm:${p}`);
    }),
    unlinkSync: vi.fn((p: string) => {
      fsMock.unlinked.push(p);
      fsMock.ops.push(`unlink:${p}`);
    }),
    copyFileSync: vi.fn((src: string, dst: string) => {
      fsMock.copies.push({ src, dst });
      fsMock.ops.push(`copy:${dst}`);
    }),
    renameSync: vi.fn((tmp: string, dst: string) => {
      fsMock.renames.push({ tmp, dst });
      fsMock.ops.push(`rename:${dst}`);
    }),
  };
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CFG_TEXT = [
  'environment:',
  '  - LOCAL_FLEET_SOURCE = "/nix/store/abc-fleet/fleet.yml"',
  '  - LOCAL_FLEET_PATH = "/state/local/fleet.yaml"',
  '',
].join('\n');

const writeCfg = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-staging-'));
  const cfgPath = join(dir, 'process-compose.yaml');
  writeFileSync(cfgPath, CFG_TEXT);
  return cfgPath;
};

const writeYaml = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-extract-'));
  const cfgPath = join(dir, 'process-compose.yaml');
  writeFileSync(cfgPath, text);
  return cfgPath;
};

function makeService() {
  const pc = { listAll: vi.fn(async () => []), projectUpdate: vi.fn(async () => undefined) };
  return new RenderedConfigService(pc as unknown as ProcessComposeClient);
}

describe('RenderedConfigService fleet.yml staging — D1.1 desired vs staged split', () => {
  beforeEach(() => {
    fsMock.copies = [];
    fsMock.renames = [];
    fsMock.unlinked = [];
    fsMock.ops = [];
  });

  it('renderDesiredFleetYaml copies to <sibling>.tmp then renames onto fleet.desired.yaml (never the staged fleet.yaml)', async () => {
    const svc = makeService();
    vi.spyOn(svc, 'renderedConfigPath').mockResolvedValue(writeCfg());

    const out = await svc.renderDesiredFleetYaml();

    expect(out).toBe('/state/local/fleet.desired.yaml');
    expect(fsMock.copies).toEqual([
      { src: '/nix/store/abc-fleet/fleet.yml', dst: '/state/local/fleet.desired.yaml.tmp' },
    ]);
    expect(fsMock.renames).toEqual([
      { tmp: '/state/local/fleet.desired.yaml.tmp', dst: '/state/local/fleet.desired.yaml' },
    ]);
    expect(fsMock.ops).toEqual([
      'rm:/state/local/fleet.desired.yaml.tmp',
      'copy:/state/local/fleet.desired.yaml.tmp',
      'rename:/state/local/fleet.desired.yaml',
    ]);
  });

  it('refreshFleetYaml (cfgPath override) copies to <dst>.tmp then renames onto the staged fleet.yaml', async () => {
    const svc = makeService();

    const out = await svc.refreshFleetYaml(writeCfg());

    expect(out).toBe('/state/local/fleet.yaml');
    expect(fsMock.copies).toEqual([{ src: '/nix/store/abc-fleet/fleet.yml', dst: '/state/local/fleet.yaml.tmp' }]);
    expect(fsMock.renames).toEqual([{ tmp: '/state/local/fleet.yaml.tmp', dst: '/state/local/fleet.yaml' }]);
    expect(fsMock.unlinked).toEqual([]);
    expect(fsMock.ops).toEqual([
      'rm:/state/local/fleet.yaml.tmp',
      'copy:/state/local/fleet.yaml.tmp',
      'rename:/state/local/fleet.yaml',
    ]);
  });

  it('refreshFleetYaml with no cfgPath forces a fresh eval (buildRenderedConfig refreshEvalCache)', async () => {
    const svc = makeService();
    const build = vi.spyOn(svc, 'buildRenderedConfig').mockResolvedValue(writeCfg());

    const out = await svc.refreshFleetYaml();

    expect(build).toHaveBeenCalledWith({ refreshEvalCache: true });
    expect(out).toBe('/state/local/fleet.yaml');
  });

  it('refreshFleetYaml returns null (no copy) when the forced eval fails', async () => {
    const svc = makeService();
    vi.spyOn(svc, 'buildRenderedConfig').mockRejectedValue(new Error('nix eval failed'));

    expect(await svc.refreshFleetYaml()).toBeNull();
    expect(fsMock.copies).toEqual([]);
  });

  it('applyOverlay stages the fleet.yaml atomically via tmp+rename', async () => {
    const svc = makeService();

    const out = await svc.applyOverlay(writeCfg());

    expect(out).toBe('/state/local/fleet.yaml');
    expect(fsMock.copies).toEqual([{ src: '/nix/store/abc-fleet/fleet.yml', dst: '/state/local/fleet.yaml.tmp' }]);
    expect(fsMock.unlinked).toEqual([]);
    expect(fsMock.ops).toEqual([
      'rm:/state/local/fleet.yaml.tmp',
      'copy:/state/local/fleet.yaml.tmp',
      'rename:/state/local/fleet.yaml',
    ]);
  });
});

describe('extractFleetPaths', () => {
  it('parses project-level spaced + quoted env entries', () => {
    expect(extractFleetPaths(writeCfg())).toEqual({
      source: '/nix/store/abc-fleet/fleet.yml',
      path: '/state/local/fleet.yaml',
    });
  });

  it('parses per-process bare KEY=value env entries', () => {
    const text = [
      'processes:',
      '  fleet:',
      '    environment:',
      '      - LOCAL_FLEET_SOURCE=/nix/store/xyz-fleet/fleet.yml',
      '      - LOCAL_FLEET_PATH=/state/local/fleet.yaml',
      '',
    ].join('\n');
    expect(extractFleetPaths(writeYaml(text))).toEqual({
      source: '/nix/store/xyz-fleet/fleet.yml',
      path: '/state/local/fleet.yaml',
    });
  });

  it('returns null when the markers are absent', () => {
    expect(extractFleetPaths(writeYaml('processes: {}\n'))).toBeNull();
  });

  it('returns null when the source is not a /nix/store path', () => {
    const text = [
      'environment:',
      '  - LOCAL_FLEET_SOURCE=/tmp/fleet.yml',
      '  - LOCAL_FLEET_PATH=/state/local/fleet.yaml',
      '',
    ].join('\n');
    expect(extractFleetPaths(writeYaml(text))).toBeNull();
  });
});
