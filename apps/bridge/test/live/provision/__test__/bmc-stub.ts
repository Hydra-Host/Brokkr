import type { CreateRedfishServiceFn } from '../../../../src/lifecycle-deploy/redfish-operations';
import {
  discoverTeeHandlerWith,
  type FakeBmcRequest,
  FakeSupermicroBmc,
} from '../../../../src/redfish/__test__/supermicro-tee.testutil';
import type { JsonRecord } from '../../../../src/redfish/index';
import type { RedfishHttpResponse, RedfishRequester } from '../../../../src/redfish/vendor/base/base';

export type BmcStubMode = 'supermicro' | 'unmodeled' | 'malformed';

const UNMODELED_TREE: Record<string, JsonRecord> = {
  '/redfish': { v1: '/redfish/v1' },
  '/redfish/v1': {
    '@odata.id': '/redfish/v1',
    RedfishVersion: '1.6.0',
    Systems: { '@odata.id': '/redfish/v1/Systems' },
  },
  '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
  '/redfish/v1/Systems/1': {
    Manufacturer: 'Acme',
    Model: 'Widget 9000',
    PowerState: 'On',
    Bios: { '@odata.id': '/redfish/v1/Systems/1/Bios' },
    Links: { ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/1' }] },
    Actions: {
      '#ComputerSystem.Reset': {
        target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
        'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'ForceRestart'],
      },
    },
  },
  '/redfish/v1/Managers/1': { Model: 'Acme BMC' },
  '/redfish/v1/Systems/1/Bios': { Attributes: { BootMode: 'Uefi', SecureBoot: 'Disabled' } },
};

const MALFORMED_REPLY: RedfishHttpResponse = {
  status: 200,
  text: '<html><body>BMC web service is starting</body></html>',
  headers: { 'content-type': 'text/html' },
};

function jsonReply(status: number, document: JsonRecord): RedfishHttpResponse {
  return { status, text: JSON.stringify(document), headers: { 'content-type': 'application/json' } };
}

export class BmcStub {
  mode: BmcStubMode = 'supermicro';
  private bmc = new FakeSupermicroBmc();

  reset(): void {
    this.bmc = new FakeSupermicroBmc();
  }

  get attributes(): JsonRecord {
    return this.bmc.live;
  }

  patchedKeys(): string[] {
    return this.bmc.patchedKeys();
  }

  get resets(): number {
    return this.bmc.resets;
  }

  get requests(): readonly FakeBmcRequest[] {
    return this.bmc.requests;
  }

  private readonly repliesByMode: Record<BmcStubMode, RedfishRequester> = {
    supermicro: (params) => this.bmc.requester(params),
    unmodeled: (params) => {
      const route = UNMODELED_TREE[new URL(params.url).pathname];
      return Promise.resolve(route === undefined ? jsonReply(404, {}) : jsonReply(200, route));
    },
    malformed: () => Promise.resolve(MALFORMED_REPLY),
  };

  readonly requester: RedfishRequester = (params) => this.repliesByMode[this.mode](params);

  readonly createRedfishService: CreateRedfishServiceFn = (jobId) =>
    Promise.resolve({
      reliableBoot: () => Promise.reject(new Error('reliableBoot is outside the tee blast-radius stub')),
      setTee: async (device, newSetting) => {
        const handler = await discoverTeeHandlerWith(this.requester, device, jobId);
        return handler.setTee(newSetting);
      },
      verifyTee: async (device) => {
        const handler = await discoverTeeHandlerWith(this.requester, device, jobId);
        return handler.verifyTee();
      },
    });
}
