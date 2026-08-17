import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { DnsService } from './dns.service';

@Controller()
export class DnsController {
  constructor(private readonly dnsService: DnsService) {}

  @TsRestHandler(contract.listDnsDomains)
  async listDomains() {
    return tsRestHandler(contract.listDnsDomains, async ({ params }) => ({
      status: 200 as const,
      body: await this.dnsService.listDomains(params.zoneId),
    }));
  }

  @TsRestHandler(contract.createDnsDomain)
  async createDomain() {
    return tsRestHandler(contract.createDnsDomain, async ({ params, body }) => ({
      status: 201 as const,
      body: await this.dnsService.createDomain(params.zoneId, body),
    }));
  }

  @TsRestHandler(contract.getDnsDomain)
  async getDomain() {
    return tsRestHandler(contract.getDnsDomain, async ({ params }) => ({
      status: 200 as const,
      body: await this.dnsService.getDomain(params.zoneId, params.domainId),
    }));
  }

  @TsRestHandler(contract.updateDnsDomain)
  async updateDomain() {
    return tsRestHandler(contract.updateDnsDomain, async ({ params, body }) => ({
      status: 200 as const,
      body: await this.dnsService.updateDomain(params.zoneId, params.domainId, body),
    }));
  }

  @TsRestHandler(contract.deleteDnsDomain)
  async deleteDomain() {
    return tsRestHandler(contract.deleteDnsDomain, async ({ params }) => {
      await this.dnsService.deleteDomain(params.zoneId, params.domainId);
      return { status: 204 as const, body: undefined };
    });
  }

  @TsRestHandler(contract.listDnsRecords)
  async listRecords() {
    return tsRestHandler(contract.listDnsRecords, async ({ params, query }) => ({
      status: 200 as const,
      body: await this.dnsService.listRecords(params.zoneId, params.domainId, query),
    }));
  }

  @TsRestHandler(contract.createDnsRecord)
  async createRecord() {
    return tsRestHandler(contract.createDnsRecord, async ({ params, body }) => ({
      status: 201 as const,
      body: await this.dnsService.createRecord(params.zoneId, params.domainId, body),
    }));
  }

  @TsRestHandler(contract.updateDnsRecord)
  async updateRecord() {
    return tsRestHandler(contract.updateDnsRecord, async ({ params, body }) => ({
      status: 200 as const,
      body: await this.dnsService.updateRecord(params.zoneId, params.domainId, params.recordId, body),
    }));
  }

  @TsRestHandler(contract.deleteDnsRecord)
  async deleteRecord() {
    return tsRestHandler(contract.deleteDnsRecord, async ({ params }) => {
      await this.dnsService.deleteRecord(params.zoneId, params.domainId, params.recordId);
      return { status: 204 as const, body: undefined };
    });
  }
}
