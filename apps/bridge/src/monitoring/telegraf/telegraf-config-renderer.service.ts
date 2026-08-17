// Devices sorted by device_id (string sort, NOT numeric) for byte-identical output — the writer's hash-based change detection relies on it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as nunjucks from 'nunjucks';

import { getApplicationConfig } from '../../core/application.config';

import { CDU_MEASUREMENTS } from './cdu-measurements';
import { PDU_PROFILES } from './pdu-snmp-profiles';

export const KIND_SERVER = 'server';
export const KIND_PDU = 'pdu';
export const KIND_CDU = 'cdu';

const TEMPLATE_NAME = 'owned-devices.conf.njk';

export interface OwnedDevice {
  device_id: string;
  kind?: string;
  pdu_profile?: string | null;
  bmc_ip?: string | null;
}

export interface RenderConfig {
  bridge_api_url: string;
  poll_interval?: string;
  timeout?: string;
}

const DEFAULT_POLL_INTERVAL = '30s';
const DEFAULT_TIMEOUT = '10s';

interface CachedRenderer {
  env: nunjucks.Environment;
  template: string;
}

let cached: CachedRenderer | null = null;

function getRenderer(): CachedRenderer {
  if (cached !== null) return cached;
  const templatePath = join(getApplicationConfig().assetsDir, 'telegraf', TEMPLATE_NAME);
  // nunjucks trimBlocks doesn't strip the newline after `{# … #}` — pre-strip comment blocks or they leak blank lines into the output.
  const raw = readFileSync(templatePath, 'utf-8');
  const template = raw.replace(/\{#[\s\S]*?#\}\n?/g, '');
  const env = new nunjucks.Environment(null, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
    throwOnUndefined: true,
  });
  env.addFilter('jsonstr', jsonstr);
  cached = { env, template };
  return cached;
}

export function resetTelegrafRendererForTests(): void {
  cached = null;
}

export function renderOwnedDevicesConf(devices: Iterable<OwnedDevice>, config: RenderConfig): string {
  const sorted = [...devices].sort((a, b) => (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
  const renderConfig = {
    bridge_api_url: config.bridge_api_url,
    poll_interval: config.poll_interval ?? DEFAULT_POLL_INTERVAL,
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
  };
  const pduProfiles = {
    get: (key: string | null | undefined): unknown => (key != null ? (PDU_PROFILES[key] ?? null) : null),
  };

  const { env, template } = getRenderer();
  const rendered = env.renderString(template, {
    devices: sorted,
    config: renderConfig,
    cdu_measurements: CDU_MEASUREMENTS,
    pdu_profiles: pduProfiles,
  });

  return rendered;
}

export function jsonstr(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}
