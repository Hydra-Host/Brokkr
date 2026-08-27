import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn() };
});

import { access } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerSecureBootCollector } from '../secure-boot';

const runMock = vi.mocked(run);
const accessMock = vi.mocked(access);
const ctx = {} as never;

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

function ok(stdout: string): RunResult {
  return { stdout, stderr: '', exit_code: 0, duration_ms: 0 };
}

function scriptCommands(commands: Record<string, string>): void {
  runMock.mockImplementation(async (cmd, args) => {
    if (cmd !== 'sh' || !args || args[0] !== '-c' || typeof args[1] !== 'string') {
      return ok('');
    }
    const command = args[1];
    const boundary = (after: number) => after === command.length || ' \t|;'.includes(command[after]!);

    for (const [prefix, output] of Object.entries(commands)) {
      if (command.startsWith(prefix) && boundary(prefix.length)) {
        return ok(output);
      }
    }
    for (const [prefix, output] of Object.entries(commands)) {
      const idx = command.indexOf(prefix);
      if (idx === -1) continue;
      if (boundary(idx + prefix.length)) {
        return ok(output);
      }
    }
    return ok('');
  });
}

function scriptFiles(present: Set<string>): void {
  accessMock.mockImplementation(async (path) => {
    if (typeof path === 'string' && present.has(path)) return;
    throw new Error(`ENOENT: ${String(path)}`);
  });
}

beforeEach(() => {
  runMock.mockReset();
  accessMock.mockReset();
  runMock.mockResolvedValue(ok(''));
  accessMock.mockRejectedValue(new Error('ENOENT'));
  clearOperationsForTests();
  registerSecureBootCollector();
});

const SECURE_BOOT_EFIVAR_PATH = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';
const SETUP_MODE_EFIVAR_PATH = '/sys/firmware/efi/efivars/SetupMode-8be4df61-93ca-11d2-aa0d-00e098032b8c';
const AUDIT_MODE_EFIVAR_PATH = '/sys/firmware/efi/efivars/AuditMode-8be4df61-93ca-11d2-aa0d-00e098032b8c';

interface SecureBootStore {
  count: number;
  sha1_fingerprints: string[];
  sha256_fingerprints: string[];
  subjects: string[];
  issuers: string[];
  not_after: string[];
  raw_excerpt: string;
}

interface SecureBootResult {
  secure_boot: {
    firmware: 'efi' | 'bios';
    tooling?: 'mokutil_present' | 'mokutil_absent';
    sb_enabled: boolean | null;
    sb_state_raw?: string;
    sb_version_raw?: string;
    setup_mode?: boolean | null;
    audit_mode?: boolean | null;
    enrolled_mok?: SecureBootStore;
    pending_mok?: SecureBootStore;
    pk?: SecureBootStore;
    kek?: SecureBootStore;
    db?: SecureBootStore;
    dbx?: SecureBootStore;
    revoked_raw?: string;
  };
}

async function collect(): Promise<SecureBootResult> {
  const handler = getHandler('collection.secure_boot')!.handler;
  return (await handler({}, ctx)) as SecureBootResult;
}

describe('collection.secure_boot', () => {
  it('bios firmware short-circuits to { firmware: "bios", sb_enabled: null }', async () => {
    scriptFiles(new Set());
    const result = await collect();
    expect(result).toEqual({ secure_boot: { firmware: 'bios', sb_enabled: null } });
  });

  it('parses sb-enabled state with Microsoft UEFI CA in db and a Brokkr cert in MOK', async () => {
    const dbOutput = `[key 1]
SHA1 Fingerprint=AA:BB:CC
SHA256 Fingerprint=DE:AD:BE:EF
        Subject: CN=Microsoft Corporation UEFI CA 2011, O=Microsoft Corporation, L=Redmond, ST=Washington, C=US
        Issuer: CN=Microsoft Corporation Third Party Marketplace Root, O=Microsoft Corporation, L=Redmond, ST=Washington, C=US
        Not Before: Jun 27 21:22:45 2011 GMT
        Not After : Jun 27 21:32:45 2026 GMT
`;
    const mokOutput = `[key 1]
SHA1 Fingerprint=11:22:33
SHA256 Fingerprint=CA:FE:F0:0D
        Subject: CN=brokkr-signing, O=Hydra Host
        Issuer: CN=brokkr-signing, O=Hydra Host
        Not Before: Jan  1 00:00:00 2026 GMT
        Not After : Jan  1 00:00:00 2028 GMT
`;
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot enabled\n',
      'mokutil --sb-version': 'Shim Version: 15.8 (gccd6e2)\n',
      'mokutil --list-enrolled': mokOutput,
      'mokutil --list-new': '',
      'mokutil --pk': '',
      'mokutil --kek': '',
      'mokutil --db': dbOutput,
      'mokutil --dbx': '',
      'mokutil --list-revoked': '',
      'command -v mokutil': 'present\n',
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const sb = (await collect()).secure_boot;

    expect(sb.firmware).toBe('efi');
    expect(sb.tooling).toBe('mokutil_present');
    expect(sb.sb_enabled).toBe(true);
    expect(sb.sb_version_raw).toMatch(/^Shim Version: 15\.8/);

    expect(sb.db!.count).toBe(1);
    expect(sb.db!.sha256_fingerprints).toEqual(['deadbeef']);
    expect(sb.db!.sha1_fingerprints).toEqual(['aabbcc']);
    expect(sb.db!.subjects[0]).toContain('Microsoft Corporation UEFI CA 2011');
    expect(sb.db!.not_after).toContain('Jun 27 21:32:45 2026 GMT');

    expect(sb.enrolled_mok!.count).toBe(1);
    expect(sb.enrolled_mok!.sha256_fingerprints).toEqual(['cafef00d']);
    expect(sb.enrolled_mok!.sha1_fingerprints).toEqual(['112233']);
    expect(sb.enrolled_mok!.subjects[0]).toContain('brokkr-signing');

    expect(sb.pending_mok!.count).toBe(0);
    expect(sb.dbx!.count).toBe(0);
  });

  it('parses sb-disabled state', async () => {
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot disabled\n',
      'command -v mokutil': 'present\n',
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const sb = (await collect()).secure_boot;
    expect(sb.sb_enabled).toBe(false);
  });

  it('falls back to SecureBoot efivar when mokutil is absent', async () => {
    scriptCommands({
      'command -v mokutil': 'absent\n',
      'mokutil --sb-state': '',
      [`xxd -p ${SECURE_BOOT_EFIVAR_PATH}`]: '0700000001',
    });
    scriptFiles(new Set(['/sys/firmware/efi', SECURE_BOOT_EFIVAR_PATH]));

    const sb = (await collect()).secure_boot;
    expect(sb.tooling).toBe('mokutil_absent');
    expect(sb.sb_enabled).toBe(true);
  });

  it('returns null for truncated efivar reads instead of misreading attribute byte', async () => {
    scriptCommands({
      'command -v mokutil': 'absent\n',
      'mokutil --sb-state': '',
      [`xxd -p ${SECURE_BOOT_EFIVAR_PATH}`]: '00000001',
    });
    scriptFiles(new Set(['/sys/firmware/efi', SECURE_BOOT_EFIVAR_PATH]));

    const sb = (await collect()).secure_boot;
    expect(sb.sb_enabled).toBeNull();
  });

  it('parses SetupMode and AuditMode efivar flags', async () => {
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot disabled\n',
      'command -v mokutil': 'present\n',
      [`xxd -p ${SETUP_MODE_EFIVAR_PATH}`]: '0700000001',
      [`xxd -p ${AUDIT_MODE_EFIVAR_PATH}`]: '0700000000',
    });
    scriptFiles(new Set(['/sys/firmware/efi', SETUP_MODE_EFIVAR_PATH, AUDIT_MODE_EFIVAR_PATH]));

    const sb = (await collect()).secure_boot;
    expect(sb.setup_mode).toBe(true);
    expect(sb.audit_mode).toBe(false);
  });

  it('parses real mokutil --list-enrolled output (SHA1 colon, no SHA256)', async () => {
    const mokOutput = `[key 1]
SHA1 Fingerprint: 76:A0:92:06:58:00:BF:37:69:01:C3:72:CD:55:A9:0E:1F:DE:D2:E0
Certificate:
    Data:
        Version: 3 (0x2)
        Serial Number:
            b9:41:24:a0:18:2c:92:67
        Signature Algorithm: sha256WithRSAEncryption
        Issuer: C=GB, ST=Isle of Man, L=Douglas, O=Canonical Ltd., CN=Canonical Ltd. Master Certificate Authority
        Validity
            Not Before: Apr 12 11:12:51 2012 GMT
            Not After : Apr 11 11:12:51 2042 GMT
        Subject: C=GB, ST=Isle of Man, L=Douglas, O=Canonical Ltd., CN=Canonical Ltd. Master Certificate Authority
`;
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot disabled\nPlatform is in Setup Mode\n',
      'command -v mokutil': 'present\n',
      'mokutil --list-enrolled': mokOutput,
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const mok = (await collect()).secure_boot.enrolled_mok!;
    expect(mok.count).toBe(1);
    expect(mok.sha1_fingerprints).toEqual(['76a092065800bf376901c372cd55a90e1fded2e0']);
    expect(mok.sha256_fingerprints).toEqual([]);
    expect(mok.subjects[0]).toContain('Canonical Ltd. Master Certificate Authority');
    expect(mok.not_after).toContain('Apr 11 11:12:51 2042 GMT');
  });

  it('skips malformed PEM blocks instead of killing the collection', async () => {
    const badPem = `[some store]
-----BEGIN CERTIFICATE-----
!!!not-valid-base64@@@
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
TUlJQzZUQ0NBZEdnQXdJQkFnSUJBVEFOQmdrcWhraUc5dzBCQVFzRkFEQU5NUXN3
-----END CERTIFICATE-----
`;
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot enabled\n',
      'command -v mokutil': 'present\n',
      'mokutil --db': badPem,
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const result = await collect();
    expect(result.secure_boot.sb_enabled).toBe(true);
    expect(result.secure_boot.db!.sha256_fingerprints).toHaveLength(1);
  });

  it('returns zero counts for stores that have no keys', async () => {
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot enabled\n',
      'command -v mokutil': 'present\n',
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const sb = (await collect()).secure_boot;
    for (const store of ['enrolled_mok', 'pending_mok', 'pk', 'kek', 'db', 'dbx'] as const) {
      expect(sb[store]!.count).toBe(0);
      expect(sb[store]!.sha256_fingerprints).toEqual([]);
    }
  });

  it('does not crash on malformed sb-state / store output', async () => {
    scriptCommands({
      'mokutil --sb-state': "garbage that doesn't match\n",
      'command -v mokutil': 'present\n',
      'mokutil --db': '----- corrupted output -----\nrandom text\n',
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const sb = (await collect()).secure_boot;
    expect(sb.sb_enabled).toBeNull();
    expect(sb.db!.count).toBe(0);
  });

  it('truncates large dbx and revoked output to ≤8 KiB + truncation marker', async () => {
    const big = 'X'.repeat(20000);
    scriptCommands({
      'mokutil --sb-state': 'SecureBoot enabled\n',
      'command -v mokutil': 'present\n',
      'mokutil --dbx': big,
      'mokutil --list-revoked': big,
    });
    scriptFiles(new Set(['/sys/firmware/efi']));

    const sb = (await collect()).secure_boot;
    expect(sb.dbx!.raw_excerpt.length).toBeLessThanOrEqual(8400);
    expect(sb.dbx!.raw_excerpt).toContain('truncated');
    expect(sb.revoked_raw).toContain('truncated');
  });
});
