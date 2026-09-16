import { Inject, Injectable } from '@nestjs/common';
import type {
  DhcpMode,
  IpxeBuildTarget,
  PrefixBootReadiness,
  PrefixBootReadinessFinding,
  PrefixBootReadinessQuery,
} from '@repo/api-client';
import { BOOT_CODES, type BootCode } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { type BootIdentity, PrefixRepository } from './prefix.repository';

interface BootCheckSubject {
  dhcpMode: DhcpMode | null;
  ipxeBuildTarget: IpxeBuildTarget | null;
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
      `The proxy allowlist on this prefix does not contain ${subject.mac}. Add it in the hub.`,
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

function evaluate(subject: BootCheckSubject): PrefixBootReadinessFinding[] {
  // the response schema promises findings ordered by code, so sort rather than trust the list order
  return HUB_BOOT_CODES.filter((code) => HUB_BOOT_CHECKS[code].fails(subject))
    .sort()
    .map((code) => ({
      code,
      severity: BOOT_CODES[code].severity,
      message: HUB_BOOT_CHECKS[code].message(subject),
    }));
}

@Injectable()
export class PrefixBootReadinessService {
  constructor(
    @Inject(PrefixRepository)
    private readonly prefixRepository: Pick<PrefixRepository, 'getDhcpConfig' | 'resolveBootIdentity'>,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'requirePermission'>,
  ) {}

  async check(prefixId: string, query: PrefixBootReadinessQuery): Promise<PrefixBootReadiness> {
    this.contextService.requirePermission('ipam', 'read');
    // getDhcpConfig pins the tenant scope and 404s a prefix this organization cannot see.
    const config = await this.prefixRepository.getDhcpConfig(prefixId);
    const identity =
      query.bmcAddress === undefined
        ? null
        : await this.prefixRepository.resolveBootIdentity(query.mac, query.bmcAddress);
    return { findings: evaluate({ ...config, mac: query.mac, bmcAddress: query.bmcAddress, identity }) };
  }
}
