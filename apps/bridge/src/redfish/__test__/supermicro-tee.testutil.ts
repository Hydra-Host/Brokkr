import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import type { JsonRecord, RedfishHttpResponse, RedfishRequester, RedfishRequestParams } from '../vendor/base/base.js';
import { asArray, asRecord, RedfishDevice } from '../vendor/base/base.js';
import { RedfishTeeHandler } from '../vendor/base/tee.js';

const FIXTURES_DIR = resolve(__dirname, 'fixtures');

export const SUPERMICRO_X14_FIXTURE = 'supermicro-x14-sys-222ha-tn';
export const SUPERMICRO_X13_ASSUMED_FIXTURE = 'supermicro-x13-assumed-names';

export const SUPERMICRO_BIOS_PATH = '/redfish/v1/Systems/1/Bios';
export const SUPERMICRO_SD_PATH = '/redfish/v1/Systems/1/Bios/SD';
export const SUPERMICRO_RESET_PATH = '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset';
export const SUPERMICRO_REGISTRY_URI = '/registries/BiosAttributeRegistry.1.0.0.json';

const jsonRecordSchema = z.record(z.string(), z.unknown());
const treeSchema = z.record(z.string(), jsonRecordSchema);

export interface SupermicroTeeFixture {
  tree: Record<string, JsonRecord>;
  registry: JsonRecord;
  attributes: JsonRecord;
}

export interface FakeBmcRequest {
  method: string;
  path: string;
  body: JsonRecord | null;
}

export type FakeBmcPatchReply = 'bare' | 'extended-info';

export interface FakeSupermicroBmcOptions {
  fixture?: SupermicroTeeFixture;
  live?: JsonRecord;
  failPatchKeys?: readonly string[];
  dropPendingKeys?: readonly string[];
  sdEchoesLive?: boolean;
  patchReply?: FakeBmcPatchReply;
}

interface FakeBmcReply {
  status: number;
  document: JsonRecord;
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8'));
}

export function loadSupermicroTeeFixture(stem: string): SupermicroTeeFixture {
  return {
    tree: treeSchema.parse(readJsonFixture(`${stem}.redfish-tree.json`)),
    registry: jsonRecordSchema.parse(readJsonFixture(`${stem}.registry-tee.json`)),
    attributes: jsonRecordSchema.parse(readJsonFixture(`${stem}.bios-attributes-tee.json`)),
  };
}

export function registryAttributes(fixture: SupermicroTeeFixture): JsonRecord[] {
  return asArray(asRecord(fixture.registry['RegistryEntries'])['Attributes']).map(asRecord);
}

export function withRegistryAttributes(fixture: SupermicroTeeFixture, attributes: JsonRecord[]): SupermicroTeeFixture {
  return { ...fixture, registry: { ...fixture.registry, RegistryEntries: { Attributes: attributes } } };
}

function bareReply(): FakeBmcReply {
  return { status: 200, document: {} };
}

function successReply(): FakeBmcReply {
  return {
    status: 200,
    document: {
      '@Message.ExtendedInfo': [
        {
          MessageId: 'Base.1.4.Success',
          Message: 'Successfully Completed Request',
          Resolution: 'None',
          Severity: 'OK',
        },
      ],
    },
  };
}

function notWritableReply(key: string): FakeBmcReply {
  return {
    status: 400,
    document: {
      error: {
        code: 'Base.1.4.GeneralError',
        message: 'A general error has occurred. See ExtendedInfo for more information.',
        '@Message.ExtendedInfo': [
          {
            MessageId: 'Base.1.4.PropertyNotWritable',
            Message: `The property ${key} is a read only property and cannot be assigned a value.`,
            Resolution: 'Remove the property from the request body and resubmit the request.',
            Severity: 'Warning',
          },
        ],
      },
    },
  };
}

export class FakeSupermicroBmc {
  readonly fixture: SupermicroTeeFixture;
  readonly live: JsonRecord;
  readonly patches: JsonRecord[] = [];
  readonly requests: FakeBmcRequest[] = [];
  readonly failPatchKeys: Set<string>;
  readonly dropPendingKeys: Set<string>;
  readonly sdEchoesLive: boolean;
  readonly patchReply: FakeBmcPatchReply;
  pending: JsonRecord = {};
  resets = 0;

  constructor(options: FakeSupermicroBmcOptions = {}) {
    this.fixture = options.fixture ?? loadSupermicroTeeFixture(SUPERMICRO_X14_FIXTURE);
    this.live = { ...(options.live ?? this.fixture.attributes) };
    this.failPatchKeys = new Set(options.failPatchKeys ?? []);
    this.dropPendingKeys = new Set(options.dropPendingKeys ?? []);
    this.sdEchoesLive = options.sdEchoesLive ?? true;
    this.patchReply = options.patchReply ?? 'bare';
  }

  readonly requester = (params: RedfishRequestParams): Promise<RedfishHttpResponse> => {
    const body = params.body === null ? null : jsonRecordSchema.parse(JSON.parse(params.body));
    const reply = this.handle(params.method, new URL(params.url).pathname, body);
    return Promise.resolve({
      status: reply.status,
      text: JSON.stringify(reply.document),
      headers: { 'content-type': 'application/json' },
    });
  };

  sdAttributes(): JsonRecord {
    return this.sdEchoesLive ? { ...this.live, ...this.pending } : { ...this.pending };
  }

  patchedKeys(): string[] {
    return this.patches.flatMap((patch) => Object.keys(patch));
  }

  private handle(method: string, path: string, body: JsonRecord | null): FakeBmcReply {
    this.requests.push({ method, path, body });
    if (method === 'GET') return this.get(path);
    if (method === 'PATCH' && path === SUPERMICRO_SD_PATH) return this.patchSd(asRecord(body?.['Attributes']));
    if (method === 'POST' && path === SUPERMICRO_RESET_PATH) {
      this.resets += 1;
      Object.assign(this.live, this.pending);
      this.pending = {};
      return successReply();
    }
    return { status: 405, document: {} };
  }

  private get(path: string): FakeBmcReply {
    if (path === '/redfish') return { status: 200, document: { v1: '/redfish/v1' } };
    if (path === SUPERMICRO_REGISTRY_URI) return { status: 200, document: this.fixture.registry };
    const route = this.fixture.tree[path];
    if (route === undefined) return { status: 404, document: {} };
    if (path === SUPERMICRO_BIOS_PATH) return { status: 200, document: { ...route, Attributes: { ...this.live } } };
    if (path === SUPERMICRO_SD_PATH) return { status: 200, document: { ...route, Attributes: this.sdAttributes() } };
    return { status: 200, document: route };
  }

  private patchSd(attributes: JsonRecord): FakeBmcReply {
    this.patches.push(attributes);
    const rejected = Object.keys(attributes).find((key) => this.failPatchKeys.has(key));
    if (rejected !== undefined) return notWritableReply(rejected);
    for (const [key, value] of Object.entries(attributes)) {
      if (!this.dropPendingKeys.has(key)) this.pending[key] = value;
    }
    return this.patchReply === 'bare' ? bareReply() : successReply();
  }
}

export async function discoverTeeHandlerWith(
  requester: RedfishRequester,
  device: RedfishDevice,
  jobId = 'test-job',
): Promise<RedfishTeeHandler> {
  device.rebootTimeout = 0;
  const handler = new RedfishTeeHandler(device, jobId, requester);
  await handler.discover();
  return handler;
}

export function discoverSupermicroTeeHandler(bmc: FakeSupermicroBmc, jobId = 'test-job'): Promise<RedfishTeeHandler> {
  return discoverTeeHandlerWith(
    bmc.requester,
    new RedfishDevice(jobId, 'dev-1', '192.0.2.10', 'ADMIN', 'ADMIN'),
    jobId,
  );
}
