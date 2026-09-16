import { BadRequestException, Injectable } from '@nestjs/common';
import { LayersManifestSchema, type LayersManifest } from '@repo/local-lab-contract';
import { join } from 'node:path';

import { getErrorMessage } from '@repo/utils';
import { URLS } from '../ports';
import { RunnerService } from '../runner/runner.service';
import { OverlayStoreService } from '../services/overlay-store';

const MANIFEST_UA = 'local-environment/1.0';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_MANIFEST_REDIRECTS = 5;
const ASSET_ENVS = ['dev', 'stg', 'prod'];

// the bare asset host is an alias that redirects to its env-qualified deployment, and every redirect
// hop is re-checked against this allowlist — so the siblings belong in it alongside the origin.
function assetEnvSiblings(host: string): string[] {
  const labels = host.toLowerCase().split('.');
  if (labels.length < 3 || labels.some((l) => ASSET_ENVS.includes(l))) return [];
  const at = labels.length - 2;
  return ASSET_ENVS.map((env) => [...labels.slice(0, at), env, ...labels.slice(at)].join('.'));
}

@Injectable()
export class LayersService {
  constructor(
    private readonly runner: RunnerService,
    private readonly overlay: OverlayStoreService,
  ) {}

  layersDefaultUrl(): string {
    if (process.env.SIM_OS_LAYERS_MANIFEST_INDEX_URL) return process.env.SIM_OS_LAYERS_MANIFEST_INDEX_URL;
    const originHost = this.overlay.originHost();
    return originHost ? `https://${originHost}/os-layers/releases/latest` : '';
  }

  layersAllowedHosts(): Set<string> {
    const hosts = new Set<string>();
    const add = (h: string | undefined): void => {
      if (h) hosts.add(h.toLowerCase());
    };
    try {
      add(new URL(process.env.SIM_OS_LAYERS_MANIFEST_INDEX_URL ?? '').host);
    } catch {
      // an unparseable/empty SIM URL contributes no host
    }
    const origin = this.overlay.originHost();
    add(origin);
    for (const sibling of assetEnvSiblings(origin)) add(sibling);
    for (const h of (process.env.LAB_LAYERS_ALLOWED_HOSTS ?? '').split(/[\s,]+/)) add(h);
    return hosts;
  }

  private assertAllowedManifestUrl(raw: string, allowed: Set<string>): URL {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BadRequestException(`invalid manifest URL: ${raw}`);
    }
    if (u.protocol !== 'https:') throw new BadRequestException(`manifest URLs must be https (got ${u.protocol}//)`);
    if (!allowed.has(u.host.toLowerCase()) && !allowed.has(u.hostname.toLowerCase()))
      throw new BadRequestException(
        `manifest host '${u.host}' is not allowed (allowed: ${[...allowed].join(', ') || 'none configured'}) — set LAB_LAYERS_ALLOWED_HOSTS to extend`,
      );
    return u;
  }

  private async fetchJson(startUrl: string, allowed: Set<string>): Promise<unknown> {
    // follow redirects manually so every hop passes the same allowlist + https gate as the initial URL.
    let current = startUrl;
    for (let hops = 0; hops <= MAX_MANIFEST_REDIRECTS; hops++) {
      let res: Response;
      try {
        res = await fetch(current, {
          headers: { 'User-Agent': MANIFEST_UA },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        throw new BadRequestException(`manifest load failed: ${getErrorMessage(e)}`);
      }
      if (REDIRECT_STATUS.has(res.status)) {
        const location = res.headers.get('location');
        if (!location)
          throw new BadRequestException(`manifest load failed: redirect from ${current} without a Location header`);
        current = new URL(location, current).toString();
        this.assertAllowedManifestUrl(current, allowed);
        continue;
      }
      if (!res.ok) throw new BadRequestException(`manifest load failed: HTTP ${res.status} for ${current}`);
      try {
        return await res.json();
      } catch (e) {
        throw new BadRequestException(`manifest load failed: ${getErrorMessage(e)}`);
      }
    }
    throw new BadRequestException('manifest load failed: too many redirects');
  }

  private isReleaseIndex(doc: unknown): doc is { url: string } {
    if (typeof doc !== 'object' || doc === null) return false;
    if ('layers' in doc) return false;
    return 'url' in doc && typeof doc.url === 'string';
  }

  private async resolveManifest(target: string, allowed: Set<string>): Promise<{ resolvedUrl: string; raw: unknown }> {
    this.assertAllowedManifestUrl(target, allowed);
    let resolvedUrl = target;
    let raw = await this.fetchJson(target, allowed);
    if (this.isReleaseIndex(raw)) {
      // the index body is remote data — re-check so an allowlisted index can't bounce the fetcher anywhere
      this.assertAllowedManifestUrl(raw.url, allowed);
      resolvedUrl = raw.url;
      raw = await this.fetchJson(resolvedUrl, allowed);
    }
    return { resolvedUrl, raw };
  }

  async fetchManifest(url?: string): Promise<{ resolvedUrl: string; doc: LayersManifest }> {
    const target = url?.trim() ? url.trim() : this.layersDefaultUrl();
    if (!target)
      throw new BadRequestException('no manifest URL provided and no default OS-layers manifest URL is configured');
    const { resolvedUrl, raw } = await this.resolveManifest(target, this.layersAllowedHosts());
    const parsed = LayersManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'unknown validation error';
      throw new BadRequestException(`manifest at ${resolvedUrl} does not match the expected shape: ${detail}`);
    }
    return { resolvedUrl, doc: parsed.data };
  }

  async resolveManifestUrl(url: string): Promise<string> {
    return (await this.resolveManifest(url, this.layersAllowedHosts())).resolvedUrl;
  }

  seedManifest(url: string): string {
    this.assertAllowedManifestUrl(url, this.layersAllowedHosts());
    const run = this.runner.create({ section: 'fleet', opId: 'seed-layers', label: 'seed layers ← manifest' });
    this.runner.emit(run, `\r\n[seed] resolving manifest from ${url} …\r\n`);
    void (async () => {
      let manifestUrl = url;
      try {
        manifestUrl = await this.resolveManifestUrl(url);
      } catch (e) {
        this.runner.emit(run, `[seed] resolve failed (using URL as-is): ${getErrorMessage(e)}\r\n`);
      }
      const hubApi = join(process.env.HUB_REPO_PATH ?? '', 'apps/api');
      const dbUrl = process.env.HUB_DATABASE_URL ?? URLS.pg;
      const hhEnv = process.env.HH_ENV ?? 'dev';
      this.runner.emit(run, `[seed] tsx seed-from-manifest --url=${manifestUrl}  (HH_ENV=${hhEnv})\r\n\r\n`);
      const code = await this.runner.spawn(
        run,
        'pnpm',
        ['exec', 'tsx', 'src/scripts/layers/seed-from-manifest.ts', '--seed-script', `--url=${manifestUrl}`],
        { DATABASE_URL: dbUrl, HH_ENV: hhEnv },
        { cwd: hubApi },
      );
      this.runner.finalize(run, code);
    })();
    return run.runId;
  }
}
