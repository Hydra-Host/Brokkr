/**
 * Base-OS matrix E2E: cycle one device through each selected base OS in turn --
 * provision, verify the booted OS's distro + version over SSH, then reprovision
 * into the next, until every chosen base OS has passed; finally end-rental back
 * to INVENTORY.
 *
 * Base OS selection comes from the control center's picker (or the CLI) via env:
 * - `SIM_BASEOS_LIST`: JSON array of base OS slugs to cycle. Empty/unset = every
 *   eligible base OS the hub reports for the device (`availableBaseLayers`).
 * - `SIM_LC_DEVICE_INDEX`: pin to a node (else first INVENTORY device).
 *
 * Slow + destructive -- one real OS deploy + disk wipe per base OS. Reuses the
 * lifecycle provision/reprovision/deprovision helpers, so the saga + atom-lockstep
 * assertions are identical to the lifecycle journeys; the addition is cycling the
 * base OS and the per-OS distro/version check against `/etc/os-release`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeRedis } from './bridge-redis';
import { dataIpForDevice, isIpxeCustomOs, loadFleet, pollUntil, type Fleet } from './helpers';
import { HubAdminClient } from './hub-client';
import { HubDB } from './hub-db';
import { awaitProvisioned, classifyBoot, endRentalToInventory, selectInventoryDevice } from './lifecycle-helpers';
import { VMClient, userForSlug } from './vm-client';

// ---------------------------------------------------------------------------
// /etc/os-release parsing helpers
// ---------------------------------------------------------------------------

/** Value of a key in `/etc/os-release` (handles quoted + bare forms). */
function osrel(text: string, key: string): string {
  const re = new RegExp(`^${key}=(?:"([^"]*)"|([^\\s]*))`, 'm');
  const m = text.match(re);
  if (!m) return '';
  return (m[1] ?? m[2] ?? '').trim();
}

/**
 * Normalise a version string for comparison: strip non-numeric suffixes
 * (`'24.04 LTS'` -> `'24.04'`), and expand compact YYMM slugs that Ubuntu
 * uses (`'2404'` -> `'24.04'`, `'2204'` -> `'22.04'`). Without the expansion
 * `normVer('2404') === '2404'` would never match `normVer('24.04') === '24.04'`.
 */
function normVer(v: string): string {
  const trimmed = v.trim();
  // Compact 4-digit YYMM with no dots (e.g. '2404', '2204')
  const compact = trimmed.match(/^(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}.${compact[2]}`;
  const m = trimmed.match(/^\d+(?:\.\d+)*/);
  return m ? m[0] : trimmed;
}

// ---------------------------------------------------------------------------
// Expected distro/version from hub server detail
// ---------------------------------------------------------------------------

interface ServerDetail {
  availableBaseLayers?: Array<{
    slug?: string;
    version?: string;
  }>;
  [key: string]: unknown;
}

/**
 * Expected `[distro, version]` for a base OS slug from the hub server detail,
 * falling back to parsing the slug (e.g. `ubuntu-24.04`).
 */
function expected(server: ServerDetail, slug: string): [string | null, string | null] {
  for (const b of server.availableBaseLayers ?? []) {
    if (b.slug === slug && b.version) {
      return [slug.split('-')[0]!, b.version];
    }
  }
  const parts = slug.split('-');
  if (parts.length >= 2) {
    // If the second segment is a codename (non-numeric), skip the version
    // assertion -- codenames don't map to VERSION_ID without a lookup table.
    const ver = /^\d/.test(parts[1]!) ? parts[1]! : null;
    return [parts[0]!, ver];
  }
  return [null, null];
}

// ---------------------------------------------------------------------------
// OS verification via SSH
// ---------------------------------------------------------------------------

/**
 * Assert the booted OS's `ID`/`VERSION_ID` match the provisioned base OS.
 * Reads `/etc/os-release` over SSH and compares against expected values.
 */
async function verifyOs(vm: VMClient, slug: string, distro: string | null, version: string | null): Promise<void> {
  const result = await vm.run('cat /etc/os-release', 30);
  const text = result.stdout || result.stderr;
  const gotId = osrel(text, 'ID');
  const gotVer = osrel(text, 'VERSION_ID');

  console.log(`${slug} /etc/os-release: ID=${gotId} VERSION_ID=${gotVer}\n${text.trim() || '(no output)'}`);

  if (distro) {
    expect(gotId.toLowerCase(), `${slug}: distro mismatch -- booted ID='${gotId}', expected '${distro}'`).toBe(
      distro.toLowerCase(),
    );
  }

  if (version) {
    const exp = normVer(version);
    const got = normVer(gotVer);
    expect(got, `${slug}: VERSION_ID missing from /etc/os-release`).not.toBe('');
    const versionMatch = exp === got || exp.startsWith(got) || got.startsWith(exp);
    expect(versionMatch, `${slug}: version mismatch -- booted VERSION_ID='${gotVer}', expected '${version}'`).toBe(
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('base-os matrix', { timeout: 3_600_000 }, () => {
  let hubAdmin: HubAdminClient;
  let hubDb: HubDB;
  let bridgeRedis: BridgeRedis;
  let fleet: Fleet;

  beforeAll(async () => {
    fleet = loadFleet();
    hubAdmin = new HubAdminClient();
    await hubAdmin.signIn();
    hubDb = HubDB.fromEnv();
    bridgeRedis = BridgeRedis.fromEnv();
  });

  afterAll(async () => {
    await hubDb.prisma.$disconnect();
    await bridgeRedis.disconnect();
  });

  it(
    'cycles a device through each selected base OS, verifying distro/version each time',
    { timeout: 3_600_000 },
    async ({ skip }) => {
      const deviceId = await selectInventoryDevice(hubDb, fleet);
      if (!deviceId) {
        skip('SKIP: no INVENTORY device available; reset one with end-rental first');
        return;
      }

      const { status, body } = await hubAdmin.getServer(deviceId);
      expect(status).toBe(200);
      const server = body as ServerDetail;
      expect(server).toBeTruthy();

      const allRawSlugs = (server.availableBaseLayers ?? []).map((b) => b.slug).filter((s): s is string => !!s);
      if (!allRawSlugs.length) {
        skip(`SKIP: device ${deviceId.slice(-4)} reports no base OS layers`);
        return;
      }

      const allSlugs = allRawSlugs.filter((s) => !isIpxeCustomOs(s));
      if (!allSlugs.length) {
        skip(`SKIP: device ${deviceId.slice(-4)} has only chainload-only layers (${allRawSlugs.join(', ')})`);
        return;
      }

      const requestedRaw = process.env.SIM_BASEOS_LIST ?? '[]';
      let requested: string[] = [];
      try {
        const parsed: unknown = JSON.parse(requestedRaw);
        if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
          skip('SKIP: SIM_BASEOS_LIST must be a JSON array of strings');
          return;
        }
        requested = parsed;
      } catch {
        skip(`SKIP: SIM_BASEOS_LIST is not valid JSON: ${requestedRaw}`);
        return;
      }
      const slugs = requested.length ? allSlugs.filter((s) => requested.includes(s)) : allSlugs;

      if (!slugs.length) {
        skip(
          `SKIP: none of the requested base OSes ${JSON.stringify(requested)} are eligible (device offers ${JSON.stringify(allRawSlugs)})`,
        );
        return;
      }

      console.log(`Base OS matrix [${slugs.length}] -- ${deviceId.slice(-4)}: ${slugs.join(', ')}`);

      const ip = dataIpForDevice(fleet, deviceId);

      // The atom may not yet exist immediately after a pre-test reset (the spoke
      // synthesizes it on first /api/chain hit after the reset DELs it). The reset
      // power-cycles the VM, so it must boot + hit /api/chain before the atom reappears.
      const record = await pollUntil(
        () => bridgeRedis.getDeviceRecord(deviceId),
        (r) => r !== null && r.status === 'INVENTORY',
        { timeout: 180_000, interval: 5_000 },
      );
      expect(record).not.toBeNull();
      expect(record!.status).toBe('INVENTORY');

      try {
        for (let i = 0; i < slugs.length; i++) {
          const slug = slugs[i]!;
          const kind: 'provision' | 'reprovision' = i === 0 ? 'provision' : 'reprovision';
          const [distro, version] = expected(server, slug);

          console.log(`[${i + 1}/${slugs.length}] ${kind} ${slug} (expect ${distro} ${version})`);

          await awaitProvisioned(hubAdmin, hubDb, bridgeRedis, ip, deviceId, {
            kind,
            deploymentName: `e2e-baseos-${slug}`,
            osSlug: slug,
          });

          console.log(`[${i + 1}/${slugs.length}] verify ${slug} on booted OS`);

          // PROVISIONED implies phone-home fired, but the VM still has to reboot
          // off brokkr-live into the installed disk (a real boot) and sshd may
          // bind a beat later -- settle on the OS before probing.
          const boot = await pollUntil(
            () => classifyBoot(ip, slug),
            (s) => s === 'os' || s === 'brokkr-live',
            { timeout: 420_000, interval: 10_000 },
          );
          expect(boot, `${slug}: device booted '${boot}', not the installed OS`).toBe('os');

          await verifyOs(new VMClient(ip, userForSlug(slug)), slug, distro, version);
        }
      } finally {
        console.log('end-rental (deprovision)');
        try {
          await endRentalToInventory(hubAdmin, hubDb, deviceId);
        } catch (err) {
          console.error('end-rental failed:', err);
        }
      }
    },
  );
});
