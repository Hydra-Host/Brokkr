import { Controller, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SupplyOrganizationGuard } from 'src/auth/guards/supply-organization.guard';
import { PrefixBootReadinessService } from './prefix-boot-readiness.service';
import { PrefixService } from './prefix.service';

@UseGuards(SupplyOrganizationGuard)
@Controller()
export class PrefixController {
  constructor(
    private readonly prefixService: PrefixService,
    private readonly prefixBootReadinessService: PrefixBootReadinessService,
  ) {}

  @TsRestHandler(contract.getPrefix)
  async getById() {
    return tsRestHandler(contract.getPrefix, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.findById(params.id),
    }));
  }

  @TsRestHandler(contract.listPrefixes)
  async listPrefixes() {
    return tsRestHandler(contract.listPrefixes, async ({ query }) => ({
      status: 200,
      body: await this.prefixService.listPrefixes(query),
    }));
  }

  @TsRestHandler(contract.createPrefix)
  async createPrefix() {
    return tsRestHandler(contract.createPrefix, async ({ body }) => ({
      status: 201,
      body: await this.prefixService.createPrefix(body),
    }));
  }

  @TsRestHandler(contract.updatePrefix)
  async updatePrefix() {
    return tsRestHandler(contract.updatePrefix, async ({ params, body }) => ({
      status: 200,
      body: await this.prefixService.updatePrefix(params.id, body),
    }));
  }

  @TsRestHandler(contract.archivePrefix)
  async archivePrefix() {
    return tsRestHandler(contract.archivePrefix, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.archivePrefix(params.id),
    }));
  }

  @TsRestHandler(contract.listChildPrefixes)
  async listChildPrefixes() {
    return tsRestHandler(contract.listChildPrefixes, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.listChildPrefixes(params.id),
    }));
  }

  @TsRestHandler(contract.listIpsInPrefix)
  async listIpsInPrefix() {
    return tsRestHandler(contract.listIpsInPrefix, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.listIpsInPrefix(params.id),
    }));
  }

  @TsRestHandler(contract.getPrefixUtilization)
  async getPrefixUtilization() {
    return tsRestHandler(contract.getPrefixUtilization, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.getPrefixUtilization(params.id),
    }));
  }

  @TsRestHandler(contract.allocateNextPrefix)
  async allocateNextPrefix() {
    return tsRestHandler(contract.allocateNextPrefix, async ({ params, body }) => ({
      status: 201,
      body: await this.prefixService.allocateNextPrefix(params.id, body),
    }));
  }

  @TsRestHandler(contract.detectPrefixOverlap)
  async detectPrefixOverlap() {
    return tsRestHandler(contract.detectPrefixOverlap, async ({ body }) => ({
      status: 200,
      body: await this.prefixService.detectPrefixOverlap(body),
    }));
  }

  @TsRestHandler(contract.setPrefixGateway)
  async setPrefixGateway() {
    return tsRestHandler(contract.setPrefixGateway, async ({ params, body }) => ({
      status: 200,
      body: await this.prefixService.setPrefixGateway(params.id, body.gatewayIpId),
    }));
  }

  @TsRestHandler(contract.clearPrefixGateway)
  async clearPrefixGateway() {
    return tsRestHandler(contract.clearPrefixGateway, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.clearPrefixGateway(params.id),
    }));
  }

  @TsRestHandler(contract.setPrefixVrrpVip)
  async setPrefixVrrpVip() {
    return tsRestHandler(contract.setPrefixVrrpVip, async ({ params, body }) => ({
      status: 200,
      body: await this.prefixService.setPrefixVrrpVip(params.id, body.vrrpVipId, body.bindings),
    }));
  }

  @TsRestHandler(contract.getPrefixVrrpBindings)
  async getPrefixVrrpBindings() {
    return tsRestHandler(contract.getPrefixVrrpBindings, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.getPrefixVrrpBindings(params.id),
    }));
  }

  @TsRestHandler(contract.clearPrefixVrrpVip)
  async clearPrefixVrrpVip() {
    return tsRestHandler(contract.clearPrefixVrrpVip, async ({ params }) => ({
      status: 200,
      body: await this.prefixService.clearPrefixVrrpVip(params.id),
    }));
  }

  @TsRestHandler(contract.validatePrefixGateway)
  async validatePrefixGateway() {
    return tsRestHandler(contract.validatePrefixGateway, async ({ body }) => ({
      status: 200,
      body: await this.prefixService.validatePrefixGatewayRequest(body),
    }));
  }

  @TsRestHandler(contract.getPrefixDnsOverride)
  async getPrefixDnsOverride() {
    return tsRestHandler(contract.getPrefixDnsOverride, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.getDnsOverride(params.id),
    }));
  }

  @TsRestHandler(contract.updatePrefixDnsOverride)
  async updatePrefixDnsOverride() {
    return tsRestHandler(contract.updatePrefixDnsOverride, async ({ params, body }) => ({
      status: 200 as const,
      body: await this.prefixService.updateDnsOverride(params.id, body),
    }));
  }

  @TsRestHandler(contract.getPrefixDhcpConfig)
  async getPrefixDhcpConfig() {
    return tsRestHandler(contract.getPrefixDhcpConfig, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.getDhcpConfig(params.id),
    }));
  }

  @TsRestHandler(contract.updatePrefixDhcpConfig)
  async updatePrefixDhcpConfig() {
    return tsRestHandler(contract.updatePrefixDhcpConfig, async ({ params, body }) => ({
      status: 200 as const,
      body: await this.prefixService.updateDhcpConfig(params.id, body),
    }));
  }

  @TsRestHandler(contract.getPrefixDhcpLeases)
  async getPrefixDhcpLeases() {
    return tsRestHandler(contract.getPrefixDhcpLeases, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.getDhcpLeases(params.id),
    }));
  }

  @TsRestHandler(contract.getPrefixDhcpReservations)
  async getPrefixDhcpReservations() {
    return tsRestHandler(contract.getPrefixDhcpReservations, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.getDhcpReservations(params.id),
    }));
  }

  @TsRestHandler(contract.getPrefixDhcpServing)
  async getPrefixDhcpServing() {
    return tsRestHandler(contract.getPrefixDhcpServing, async ({ params }) => ({
      status: 200 as const,
      body: await this.prefixService.getDhcpServing(params.id),
    }));
  }

  @TsRestHandler(contract.getPrefixBootReadiness)
  async getPrefixBootReadiness() {
    return tsRestHandler(contract.getPrefixBootReadiness, async ({ params, query }) => ({
      status: 200 as const,
      body: await this.prefixBootReadinessService.check(params.id, query),
    }));
  }
}
