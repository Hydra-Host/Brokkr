import { readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

export function registerVgDetector(): void {
  registerOperation('storage.detectExistingVolumeGroups', async () => {
    const { stdout, exit_code } = await run('vgs', ['--noheadings', '-o', 'vg_name'], { timeout_ms: 15_000 });
    if (exit_code !== 0) {
      return { volume_group_names: [] };
    }
    const names = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { volume_group_names: names };
  });
}

export function parseMdstatDeviceNames(mdstat: string): string[] {
  const names: string[] = [];
  for (const line of mdstat.split('\n')) {
    const m = /^(md\d+)\s*:/.exec(line.trim());
    if (m) names.push(m[1]!);
  }
  return names;
}

export function registerRaidArrayDetector(): void {
  registerOperation('storage.detectExistingRaidArrays', async () => {
    let mdstat = '';
    try {
      mdstat = await readFile('/proc/mdstat', 'utf8');
    } catch {
      return { md_device_names: [] };
    }
    return { md_device_names: parseMdstatDeviceNames(mdstat) };
  });
}
