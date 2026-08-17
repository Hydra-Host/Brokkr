import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';


const SAMPLES_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '.discovery-samples', 'data');

export interface ProdSample {
  deviceId: string;
  bundle: Record<string, unknown>;
  collectorCount: number;
}

export function loadProdSamples(): ProdSample[] {
  let collectors: string[];
  try {
    collectors = readdirSync(SAMPLES_ROOT).filter((name) => {
      try {
        return statSync(join(SAMPLES_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  const byDevice = new Map<string, Record<string, unknown>>();

  for (const collector of collectors) {
    const dir = join(SAMPLES_ROOT, collector);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (id.length === 0) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch {
        continue;
      }

      let bundle = byDevice.get(id);
      if (!bundle) {
        bundle = {};
        byDevice.set(id, bundle);
      }
      bundle[collector] = raw;
    }
  }

  return [...byDevice.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([deviceId, bundle]) => ({
      deviceId,
      bundle,
      collectorCount: Object.keys(bundle).length,
    }));
}
