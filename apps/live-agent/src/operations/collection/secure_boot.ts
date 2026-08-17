import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';

import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';

const RAW_EXCERPT_MAX = 8192;

const SECURE_BOOT_EFIVAR = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';
const SETUP_MODE_EFIVAR = '/sys/firmware/efi/efivars/SetupMode-8be4df61-93ca-11d2-aa0d-00e098032b8c';
const AUDIT_MODE_EFIVAR = '/sys/firmware/efi/efivars/AuditMode-8be4df61-93ca-11d2-aa0d-00e098032b8c';

const SUBJECT_RE = /^\s*Subject:\s*(.+?)\s*$/gm;
const ISSUER_RE = /^\s*Issuer:\s*(.+?)\s*$/gm;
const NOT_AFTER_RE = /^\s*Not After\s*:\s*(.+?)\s*$/gm;
const FINGERPRINT_RE = /SHA(1|256) Fingerprint[=:]\s*([0-9A-Fa-f:]+)/g;

const PEM_BLOCK_RE = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

interface SecureBootStore {
  count: number;
  sha1_fingerprints: string[];
  sha256_fingerprints: string[];
  subjects: string[];
  issuers: string[];
  not_after: string[];
  raw_excerpt: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function capture(command: string, timeoutMs = 15_000, cap?: number): Promise<string> {
  let out = '';
  try {
    const r = await run('sh', ['-c', command], { timeout_ms: timeoutMs, quiet_nonzero: true });
    out = r.stdout;
  } catch {
    return '';
  }
  if (cap !== undefined && out.length > cap) {
    return `${out.slice(0, cap)}\n... [truncated, original ${out.length} bytes]`;
  }
  return out;
}

async function detectTooling(): Promise<'mokutil_present' | 'mokutil_absent'> {
  const out = await capture('command -v mokutil >/dev/null && echo present || echo absent', 5_000);
  return out.includes('present') ? 'mokutil_present' : 'mokutil_absent';
}

function parseSbEnabled(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  if (lower.includes('secureboot enabled')) return true;
  if (lower.includes('secureboot disabled')) return false;
  return null;
}

async function readEfivarFlag(path: string): Promise<boolean | null> {
  // EFI bool vars are 5 bytes (4 attr + 1 data) = 10 hex chars; a truncated read could misread an attribute byte as enabled.
  if (!(await fileExists(path))) return null;
  const out = (await capture(`xxd -p ${path} | tr -d '\\n'`, 5_000)).trim();
  if (out.length < 10) return null;
  return out.slice(-2) === '01';
}

function derivePemFingerprints(raw: string): string[] {
  const fingerprints: string[] = [];
  for (const match of raw.matchAll(PEM_BLOCK_RE)) {
    const body = match[1]!.replace(/\s/g, '');
    if (!BASE64_RE.test(body)) continue;
    const der = Buffer.from(body, 'base64');
    if (der.length === 0) continue;
    fingerprints.push(createHash('sha256').update(der).digest('hex'));
  }
  return fingerprints;
}

async function collectStore(mokutilFlag: string): Promise<SecureBootStore> {
  const raw = await capture(`mokutil ${mokutilFlag} 2>/dev/null`, 20_000, RAW_EXCERPT_MAX);
  if (raw.trim().length === 0) {
    return {
      count: 0,
      sha1_fingerprints: [],
      sha256_fingerprints: [],
      subjects: [],
      issuers: [],
      not_after: [],
      raw_excerpt: '',
    };
  }

  const subjects = [...raw.matchAll(SUBJECT_RE)].map((m) => m[1]!);
  const issuers = [...raw.matchAll(ISSUER_RE)].map((m) => m[1]!);
  const notAfter = [...raw.matchAll(NOT_AFTER_RE)].map((m) => m[1]!);

  const sha1: string[] = [];
  let sha256: string[] = [];
  for (const m of raw.matchAll(FINGERPRINT_RE)) {
    const normalised = m[2]!.replace(/:/g, '').toLowerCase();
    if (m[1] === '1') sha1.push(normalised);
    else sha256.push(normalised);
  }
  if (sha256.length === 0) {
    sha256 = derivePemFingerprints(raw);
  }

  return {
    count: Math.max(sha1.length, sha256.length, subjects.length),
    sha1_fingerprints: sha1,
    sha256_fingerprints: sha256,
    subjects,
    issuers,
    not_after: notAfter,
    raw_excerpt: raw,
  };
}

interface BiosResult {
  firmware: 'bios';
  sb_enabled: null;
}

interface EfiResult {
  firmware: 'efi';
  tooling: 'mokutil_present' | 'mokutil_absent';
  sb_enabled: boolean | null;
  sb_state_raw: string;
  sb_version_raw: string;
  setup_mode: boolean | null;
  audit_mode: boolean | null;
  enrolled_mok: SecureBootStore;
  pending_mok: SecureBootStore;
  pk: SecureBootStore;
  kek: SecureBootStore;
  db: SecureBootStore;
  dbx: SecureBootStore;
  revoked_raw: string;
}

async function collect(): Promise<{ secure_boot: BiosResult | EfiResult }> {
  if (!(await fileExists('/sys/firmware/efi'))) {
    return { secure_boot: { firmware: 'bios', sb_enabled: null } };
  }

  const tooling = await detectTooling();
  const sbStateRaw = await capture('mokutil --sb-state 2>/dev/null', 10_000);
  let sbEnabled = parseSbEnabled(sbStateRaw);
  if (sbEnabled === null) {
    sbEnabled = await readEfivarFlag(SECURE_BOOT_EFIVAR);
  }

  const sbVersionRaw = await capture('mokutil --sb-version 2>/dev/null', 10_000);
  const setupMode = await readEfivarFlag(SETUP_MODE_EFIVAR);
  const auditMode = await readEfivarFlag(AUDIT_MODE_EFIVAR);

  const [enrolledMok, pendingMok, pk, kek, db, dbx] = await Promise.all([
    collectStore('--list-enrolled'),
    collectStore('--list-new'),
    collectStore('--pk'),
    collectStore('--kek'),
    collectStore('--db'),
    collectStore('--dbx'),
  ]);

  const revokedRaw = await capture('mokutil --list-revoked 2>/dev/null', 20_000, RAW_EXCERPT_MAX);

  return {
    secure_boot: {
      firmware: 'efi',
      tooling,
      sb_enabled: sbEnabled,
      sb_state_raw: sbStateRaw,
      sb_version_raw: sbVersionRaw,
      setup_mode: setupMode,
      audit_mode: auditMode,
      enrolled_mok: enrolledMok,
      pending_mok: pendingMok,
      pk,
      kek,
      db,
      dbx,
      revoked_raw: revokedRaw,
    },
  };
}

export function registerSecureBootCollector(): void {
  registerOperation('collection.secure_boot', collect);
}
