import { BadRequestException, Injectable } from '@nestjs/common';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, type Stats, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { HOSTS, PORTS } from '../ports';
import { RunnerService } from '../runner/runner.service';

@Injectable()
export class LayerCacheService {
  constructor(private readonly runner: RunnerService) {}

  /** Must match devenv.nix's nginx proxy_cache_path. */
  private layerCacheDir(): string | null {
    const state = process.env.DEVENV_STATE;
    if (!state) return null;
    const dir = join(state, 'nginx', 'layer-cache');
    return existsSync(dir) ? dir : null;
  }

  private *walkCacheFiles(dir: string): Generator<{ path: string; stat: Stats }> {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let s: Stats;
      try {
        s = lstatSync(full);
      } catch {
        continue;
      }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        yield* this.walkCacheFiles(full);
        continue;
      }
      if (!s.isFile()) continue;
      yield { path: full, stat: s };
    }
  }

  async cachedBlobs(): Promise<{ sha: string; path: string; sizeBytes: number; mtimeMs: number }[]> {
    const dir = this.layerCacheDir();
    if (!dir) return [];
    const out: { sha: string; path: string; sizeBytes: number; mtimeMs: number }[] = [];
    const seen = new Set<string>();
    for (const { path, stat } of this.walkCacheFiles(dir)) {
      const sha = this.blobShaFromHeader(path);
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      out.push({ sha, path, sizeBytes: stat.blocks * 512, mtimeMs: Math.trunc(stat.mtimeMs) });
    }
    return out;
  }

  private blobShaFromHeader(path: string): string | null {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(1024);
      const n = readSync(fd, buf, 0, 1024, 0);
      const m = /sha256:([0-9a-f]{64})/.exec(buf.toString('latin1', 0, n));
      return m ? m[1] : null;
    } catch {
      return null;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // fd close failures (EBADF/EINTR) must not escape — honor the "empty on any error" contract.
      }
    }
  }

  async cachedBlobShas(): Promise<string[]> {
    return (await this.cachedBlobs()).map((b) => b.sha);
  }

  /** Blobs are multi-GB — stream via curl, never buffer in-process. */
  primeBlob(sha: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new BadRequestException('invalid sha256');
    const url = `http://${HOSTS.loopback}:${PORTS.nginx}/assets/sha256:${sha}`;
    const run = this.runner.create({ section: 'fleet', opId: 'prime-blob', label: `prime ${sha.slice(0, 12)}` });
    this.runner.emit(run, `\r\n[cache] priming ${url}\r\n\r\n`);
    void this.runner
      .spawn(run, 'curl', [
        '--fail',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '\\n[cache] done: HTTP %{http_code}, %{size_download} bytes in %{time_total}s\\n',
        url,
      ])
      .then((c) => this.runner.finalize(run, c));
    return run.runId;
  }

  async nukeBlob(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new BadRequestException('invalid sha256');
    const dir = this.layerCacheDir();
    if (!dir) return true;
    for (const { path } of this.walkCacheFiles(dir)) {
      if (this.blobShaFromHeader(path) !== sha) continue;
      try {
        unlinkSync(path);
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') continue; // concurrent nginx eviction
        throw e;
      }
    }
    return true;
  }
}
