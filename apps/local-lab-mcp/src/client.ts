import { initClient } from '@ts-rest/core';
import { execFileSync } from 'node:child_process';
import labContractPkg from './lab-contract.js';
import { findEntryByCheckout, hostStackCandidates, labPortOf, labUrlForPort } from './stack-registry.js';
import { describeCandidates, describeTarget, RETARGET_HINT, slotTargetFromEnv, type LabTarget } from './target.js';

const { contract } = labContractPkg;

type ClientArgs = NonNullable<Parameters<typeof initClient>[1]>;
export type LabApiFetcher = ClientArgs['api'];

export interface LabClientOptions {
  baseUrl?: string;
  token?: string;
  api?: LabApiFetcher;
  registryDir?: string;
}

let checkout: string | undefined;

// memoized: `git rev-parse` per tool call would be a subprocess on every read.
export function currentCheckout(): string {
  if (checkout !== undefined) return checkout;
  let toplevel = process.cwd();
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) toplevel = out;
  } catch {
    // outside a checkout the working directory is the identity we refuse against
  }
  checkout = toplevel;
  return checkout;
}

function noSlotRefusal(checkout: string, registryDir?: string): Error {
  const head = `this checkout owns no dev-stack slot: ${checkout}`;
  const candidates = hostStackCandidates(registryDir);
  if (candidates.length === 0) {
    return new Error(`${head}\nno stacks are registered on this host; run \`task up\` here`);
  }
  return new Error(
    `${head}\nstacks on this host:\n${describeCandidates(candidates)}\n` +
      `${RETARGET_HINT}, or run \`task up\` here to claim your own`,
  );
}

function pinnedTarget(baseUrl: string, source: 'explicit' | 'env-url'): LabTarget {
  return { baseUrl, slot: null, checkout: null, sameRepo: false, source, own: source === 'explicit' };
}

export function resolveLabTarget(explicit?: string, registryDir?: string): LabTarget {
  if (explicit) return pinnedTarget(explicit, 'explicit');
  if (process.env.LAB_MCP_URL) return pinnedTarget(process.env.LAB_MCP_URL, 'env-url');
  const fromEnvSlot = slotTargetFromEnv(registryDir);
  if (fromEnvSlot) return fromEnvSlot;
  const checkout = currentCheckout();
  const own = findEntryByCheckout(checkout, registryDir);
  const port = own && labPortOf(own);
  // refusing beats defaulting to slot 0: that default succeeds against a stranger's stack.
  if (!own || port === null) throw noSlotRefusal(checkout, registryDir);
  return {
    baseUrl: labUrlForPort(port),
    slot: own.slot,
    checkout,
    sameRepo: true,
    source: 'registry',
    own: true,
  };
}

export function resolveLabBaseUrl(explicit?: string, registryDir?: string): string {
  return resolveLabTarget(explicit, registryDir).baseUrl;
}

export function resolveLabToken(explicit?: string): string {
  return explicit ?? process.env.LAB_API_TOKEN ?? '';
}

export function createLabClient(options: LabClientOptions = {}) {
  const baseUrl = resolveLabBaseUrl(options.baseUrl, options.registryDir);
  const token = resolveLabToken(options.token);
  return initClient(contract, {
    baseUrl,
    baseHeaders: token ? { 'x-lab-token': token } : {},
    ...(options.api ? { api: options.api } : {}),
  });
}

export type LabClient = ReturnType<typeof createLabClient>;

export interface LabTargetInfo {
  slot: number | null;
  checkout: string | null;
  source: LabTarget['source'];
  own: boolean;
}

export interface LabContext {
  client: LabClient;
  baseUrl: string;
  target: LabTarget;
  targetInfo: LabTargetInfo | null;
  targetNotice: string | null;
  setTarget: (target: LabTarget) => void;
  registryDir: string | undefined;
  token: string;
  fetchImpl: typeof fetch;
}

// resolution is lazy: the server builds its context at module load, so an eager throw would kill it
// before the agent could bring the stack up, and recovering would need an MCP restart.
export function createLabContext(options: LabClientOptions & { fetchImpl?: typeof fetch } = {}): LabContext {
  const token = resolveLabToken(options.token);
  let resolved: LabTarget | undefined;
  let override: LabTarget | undefined;
  let client: LabClient | undefined;
  let clientUrl: string | undefined;
  // the override outranks an explicit baseUrl on purpose: short-circuiting on the pin would make
  // lab_use_stack report success and change nothing, which is worse than the pin losing
  const target = () => override ?? (resolved ??= resolveLabTarget(options.baseUrl, options.registryDir));
  return {
    // keyed on the url rather than memoized outright, so a retarget cannot keep serving the old one
    get client() {
      const url = target().baseUrl;
      if (!client || clientUrl !== url) {
        client = createLabClient({ ...options, baseUrl: url, token });
        clientUrl = url;
      }
      return client;
    },
    get baseUrl() {
      return target().baseUrl;
    },
    get target() {
      return target();
    },
    // both notice getters swallow: they run on the error path too, where resolution is what threw
    get targetInfo() {
      try {
        const current = target();
        return {
          slot: current.slot,
          checkout: current.checkout,
          source: current.source,
          own: current.own,
        };
      } catch {
        return null;
      }
    },
    get targetNotice() {
      try {
        const current = target();
        return current.own ? null : describeTarget(current);
      } catch {
        return null;
      }
    },
    setTarget(next: LabTarget) {
      override = next;
    },
    registryDir: options.registryDir,
    token,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}
