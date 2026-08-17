import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FixtureRun {
  label: string;
  bundle: Record<string, unknown>;
  collectorCount: number;
}

export interface FixtureDevice {
  deviceId: string;
  runs: FixtureRun[];
}

const FIXTURES_DIR = join(__dirname, 'fixtures');

export function loadFixtures(): FixtureDevice[] {
  let deviceDirs: string[];
  try {
    deviceDirs = readdirSync(FIXTURES_DIR).filter((name) => {
      try {
        return statSync(join(FIXTURES_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  return deviceDirs
    .map((deviceId) => {
      const deviceDir = join(FIXTURES_DIR, deviceId);
      const runDirs = readdirSync(deviceDir)
        .filter((name) => {
          try {
            return statSync(join(deviceDir, name)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();

      const runs: FixtureRun[] = runDirs.map((label) => {
        const runDir = join(deviceDir, label);
        const files = readdirSync(runDir).filter((f) => f.endsWith('.json'));
        const bundle: Record<string, unknown> = {};
        for (const file of files) {
          const collector = file.replace(/\.json$/, '');
          try {
            bundle[collector] = JSON.parse(readFileSync(join(runDir, file), 'utf-8'));
          } catch {
            continue;
          }
        }
        return { label, bundle, collectorCount: Object.keys(bundle).length };
      });

      return {
        deviceId,
        runs,
      };
    })
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}
