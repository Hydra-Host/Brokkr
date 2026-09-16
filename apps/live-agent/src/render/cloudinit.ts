import { NODE_DESC_PATTERN } from '@repo/bridge-agent-protocol';
import { isRecord } from '@repo/utils';
import yaml from 'js-yaml';

import { assertNoControlChars, renderEnv, shellQuote, stripTrailingNewline } from './env';
import metaDataTemplate from './templates/cloud-init-meta-data.njk';
import phoneHomeScriptTemplate from './templates/cloud-init-phone-home.sh.njk';
import cloudCfgTemplate from './templates/cloud.cfg.njk';

import { type CloudInitWriteFile, renderRoceUserDataExtras } from './roce/index';

export interface PhoneHomeCredsInput {
  deployment_os_token: string;
  endpoint: string;
}

export const CLOUD_INIT_FILE_MODES = {
  cloudCfg: 0o644,
  metaData: 0o644,
  userData: 0o644,
  networkConfig: 0o644,
  phoneHomeCreds: 0o600,
  phoneHomeScript: 0o700,
} as const;

export interface CloudInitBundleInput {
  deviceId: string;
  sshPubkeys: string[];
  passwordHash?: string | undefined;
  netplanYaml: string;
  customUserDataYaml?: string | undefined;
  phoneHomeCreds: PhoneHomeCredsInput;
}

export interface RoceRenderInput {
  enabled: boolean;
  docaRepoUrl: string;
}

export interface InfinibandRenderInput {
  enabled: boolean;
  nodeDesc: string;
}

export function renderMetaData(vars: { deviceId: string }): string {
  return stripTrailingNewline(renderEnv.renderString(metaDataTemplate, { device_id: vars.deviceId }));
}

export function renderCloudCfg(input: { distro: string }): string {
  return stripTrailingNewline(renderEnv.renderString(cloudCfgTemplate, { distro: input.distro }));
}

const SSH_KEY_TYPES: ReadonlySet<string> = new Set([
  'ssh-dss',
  'ssh-rsa',
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'sk-ssh-ed25519@openssh.com',
]);
const SSH_KEY_TYPE_PATTERN = [...SSH_KEY_TYPES]
  .map((keyType) => keyType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const SSH_KEY_START = new RegExp(`^(?:(.*?)\\s+)?(${SSH_KEY_TYPE_PATTERN})\\s+([A-Za-z0-9+/]+={0,2})(?:\\s+(.*))?$`);
const SSH_KEY_CONTINUATION = /^([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/;

interface ParsedPubkey {
  options: string | undefined;
  keyType: string;
  keyData: string;
  comment: string | undefined;
}

function parsePubkeyStart(line: string): ParsedPubkey | null {
  const match = SSH_KEY_START.exec(line);
  if (!match) return null;
  return { options: match[1], keyType: match[2]!, keyData: match[3]!, comment: match[4] };
}

function formatPubkey(pubkey: ParsedPubkey): string {
  const options = pubkey.options ? `${pubkey.options} ` : '';
  return `${options}${pubkey.keyType} ${pubkey.keyData}${pubkey.comment ? ` ${pubkey.comment}` : ''}`;
}

// Embedded newlines silently corrupt the YAML emitter, discarding the entire user-data.
function sanitizePubkey(pubkey: string): string[] {
  const lines = pubkey
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const cleaned: string[] = [];
  let current: ParsedPubkey | null = null;
  let pendingComment: string | undefined;

  const finishCurrent = (): void => {
    if (!current) return;
    if (!current.comment && pendingComment) current.comment = pendingComment;
    cleaned.push(formatPubkey(current));
  };

  for (const line of lines) {
    const keyStart = parsePubkeyStart(line);
    if (keyStart) {
      finishCurrent();
      current = keyStart;
      pendingComment = undefined;
      continue;
    }
    if (!current || current.comment) continue;

    const continuation = SSH_KEY_CONTINUATION.exec(line);
    if (!continuation) {
      pendingComment = line;
      continue;
    }
    current.keyData += continuation[1]!;
    current.comment = continuation[2];
    pendingComment = undefined;
  }

  finishCurrent();
  return cleaned;
}

function sanitizePubkeys(pubkeys: string[]): string[] {
  return pubkeys.flatMap(sanitizePubkey);
}

const LOCKED_BASE_KEYS = ['hostname', 'preserve_hostname', 'manage_etc_hosts', 'ssh_pwauth'] as const;

// `users` must merge into the seed, not a cloud.cfg.d fragment — cloud-init doesn't merge list keys across sources, so customer accounts would silently never get created.
function mergeCloudConfig(base: Record<string, unknown>, customer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, cv] of Object.entries(customer)) {
    const bv = out[key];
    if (Array.isArray(bv) && Array.isArray(cv)) {
      out[key] = [...bv, ...cv];
    } else if (isRecord(bv) && isRecord(cv)) {
      out[key] = mergeCloudConfig(bv, cv);
    } else if (!Array.isArray(bv) && !isRecord(bv)) {
      out[key] = cv;
    }
  }
  return out;
}

export function renderUserData(input: {
  hostname: string;
  distro: string;
  sshPubkeys: string[];
  passwordHash?: string | undefined;
  customUserData?: Record<string, unknown> | undefined;
  writeFiles?: CloudInitWriteFile[] | undefined;
}): string {
  assertNoControlChars('hostname', input.hostname);
  assertNoControlChars('distro', input.distro);

  if (input.passwordHash) assertNoControlChars('passwordHash', input.passwordHash);
  const sshPubkeys = sanitizePubkeys(input.sshPubkeys);
  if (input.sshPubkeys.length > 0 && sshPubkeys.length === 0 && !input.passwordHash) {
    throw new Error('ssh pubkeys all sanitized to empty; refusing to render a keyless user');
  }
  const user: Record<string, unknown> = {
    name: input.distro,
    sudo: ['ALL=(ALL) NOPASSWD:ALL'],
    groups: ['users', 'admin', 'sudo'],
    homedir: `/home/${input.distro}`,
    shell: '/bin/bash',
  };
  if (input.passwordHash) {
    user['lock_passwd'] = false;
    user['passwd'] = input.passwordHash;
    user['hashed_passwd'] = input.passwordHash;
  } else {
    user['lock_passwd'] = true;
  }
  user['ssh_authorized_keys'] = sshPubkeys;
  const base: Record<string, unknown> = {
    hostname: input.hostname,
    preserve_hostname: false,
    manage_etc_hosts: true,
    ssh_pwauth: false,
    users: [user],
    bootcmd: [
      "sh -c 'if [ -S /run/dbus/system_bus_socket ]; then netplan apply; else touch /run/brokkr-netplan-deferred; fi'",
      'userdel -r packer || true',
      'rm -rf /home/packer',
      'rm -f /etc/sudoers.d/packer',
    ],
    runcmd: ["sh -c '[ -f /run/brokkr-netplan-deferred ] && netplan apply || true'"],
  };
  if (input.writeFiles) base['write_files'] = input.writeFiles;
  let doc = base;
  if (input.customUserData) {
    doc = mergeCloudConfig(base, input.customUserData);
    for (const key of LOCKED_BASE_KEYS) doc[key] = base[key];
    if (Array.isArray(doc['users'])) {
      const seen = new Set<string>();
      doc['users'] = doc['users'].filter((u) => {
        const name = isRecord(u) ? u['name'] : undefined;
        if (typeof name !== 'string') return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
    }
  }
  return `#cloud-config\n${yaml.dump(doc, { lineWidth: 4096, noRefs: true }).trimEnd()}`;
}

export function renderRoceCfg(input: { enabled: boolean; docaRepoUrl: string }): string | null {
  const extras = renderRoceUserDataExtras({ roce: input });
  if (!extras.writeFiles.length && !extras.runcmd.length) return null;
  const doc: Record<string, unknown> = {};
  if (extras.writeFiles.length) doc['write_files'] = extras.writeFiles;
  if (extras.runcmd.length) doc['runcmd'] = extras.runcmd;
  const dumped = yaml.dump(doc, { lineWidth: 4096, noRefs: true }).trimEnd();
  return `#cloud-config\n${dumped}\n`;
}

export function renderInfinibandWriteFiles(input: { enabled: boolean; nodeDesc: string }): CloudInitWriteFile[] | null {
  if (!input.enabled || !input.nodeDesc) return null;
  if (!NODE_DESC_PATTERN.test(input.nodeDesc)) return null;

  const udevRule =
    'ACTION=="add", SUBSYSTEM=="infiniband", KERNEL=="mlx5_*", ' +
    `RUN+="/bin/sh -c 'echo -n ${input.nodeDesc} %k > /sys/class/infiniband/%k/node_desc'"`;

  const systemdUnit =
    [
      '[Unit]',
      'Description=Brokkr InfiniBand node_desc initializer',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=oneshot',
      'ExecStart=/usr/local/sbin/brokkr-ib-node-desc.sh',
      'RemainAfterExit=yes',
      'TimeoutStartSec=240',
      'Restart=on-failure',
      'RestartSec=10',
      'StartLimitBurst=5',
      'StartLimitIntervalSec=300',
      'StandardOutput=journal',
      'StandardError=journal',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n') + '\n';

  const helperScript =
    [
      '#!/bin/sh',
      'set -eu',
      `NODE_DESC='${input.nodeDesc}'`,
      '',
      '# 1. Wait for /sys/class/infiniband/ device count to stabilize (3 identical samples)',
      'prev=-1; same=0',
      'while [ "$same" -lt 3 ]; do',
      '  count=$(ls -1 /sys/class/infiniband/ 2>/dev/null | wc -l)',
      '  if [ "$count" -gt 0 ] && [ "$count" = "$prev" ]; then same=$((same+1)); else same=0; fi',
      '  prev=$count',
      '  sleep 3',
      'done',
      '',
      '# 2. Wait for every port to leave INIT state (Active or Down is fine)',
      'tries=0',
      'while [ "$tries" -lt 30 ]; do',
      '  init=0',
      '  for p in /sys/class/infiniband/mlx5_*/ports/*/state; do',
      '    [ -e "$p" ] || continue',
      '    grep -q INIT "$p" 2>/dev/null && init=$((init+1))',
      '  done',
      '  [ "$init" -eq 0 ] && break',
      '  sleep 2',
      '  tries=$((tries+1))',
      'done',
      '',
      '# 3. Retry-until-stable write of node_desc across all mlx5 IB devices',
      'for attempt in $(seq 1 12); do',
      '  all_ok=1',
      '  for d in /sys/class/infiniband/mlx5_*/node_desc; do',
      '    [ -e "$d" ] || continue',
      '    devName=$(basename "$(dirname "$d")")',
      '    expected="$NODE_DESC $devName"',
      '    current=$(cat "$d" 2>/dev/null | tr -d "\\r\\n")',
      '    if [ "$current" != "$expected" ]; then',
      '      printf "%s" "$expected" > "$d" 2>/dev/null || true',
      '      all_ok=0',
      '    fi',
      '  done',
      '  [ "$all_ok" = "1" ] && [ "$attempt" -gt 2 ] && break',
      '  sleep 3',
      'done',
      '',
      "# 4. Final verify — exit non-zero if any HCA didn't take the write",
      'fail=0',
      'for d in /sys/class/infiniband/mlx5_*/node_desc; do',
      '  [ -e "$d" ] || continue',
      '  devName=$(basename "$(dirname "$d")")',
      '  expected="$NODE_DESC $devName"',
      '  current=$(cat "$d" 2>/dev/null | tr -d "\\r\\n")',
      '  if [ "$current" != "$expected" ]; then',
      "    echo \"FAIL $d expected='$expected' got='$current'\" >&2",
      '    fail=1',
      '  fi',
      'done',
      '[ $fail -eq 0 ] && echo "OK: node_desc set on all mlx5 IB devices to \'$NODE_DESC <devName>\'"',
      'exit $fail',
    ].join('\n') + '\n';

  const activatorScript =
    [
      '#!/bin/sh',
      '# Cloud-init per-instance hook: activate the Brokkr IB node_desc unit on first boot.',
      '# Idempotent — safe to re-run; systemctl enable is a no-op if already enabled.',
      'systemctl daemon-reload',
      'systemctl enable --now brokkr-ib-node-desc.service || true',
    ].join('\n') + '\n';

  return [
    {
      path: '/etc/udev/rules.d/99-infiniband-node-desc.rules',
      content: `${udevRule}\n`,
      permissions: '0644',
    },
    {
      path: '/etc/systemd/system/brokkr-ib-node-desc.service',
      content: systemdUnit,
      permissions: '0644',
    },
    {
      path: '/usr/local/sbin/brokkr-ib-node-desc.sh',
      content: helperScript,
      permissions: '0755',
    },
    {
      path: '/var/lib/cloud/scripts/per-instance/50-brokkr-ib-node-desc.sh',
      content: activatorScript,
      permissions: '0755',
    },
  ];
}

function renderInfinibandCfgFromWriteFiles(writeFiles: CloudInitWriteFile[]): string {
  const doc: Record<string, unknown> = { write_files: writeFiles };
  const dumped = yaml.dump(doc, { lineWidth: 4096, noRefs: true }).trimEnd();
  return `#cloud-config\n${dumped}\n`;
}

export function renderInfinibandCfg(input: { enabled: boolean; nodeDesc: string }): string | null {
  const writeFiles = renderInfinibandWriteFiles(input);
  if (!writeFiles) return null;
  return renderInfinibandCfgFromWriteFiles(writeFiles);
}

/** Non-mapping forms (shell script, multipart MIME, malformed YAML) return null and fall back to the cloud.cfg.d fragment, which has no `users:` clobber risk. */
export function parseCustomUserDataMapping(customUserDataYaml: string | undefined): Record<string, unknown> | null {
  const customer = customUserDataYaml?.trim();
  if (!customer) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(customer);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

export function renderCustomUserDataCfg(customUserDataYaml: string | undefined): string | null {
  const customer = customUserDataYaml?.trim();
  if (!customer) return null;
  const body = customer.startsWith('#cloud-config') ? customer : `#cloud-config\n${customer}`;
  return `${body}\n`;
}

export function renderPhoneHomeScript(input: { phoneHomeCreds: PhoneHomeCredsInput }): string {
  assertNoControlChars('deployment_os_token', input.phoneHomeCreds.deployment_os_token);
  assertNoControlChars('endpoint', input.phoneHomeCreds.endpoint);
  return stripTrailingNewline(
    renderEnv.renderString(phoneHomeScriptTemplate, {
      deployment_os_token: shellQuote(input.phoneHomeCreds.deployment_os_token),
      phone_home_endpoint: shellQuote(input.phoneHomeCreds.endpoint),
    }),
  );
}

export function renderPhoneHomeCredsJson(input: {
  deviceId: string;
  phoneHomeCreds: Pick<PhoneHomeCredsInput, 'deployment_os_token'>;
}): string {
  return JSON.stringify(
    {
      deployment_os_token: input.phoneHomeCreds.deployment_os_token,
      device_id: input.deviceId,
    },
    null,
    2,
  );
}

export interface CloudInitFileSpec {
  path: string;
  content: string;
  mode: number;
}

export function renderCloudInitBundle(input: {
  hostname: string;
  distro: string;
  cloudInit: CloudInitBundleInput;
  roce: RoceRenderInput;
  infiniband?: InfinibandRenderInput | undefined;
}): CloudInitFileSpec[] {
  if (!input.cloudInit.phoneHomeCreds) {
    throw new Error('renderCloudInitBundle: phoneHomeCreds is required');
  }

  const customMapping = parseCustomUserDataMapping(input.cloudInit.customUserDataYaml);
  const infinibandWriteFiles = input.infiniband ? renderInfinibandWriteFiles(input.infiniband) : null;
  const seedInfinibandWriteFiles =
    infinibandWriteFiles && customMapping && 'write_files' in customMapping ? infinibandWriteFiles : undefined;

  const files: CloudInitFileSpec[] = [
    {
      path: 'etc/cloud/cloud.cfg',
      content: renderCloudCfg({ distro: input.distro }),
      mode: CLOUD_INIT_FILE_MODES.cloudCfg,
    },
    {
      path: 'var/lib/cloud/seed/nocloud/meta-data',
      content: renderMetaData({ deviceId: input.cloudInit.deviceId }),
      mode: CLOUD_INIT_FILE_MODES.metaData,
    },
    {
      path: 'var/lib/cloud/seed/nocloud/user-data',
      content: renderUserData({
        hostname: input.hostname,
        distro: input.distro,
        sshPubkeys: input.cloudInit.sshPubkeys,
        passwordHash: input.cloudInit.passwordHash,
        customUserData: customMapping ?? undefined,
        writeFiles: seedInfinibandWriteFiles,
      }),
      mode: CLOUD_INIT_FILE_MODES.userData,
    },
    {
      path: 'var/lib/cloud/seed/nocloud/network-config',
      content: input.cloudInit.netplanYaml,
      mode: CLOUD_INIT_FILE_MODES.networkConfig,
    },
    {
      path: 'var/lib/brokkr/phone-home-creds.json',
      content: renderPhoneHomeCredsJson({
        deviceId: input.cloudInit.deviceId,
        phoneHomeCreds: input.cloudInit.phoneHomeCreds,
      }),
      mode: CLOUD_INIT_FILE_MODES.phoneHomeCreds,
    },
    {
      path: 'var/lib/cloud/scripts/per-boot/90-phone-home.sh',
      content: renderPhoneHomeScript({ phoneHomeCreds: input.cloudInit.phoneHomeCreds }),
      mode: CLOUD_INIT_FILE_MODES.phoneHomeScript,
    },
  ];

  if (!customMapping) {
    const customCfg = renderCustomUserDataCfg(input.cloudInit.customUserDataYaml);
    if (customCfg) {
      files.push({ path: 'etc/cloud/cloud.cfg.d/01-brokkr-custom.cfg', content: customCfg, mode: 0o644 });
    }
  }

  const roceCfg = renderRoceCfg(input.roce);
  if (roceCfg) {
    files.push({ path: 'etc/cloud/cloud.cfg.d/02-brokkr-roce.cfg', content: roceCfg, mode: 0o644 });
  }

  const infinibandCfg =
    infinibandWriteFiles && !seedInfinibandWriteFiles ? renderInfinibandCfgFromWriteFiles(infinibandWriteFiles) : null;
  if (infinibandCfg) {
    files.push({ path: 'etc/cloud/cloud.cfg.d/03-brokkr-infiniband.cfg', content: infinibandCfg, mode: 0o644 });
  }

  return files;
}
