import { access, readdir, readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';

const MELLANOX_PCI_SPEED_MAP: Record<string, readonly [string, number]> = {
  '0x1023': ['ConnectX-8', 800],
  '0x1021': ['ConnectX-7', 400],
  '0xa2d6': ['ConnectX-7', 400],
  '0x101d': ['ConnectX-6 Dx', 200],
  '0x101f': ['ConnectX-6 Dx', 200],
  '0x101b': ['ConnectX-6', 200],
  '0x101e': ['ConnectX-6 Lx', 100],
  '0x1019': ['ConnectX-5 Ex', 100],
  '0x1017': ['ConnectX-5', 100],
  '0x1018': ['ConnectX-5', 100],
  '0x1015': ['ConnectX-4 Lx', 50],
  '0x1016': ['ConnectX-4 Lx', 50],
  '0x1013': ['ConnectX-4', 100],
  '0x1014': ['ConnectX-4', 100],
  '0x1007': ['ConnectX-3 Pro', 56],
  '0x1003': ['ConnectX-3', 40],
};

async function readOrNull(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

function rateToKbps(rate: string): number {
  const m = rate.match(/(\d+)\s*Gb\/sec/);
  return m && m[1] ? Number.parseInt(m[1], 10) * 1_000_000 : 0;
}

export function registerIbDataCollector(): void {
  registerOperation('collection.ib_data', async () => {
    try {
      await access('/sys/class/infiniband');
    } catch {
      return { ib_data: [] };
    }

    let entries: string[];
    try {
      entries = await readdir('/sys/class/infiniband');
    } catch {
      return { ib_data: [] };
    }

    const devices = entries.filter((d) => d.startsWith('mlx5_'));
    if (devices.length === 0) {
      return { ib_data: [] };
    }

    const results = [];
    for (const dev of devices) {
      const base = `/sys/class/infiniband/${dev}`;

      const guid = await readOrNull(`${base}/node_guid`);
      const rate = await readOrNull(`${base}/ports/1/rate`);
      const link_type = await readOrNull(`${base}/ports/1/link_layer`);
      const port_state = await readOrNull(`${base}/ports/1/state`);
      const port_phys_state = await readOrNull(`${base}/ports/1/phys_state`);
      const pci_device_id = await readOrNull(`${base}/device/device`);

      const speed_kbps = rate ? rateToKbps(rate) : 0;
      const link_oper_up = (port_state ?? '').toUpperCase().includes('ACTIVE');
      const link_physical_up = (port_phys_state ?? '').toUpperCase().replace(/\s+/g, '').includes('LINKUP');

      const hwSpec = pci_device_id ? MELLANOX_PCI_SPEED_MAP[pci_device_id] : undefined;
      const max_speed_gbps = hwSpec ? hwSpec[1] : null;
      const max_speed_kbps = max_speed_gbps ? max_speed_gbps * 1_000_000 : 0;

      results.push({
        mlx5_name: dev,
        guid,
        speed: rate,
        speed_kbps,
        link_type,
        port_state,
        link_oper_up,
        port_phys_state,
        link_physical_up,
        pci_device_id,
        max_speed_gbps,
        max_speed_kbps,
      });
    }

    return { ib_data: results };
  });
}
