import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { ZoneRedisAclService } from './zone-redis-acl.service';
import { ZonesService } from './zones.service';

@Controller()
export class ZonesController {
  constructor(
    private readonly zonesService: ZonesService,
    private readonly zoneRedisAcl: ZoneRedisAclService,
  ) {}

  @TsRestHandler(contract.getZones)
  async getZones() {
    return tsRestHandler(contract.getZones, async ({ query }) => {
      const result = await this.zonesService.getZonesPaginated(query);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.createZone)
  async createZone() {
    return tsRestHandler(contract.createZone, async ({ body }) => {
      const zone = await this.zonesService.createZone(body);
      return { status: 201 as const, body: zone };
    });
  }

  @TsRestHandler(contract.getZoneById)
  async getZoneById() {
    return tsRestHandler(contract.getZoneById, async ({ params }) => {
      const zone = await this.zonesService.getZoneById(params.zoneId);
      return { status: 200 as const, body: zone };
    });
  }

  @TsRestHandler(contract.updateZoneName)
  async updateZoneName() {
    return tsRestHandler(contract.updateZoneName, async ({ params, body }) => {
      const zone = await this.zonesService.updateName(params.zoneId, body.name);
      return { status: 200 as const, body: zone };
    });
  }

  @TsRestHandler(contract.updateZonePrimaryAddress)
  async updatePrimaryAddress() {
    return tsRestHandler(contract.updateZonePrimaryAddress, async ({ params, body }) => {
      const zone = await this.zonesService.updatePrimaryAddress(params.zoneId, body);
      return { status: 200 as const, body: zone };
    });
  }

  @TsRestHandler(contract.updateZoneShippingAddress)
  async updateShippingAddress() {
    return tsRestHandler(contract.updateZoneShippingAddress, async ({ params, body }) => {
      const zone = await this.zonesService.updateShippingAddress(params.zoneId, body);
      return { status: 200 as const, body: zone };
    });
  }

  @TsRestHandler(contract.rotateZoneRedisCredential)
  async rotateZoneRedisCredential() {
    return tsRestHandler(contract.rotateZoneRedisCredential, async ({ params }) => {
      const credential = await this.zoneRedisAcl.rotateCredential(params.zoneId);
      return { status: 201 as const, body: { username: credential.username, password: credential.password } };
    });
  }

  @TsRestHandler(contract.deleteZone)
  async deleteZone() {
    return tsRestHandler(contract.deleteZone, async ({ params }) => {
      await this.zonesService.deleteZone(params.zoneId);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.getZoneContacts)
  async getContacts() {
    return tsRestHandler(contract.getZoneContacts, async ({ params, query }) => {
      const result = await this.zonesService.getContactsPaginated(params.zoneId, query);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.createZoneContact)
  async createContact() {
    return tsRestHandler(contract.createZoneContact, async ({ params, body }) => {
      const contact = await this.zonesService.createContact(params.zoneId, body);
      return { status: 201 as const, body: contact };
    });
  }

  @TsRestHandler(contract.getZoneContact)
  async getContact() {
    return tsRestHandler(contract.getZoneContact, async ({ params }) => {
      const contact = await this.zonesService.getContact(params.zoneId, params.contactId);
      return { status: 200 as const, body: contact };
    });
  }

  @TsRestHandler(contract.updateZoneContact)
  async updateContact() {
    return tsRestHandler(contract.updateZoneContact, async ({ params, body }) => {
      const contact = await this.zonesService.updateContact(params.zoneId, params.contactId, body);
      return { status: 200 as const, body: contact };
    });
  }

  @TsRestHandler(contract.deleteZoneContact)
  async deleteContact() {
    return tsRestHandler(contract.deleteZoneContact, async ({ params }) => {
      await this.zonesService.deleteContact(params.zoneId, params.contactId);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.getZoneDhcpPrefixes)
  async getZoneDhcpPrefixes() {
    return tsRestHandler(contract.getZoneDhcpPrefixes, async ({ params }) => {
      const summaries = await this.zonesService.getDhcpPrefixSummary(params.zoneId);
      return { status: 200 as const, body: summaries };
    });
  }

  @TsRestHandler(contract.getZoneVrrpPrefixes)
  async getZoneVrrpPrefixes() {
    return tsRestHandler(contract.getZoneVrrpPrefixes, async ({ params }) => {
      const summaries = await this.zonesService.getVrrpPrefixSummary(params.zoneId);
      return { status: 200 as const, body: summaries };
    });
  }
}
