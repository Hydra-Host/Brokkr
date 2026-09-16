export const BOOT_SEVERITIES: readonly ['error', 'warn', 'info'] = ['error', 'warn', 'info'];
export type BootSeverity = (typeof BOOT_SEVERITIES)[number];

export interface BootCodeSpec {
  code: string;
  severity: BootSeverity;
  title: string;
  /** Names the field and the page or command that fixes it. Read by an operator with no repo access. */
  remedy: string;
}

const CODES = {
  'PXE-01': {
    code: 'PXE-01',
    severity: 'error',
    title: 'No iPXE EFI binary for a served architecture',
    remedy:
      'Run the iPXE build for every architecture in DISCOVERY_ARCHITECTURES, or drop the unbuilt architecture from that variable.',
  },
  'PXE-02': {
    code: 'PXE-02',
    severity: 'error',
    title: 'BRIDGE_URL is unusable as a chain address',
    remedy:
      'Set BRIDGE_URL to the bridge provisioning-NIC address, for example http://10.0.1.2:8000. A loopback address or a public name cannot be reached by a booting machine.',
  },
  'PXE-04': {
    code: 'PXE-04',
    severity: 'warn',
    title: 'Proxy DHCP with no declared authoritative peer',
    remedy:
      'Tick the external authoritative DHCP server box on the prefix DHCP settings in the hub, or set the prefix mode to AUTHORITATIVE.',
  },
  'PXE-06': {
    code: 'PXE-06',
    severity: 'error',
    title: 'Discovery boot files missing for a served architecture',
    remedy:
      'Sync vmlinuz, initrd.img and brokkr-discovery.iso for every served architecture, or drop the architecture from DISCOVERY_ARCHITECTURES.',
  },
  'PXE-07': {
    code: 'PXE-07',
    severity: 'error',
    title: 'The advertised chain host does not resolve',
    remedy:
      'Advertise a resolver on a prefix, or set BRIDGE_URL to an address literal so a booting machine does not depend on DNS.',
  },
  'PXE-101': {
    code: 'PXE-101',
    severity: 'error',
    title: 'Client requested legacy BIOS network boot',
    remedy:
      'Set the machine firmware to UEFI and disable CSM. The bridge serves UEFI iPXE only and ships no legacy build.',
  },
  'PXE-102': {
    code: 'PXE-102',
    severity: 'error',
    title: 'No DHCP subnet is built for this segment',
    remedy:
      'Set a DHCP mode on the prefix that contains the bridge address, in the hub prefix DHCP settings. An unset mode serves nothing.',
  },
  'PXE-103': {
    code: 'PXE-103',
    severity: 'error',
    title: 'The prefix offers no boot file',
    remedy:
      'Select an iPXE build target on the prefix DHCP settings. Without one the bridge assigns addresses and offers no boot file.',
  },
  'PXE-104': {
    code: 'PXE-104',
    severity: 'error',
    title: 'The proxy MAC allowlist excludes this machine',
    remedy:
      'Add the machine PXE MAC to the prefix proxy allowlist in the hub. An empty allowlist admits only already-known devices.',
  },
  'PXE-105': {
    code: 'PXE-105',
    severity: 'error',
    title: 'The bridge is not answering DHCP',
    remedy:
      'Check that this bridge holds leadership and finished lease hydration. A follower or an unhydrated bridge drops every packet.',
  },
  'PXE-106': {
    code: 'PXE-106',
    severity: 'error',
    title: 'The PXE MAC and the BMC address name different devices',
    remedy:
      'Correct the machine PXE MAC in the fleet configuration, or re-seed the identity, so one hub device owns both addresses.',
  },
  'PXE-107': {
    code: 'PXE-107',
    severity: 'warn',
    title: 'A readiness check could not be evaluated',
    remedy:
      'The subject of the check was unreachable, so its result is unknown rather than passing. Retry once the bridge and hub are both reachable.',
  },
  'PXE-108': {
    code: 'PXE-108',
    severity: 'error',
    title: 'The iPXE binaries carry no bake stamp',
    remedy:
      'Rebuild the iPXE binaries so the bake records its chain host — the control center iPXE build, or `task up`. Unstamped binaries may chain anywhere.',
  },
  'PXE-109': {
    code: 'PXE-109',
    severity: 'error',
    title: 'The iPXE binaries are baked for another chain host',
    remedy:
      'Rebuild the iPXE binaries against the current BRIDGE_URL — the control center iPXE build, or `task up` — so the chainloader targets this bridge.',
  },
  'PXE-110': {
    code: 'PXE-110',
    severity: 'error',
    title: 'The bridge heard this machine and refused it',
    remedy:
      'The machine sent a PXE request that the proxy allowlist refused, so cabling and firmware are fine. Add its PXE MAC to the prefix proxy allowlist in the hub prefix DHCP settings.',
  },
  'PXE-111': {
    code: 'PXE-111',
    severity: 'warn',
    title: 'No PXE request from this machine has reached the bridge',
    remedy:
      'Power the machine on with a network boot. If it stays silent, check the cable, the firmware boot order, and that the machine shares a segment with the bridge uplink.',
  },
  'PXE-112': {
    code: 'PXE-112',
    severity: 'error',
    title: 'The uplink prefix is AUTHORITATIVE on a LAN that already has a DHCP server',
    remedy:
      'Open the prefix that contains the bridge uplink address in the hub prefix DHCP settings, set the DHCP mode to PROXY and tick the external authoritative DHCP server box. In AUTHORITATIVE mode the bridge would lease addresses against your router.',
  },
  'PXE-113': {
    code: 'PXE-113',
    severity: 'error',
    title: "No full-flavor discovery image is synced for this machine's architecture",
    remedy:
      'A real machine boots the full brokkr-live image; the light image is for devices tagged discovery-light (the simulated VMs). Enable the bare-metal plane so the spoke syncs the full tree, then re-sync from the control center Storage page.',
  },
} satisfies Record<string, BootCodeSpec>;

export type BootCode = keyof typeof CODES;

export const BOOT_CODES: Readonly<Record<BootCode, BootCodeSpec>> = Object.freeze(CODES);

function isBootCode(key: string): key is BootCode {
  return key in CODES;
}

const [first, ...rest] = Object.keys(CODES).filter(isBootCode);
if (first === undefined) throw new Error('empty boot code registry');

export const BOOT_CODE_LIST: readonly [BootCode, ...BootCode[]] = [first, ...rest];

export interface BootFinding {
  code: BootCode;
  severity: BootSeverity;
  message: string;
}

export function bootCodeSpec(code: BootCode): BootCodeSpec {
  const spec = BOOT_CODES[code];
  if (spec === undefined) throw new Error(`unknown boot code ${JSON.stringify(code)}`);
  return spec;
}
