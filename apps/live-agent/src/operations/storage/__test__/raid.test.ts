import { describe, expect, it } from 'vitest';
import { parseRaidTopology } from '.././raid';

describe('parseRaidTopology', () => {
  it('Dell PowerEdge R740 — PERC H730P raid controller + NVMe', () => {
    const topology = parseRaidTopology(
      [
        { name: 'pci-0000:18:00.0-scsi-0:2:0:0', target: '../../sda' },
        { name: 'pci-0000:18:00.0-scsi-0:2:1:0', target: '../../sdb' },
        { name: 'pci-0000:65:00.0-nvme-1', target: '../../nvme0n1' },
      ],
      [
        '18:00.0 Serial Attached SCSI controller [0107]: Broadcom / LSI MegaRAID Tri-Mode SAS3516 [1000:00a9] (rev 01)',
        '65:00.0 Non-Volatile memory controller [0108]: Samsung Electronics Co Ltd NVMe SSD Controller PM173X [144d:a824]',
        '00:1f.3 Audio device [0403]: Intel Corporation 400 Series Chipset Family HD Audio Controller [8086:06c8]',
      ],
    );

    expect(topology.disk_raid_status).toEqual({
      sda: true,
      sdb: true,
      nvme0n1: false,
    });
    expect(topology.controllers.map((c) => c.pci_address).sort()).toEqual(['18:00.0', '65:00.0']);
    const percController = topology.controllers.find((c) => c.pci_address === '18:00.0');
    expect(percController?.attached_disks).toEqual(['sda', 'sdb']);
  });

  it('commodity AHCI SATA box — also flagged', () => {
    const topology = parseRaidTopology(
      [
        { name: 'pci-0000:00:17.0-ata-1', target: '../../sda' },
        { name: 'pci-0000:00:17.0-ata-2', target: '../../sdb' },
      ],
      ['00:17.0 SATA controller [0106]: Intel Corporation Cannon Lake PCH SATA AHCI Controller [8086:a352] (rev 10)'],
    );

    expect(topology.disk_raid_status).toEqual({ sda: true, sdb: true });
  });

  it('no /dev/disk/by-path/ — empty map', () => {
    const topology = parseRaidTopology([], ['18:00.0 SATA controller: Intel']);
    expect(topology.disk_raid_status).toEqual({});
    expect(topology.controllers.map((c) => c.pci_address)).toEqual(['18:00.0']);
  });

  it('entries present but no matching lspci storage line — all false', () => {
    const topology = parseRaidTopology(
      [{ name: 'pci-0000:04:00.0-ata-1', target: '../../sda' }],
      ['04:00.0 Ethernet controller: Intel X550'],
    );
    expect(topology.disk_raid_status).toEqual({ sda: false });
    expect(topology.controllers).toEqual([]);
  });

  it('ignores by-path entries that do not match the pci-BDF pattern', () => {
    const topology = parseRaidTopology(
      [
        { name: 'pci-0000:04:00.0-ata-1', target: '../../sda' },
        { name: 'virtio-pci-virtio0', target: '../../vda' },
      ],
      ['04:00.0 SATA controller: Intel'],
    );
    expect(topology.disk_raid_status).toEqual({ sda: true });
    expect(topology.disk_raid_status['vda']).toBeUndefined();
  });

  it('lspci with 4-digit domain prefix — domain is stripped, disk still flagged', () => {
    const topology = parseRaidTopology(
      [{ name: 'pci-0000:49:00.0-scsi-0:2:0:0', target: '../../sda' }],
      ['0000:49:00.0 SATA controller [0106]: Marvell Technology Group Ltd. 88SE9230 [1b4b:9230] (rev 11)'],
    );
    expect(topology.disk_raid_status).toEqual({ sda: true });
    expect(topology.controllers.map((c) => c.pci_address)).toEqual(['49:00.0']);
  });

  it('mixed lspci formats — domain-prefixed and bare BDFs both parse', () => {
    const topology = parseRaidTopology(
      [
        { name: 'pci-0000:18:00.0-scsi-0:2:0:0', target: '../../sda' },
        { name: 'pci-0000:49:00.0-scsi-0:2:0:0', target: '../../sdb' },
      ],
      [
        '18:00.0 Serial Attached SCSI controller [0107]: Broadcom MegaRAID',
        '0000:49:00.0 SATA controller [0106]: Marvell 88SE9230',
      ],
    );
    expect(topology.disk_raid_status).toEqual({ sda: true, sdb: true });
    expect(topology.controllers.map((c) => c.pci_address).sort()).toEqual(['18:00.0', '49:00.0']);
  });

  it('first-seen BDF wins when duplicate by-path entries point to the same device', () => {
    const topology = parseRaidTopology(
      [
        { name: 'pci-0000:18:00.0-scsi-0:2:0:0', target: '../../sda' },
        { name: 'pci-0000:81:00.0-scsi-0:2:0:0', target: '../../sda' },
      ],
      ['18:00.0 RAID bus controller: Broadcom MegaRAID', '81:00.0 Ethernet controller: Intel'],
    );
    expect(topology.disk_raid_status).toEqual({ sda: true });
  });
});
