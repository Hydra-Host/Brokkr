import { isRecord, sleep } from '@repo/utils';
import { load } from 'js-yaml';

import { uuidv5 } from '../brokkr-bridge/device-record/placeholder-id';
import type { ZoneCryptoRepository } from '../zone-crypto/zone-crypto.repository';

export interface BmcCreds {
  user: string;
  pass: string;
}

export interface BaremetalNode {
  name: string;
  pxeMac: string;
}

// Frozen — regenerating would change every baremetal Device.id + its sealed secret; must match local-sim's derivation.
const LOCAL_NS = '5d4e0c4a-1f7c-4f4e-9c4e-1d8d2a3b4c5d';

export interface SimNode {
  index: number;
  name: string;
  zoneName: string | undefined;
  bmc: BmcCreds;
}

const DEFAULT_BMC: BmcCreds = { user: 'admin', pass: 'admin' };

export function simDeviceUuid(index: number): string {
  return `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
}

export function bmDeviceUuid(mac: string): string {
  return uuidv5(`baremetal:${mac.toLowerCase()}`, LOCAL_NS);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function readBmc(raw: unknown, defaults: BmcCreds): BmcCreds {
  if (raw === null || typeof raw !== 'object') return defaults;
  const block = raw as Record<string, unknown>;
  return {
    user: asString(block.username, defaults.user),
    pass: asString(block.password, defaults.pass),
  };
}

export function parseFleetMode(text: string): 'vm' | 'baremetal' {
  const doc = load(text);
  if (!isRecord(doc)) return 'vm';
  return doc.mode === 'baremetal' ? 'baremetal' : 'vm';
}

export function parseFleetYaml(text: string): SimNode[] {
  const doc = load(text);
  if (doc === null || typeof doc !== 'object') {
    throw new Error('fleet.yml did not parse to an object');
  }
  const fleet = doc as Record<string, unknown>;
  const defaultsRaw = fleet.defaults;
  const defaultsBmc =
    defaultsRaw !== null && typeof defaultsRaw === 'object'
      ? readBmc((defaultsRaw as Record<string, unknown>).bmc, DEFAULT_BMC)
      : DEFAULT_BMC;

  const nodesRaw = fleet.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new Error('fleet.yml has no nodes');
  }

  return nodesRaw.map((nodeRaw, index) => {
    const node = (nodeRaw !== null && typeof nodeRaw === 'object' ? nodeRaw : {}) as Record<string, unknown>;
    return {
      index,
      name: asString(node.name, `node-${index}`),
      zoneName: typeof node.zone === 'string' ? node.zone : undefined,
      bmc: readBmc(node.bmc, defaultsBmc),
    };
  });
}

export function parseBaremetalNodes(text: string): BaremetalNode[] {
  const doc = load(text);
  if (!isRecord(doc)) {
    throw new Error('fleet.yml did not parse to an object');
  }
  const mode = typeof doc.mode === 'string' ? doc.mode : 'vm';
  if (mode !== 'baremetal') return [];

  const baremetal = isRecord(doc.baremetal) ? doc.baremetal : {};
  const nodesRaw = baremetal.nodes;
  if (!Array.isArray(nodesRaw)) return [];

  return nodesRaw.map((nodeRaw, index) => {
    if (!isRecord(nodeRaw) || typeof nodeRaw.name !== 'string' || typeof nodeRaw.pxe_mac !== 'string') {
      throw new Error(`baremetal.nodes[${index}] must have string name + pxe_mac`);
    }
    return { name: nodeRaw.name, pxeMac: nodeRaw.pxe_mac };
  });
}

export const ENROLLMENT_POLL_ATTEMPTS = 30;
const ENROLLMENT_POLL_INTERVAL_MS = 2000;

export async function waitForEnrollment(enrollments: ZoneCryptoRepository, zoneId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= ENROLLMENT_POLL_ATTEMPTS; attempt += 1) {
    const enrollment = await enrollments.findEnrollmentByZoneId(zoneId);
    if (enrollment && enrollment.zonePub.length > 0) return true;
    if (attempt < ENROLLMENT_POLL_ATTEMPTS) await sleep(ENROLLMENT_POLL_INTERVAL_MS);
  }
  return false;
}
