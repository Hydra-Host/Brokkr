import type {
  BootReadinessFinding,
  DeviceBootReadiness,
  DeviceBootTrail,
  DhcpMode,
  IpxeBuildTarget,
  PrefixBootReadinessFinding,
  PrefixBootReadinessQuery,
  PrefixDhcpConfig,
} from '@repo/api-client';
import { BOOT_CODES, type BootCode, bootCodeSpec, canonicalMac, TRAIL_BOOT_CODES, trailFindings } from '@repo/utils';
import type { BootIdentity, BootPrefixSelection } from './prefix-boot-queries';

export const BOOT_GRACE_MS = 3 * 60_000;

interface BootCheckSubject {
  dhcpMode: DhcpMode | null;
  ipxeBuildTarget: IpxeBuildTarget | null;
  // the effective allowlist the bridge enforces (operator entries plus reservations), not the operator column alone
  dhcpProxyAllowedMacs: readonly string[];
  mac: string;
  // present exactly when identity is, since resolving an identity is what needs the address
  bmcAddress?: string;
  identity: BootIdentity | null;
}

interface BootCheck {
  fails: (subject: BootCheckSubject) => boolean;
  message: (subject: BootCheckSubject) => string;
}

// Keyed by registry code and typed against it, so a code the bridge does not register is a compile
// error; the severity is read from the @repo/utils registry, never restated here.
type HubBootCode = Extract<BootCode, 'PXE-102' | 'PXE-103' | 'PXE-104' | 'PXE-106'>;

export const HUB_BOOT_CHECKS = {
  'PXE-102': {
    // OFF joins an unset mode: both build no subnet, so both leave the machine with no offer.
    fails: (subject: BootCheckSubject) => subject.dhcpMode === null || subject.dhcpMode === 'OFF',
    message: () => 'This prefix serves no DHCP. Set a DHCP mode on the prefix DHCP settings in the hub.',
  },
  'PXE-103': {
    // The column is NOT NULL with a default, so only an out-of-band write leaves a prefix with no target.
    fails: (subject: BootCheckSubject) => subject.ipxeBuildTarget === null,
    message: () =>
      'This prefix offers no boot file. Select an iPXE build target on the prefix DHCP settings in the hub.',
  },
  'PXE-104': {
    // The allowlist is read only in PROXY mode; any other mode would name a field the bridge never consults.
    fails: (subject: BootCheckSubject) =>
      subject.dhcpMode === 'PROXY' && !subject.dhcpProxyAllowedMacs.includes(subject.mac),
    message: (subject: BootCheckSubject) =>
      `The proxy allowlist on this prefix, operator entries plus reserved addresses, does not contain ${subject.mac}. Add the MAC to the prefix DHCP settings in the hub.`,
  },
  'PXE-106': {
    // Two unknowns are not a split identity — no hub device claims either, a different problem entirely.
    fails: (subject: BootCheckSubject) =>
      subject.identity !== null && subject.identity.pxeDeviceId !== subject.identity.bmcDeviceId,
    // one address resolving alone is an unregistered address, not two devices disagreeing, and the
    // remedy is to register it rather than to reconcile interfaces
    message: (subject: BootCheckSubject) => {
      const identity = subject.identity;
      if (identity !== null && identity.pxeDeviceId === null) {
        return `No hub device carries the PXE MAC ${subject.mac}, while the BMC address resolves to one. Add the PXE MAC as an interface on that device.`;
      }
      if (identity !== null && identity.bmcDeviceId === null) {
        return `No hub device carries the BMC address ${subject.bmcAddress}, while the PXE MAC ${subject.mac} resolves to one. Add the BMC address as an interface on that device.`;
      }
      return `The PXE MAC ${subject.mac} and the BMC address ${subject.bmcAddress} name different hub devices. Correct the device interfaces so one device owns both.`;
    },
  },
} satisfies Record<HubBootCode, BootCheck>;

function isHubBootCode(code: string): code is HubBootCode {
  return code in HUB_BOOT_CHECKS;
}

const HUB_BOOT_CODES: readonly HubBootCode[] = Object.keys(HUB_BOOT_CHECKS).filter(isHubBootCode);

export function prefixBootFindings(
  config: PrefixDhcpConfig,
  identity: BootIdentity | null,
  query: PrefixBootReadinessQuery,
  proxyAllowlist: readonly string[],
): PrefixBootReadinessFinding[] {
  const subject: BootCheckSubject = {
    ...config,
    dhcpProxyAllowedMacs: proxyAllowlist,
    mac: canonicalMac(query.mac) ?? query.mac,
    bmcAddress: query.bmcAddress,
    identity,
  };
  // the response schema promises findings ordered by code, so sort rather than trust the list order
  return HUB_BOOT_CODES.filter((code) => HUB_BOOT_CHECKS[code].fails(subject))
    .sort()
    .map((code) => ({
      code,
      severity: BOOT_CODES[code].severity,
      message: HUB_BOOT_CHECKS[code].message(subject),
    }));
}

export interface DeviceBootReadinessInput {
  deviceId: string;
  subject: string;
  bmcAddress: string | null;
  trail: DeviceBootTrail;
  selected: BootPrefixSelection | null;
  // null when the prefix checks did not run: no prefix was selected or the device has no data MAC
  prefixFindings: PrefixBootReadinessFinding[] | null;
}

const byCode = (a: BootReadinessFinding, b: BootReadinessFinding): number => a.code.localeCompare(b.code);

export function deviceBootReadiness({
  deviceId,
  subject,
  bmcAddress,
  trail,
  selected,
  prefixFindings,
}: DeviceBootReadinessInput): DeviceBootReadiness {
  const findings: BootReadinessFinding[] = [];

  if (prefixFindings !== null && selected !== null) {
    for (const f of prefixFindings) findings.push({ ...f, source: 'hub-prefix', prefixId: selected.id });
  } else if (trail.pxeMac !== null && trail.zoneId !== null) {
    // a missing data MAC or an unresolved zone is already reported once by trailFindings through the trail readError
    findings.push({
      code: TRAIL_BOOT_CODES.unevaluated,
      severity: bootCodeSpec(TRAIL_BOOT_CODES.unevaluated).severity,
      message: 'No prefix contains the data address and the zone has no PRIMARY prefix.',
      source: 'hub-prefix',
      prefixId: null,
    });
  }

  const since = trail.bootExpected.since;
  for (const f of trailFindings(trail.trail, subject, {
    bootExpectedSinceMs: since === null ? null : Date.parse(since),
    graceMs: BOOT_GRACE_MS,
  })) {
    findings.push({ ...f, source: 'boot-trail', prefixId: null });
  }

  return {
    deviceId,
    prefixId: selected?.id ?? null,
    prefixSelection: selected?.selection ?? 'none',
    pxeMac: trail.pxeMac,
    pxeInterface: trail.pxeInterface,
    pxeMacSource: trail.pxeMacSource,
    bmcAddress,
    findings: findings.sort(byCode),
    evaluated: {
      hubPrefix: prefixFindings !== null && selected !== null,
      bootTrail: trail.trail.readError === null,
      bootedWithoutDhcp: trail.trail.chainAtMs !== null && trail.trail.pxe === null,
    },
    trail: trail.trail,
  };
}
