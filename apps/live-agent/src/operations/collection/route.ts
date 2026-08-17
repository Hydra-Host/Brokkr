import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

const FLAG_NAMES: Record<string, string> = {
  U: 'UP',
  G: 'GATEWAY',
  H: 'HOST',
  R: 'REINSTATE',
  D: 'DYNAMIC',
  M: 'MODIFIED',
  A: 'ADDRINFO',
  C: 'CACHE',
  '!': 'REJECT',
};

interface RouteEntry {
  destination: string;
  gateway: string;
  genmask: string;
  flags: string;
  flags_pretty: string[];
  metric: number;
  ref: number;
  use: number;
  iface: string;
}

function parseRouteN(output: string): RouteEntry[] {
  const lines = output.trim().split('\n');
  const dataLines = lines.slice(2);

  const rows: RouteEntry[] = [];
  for (const raw of dataLines) {
    const line = raw.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 8) continue;

    const [destination, gateway, genmask, flags, metric, ref, use, ...ifaceParts] = parts;
    rows.push({
      destination: destination ?? '',
      gateway: gateway ?? '',
      genmask: genmask ?? '',
      flags: flags ?? '',
      flags_pretty: [...(flags ?? '')].map((c) => FLAG_NAMES[c] ?? c),
      metric: Number.parseInt(metric ?? '0', 10),
      ref: Number.parseInt(ref ?? '0', 10),
      use: Number.parseInt(use ?? '0', 10),
      iface: ifaceParts.join(' '),
    });
  }
  return rows;
}

export function registerRouteCollector(): void {
  registerOperation('collection.route', async () => {
    const { stdout, exit_code, stderr } = await run('route', ['-n'], { timeout_ms: 15_000 });
    if (exit_code !== 0) {
      throw new Error(`route -n failed (exit=${exit_code}): ${stderr.trim()}`);
    }
    return { route: parseRouteN(stdout) };
  });
}
