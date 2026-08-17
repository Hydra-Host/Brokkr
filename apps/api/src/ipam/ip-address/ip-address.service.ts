import { Injectable } from '@nestjs/common';
import { CreateIpAddressRequest, IpAddress, IpAddressListQuery, UpdateIpAddressRequest } from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { IpAddressEntity } from './ip-address.entity';
import { IpAddressRepository } from './ip-address.repository';

@Injectable()
export class IpAddressService {
  constructor(
    private readonly ipaddressRepository: IpAddressRepository,
    private readonly contextService: ContextService,
    private readonly dhcpPublisher: DhcpConfigPublisherService,
  ) {}

  async findById(id: string): Promise<IpAddress> {
    this.contextService.requirePermission('ipam', 'read');
    return this.ipaddressRepository.restore(id);
  }

  async listIpAddresses(query: IpAddressListQuery): Promise<IpAddress[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.ipaddressRepository.listIpAddresses(query);
  }

  async createIpAddress(input: CreateIpAddressRequest): Promise<IpAddress> {
    this.contextService.requirePermission('ipam', 'create');
    // A cross-org interfaceId would pin this IP onto a foreign device; `!= null` (not truthiness) so a
    // falsy-but-present value can't silently skip the guard.
    if (input.interfaceId != null) await this.ipaddressRepository.assertInterfaceInOrg(input.interfaceId);
    const normalizedAddress = await this.ipaddressRepository.normalizeAddress(input.address);
    const entity = IpAddressEntity.create(input, this.contextService.organizationId, normalizedAddress);
    await this.ipaddressRepository.ensureVrf(entity);
    const created = await this.ipaddressRepository.createWithConflictGuard(entity);
    // A device-interface IP is a DHCP reservation — republish its prefix eagerly.
    await this.dhcpPublisher.republishForIpAddress(created.id);
    return created;
  }

  async updateIpAddress(id: string, input: UpdateIpAddressRequest): Promise<IpAddress> {
    this.contextService.requirePermission('ipam', 'update');
    // Cross-org ownership guard for an interface assign; null/absent (clear or no-op) skip it.
    if (input.interfaceId != null) await this.ipaddressRepository.assertInterfaceInOrg(input.interfaceId);
    const before = await this.ipaddressRepository.restore(id);
    const previousVrfId = before.vrfId;
    const entity = IpAddressEntity.restore(before);
    entity.applyUpdate(input);
    // A prefix's VRRP VIP must stay unbound — an actual VRF change or an interface assign would violate that; one pre-flight covers both arms, and updateWithConflictGuard re-asserts it in-tx under the shared IP lock (TOCTOU close).
    // Gate the VRF arm on the value delta (not `changes.vrfId`, which a same-value PATCH also sets) so a no-op resend isn't rejected.
    const vrfChanged = previousVrfId !== entity.state.vrfId;
    if (vrfChanged || input.interfaceId != null) {
      await this.ipaddressRepository.ensureNotInUseAsVrrpVip(id);
    }
    await this.ipaddressRepository.ensureVrf(entity);
    const updated = await this.ipaddressRepository.updateWithConflictGuard(entity, before, vrfChanged);
    await this.dhcpPublisher.republishForIpAddress(updated.id);
    // A VRF move relocates the IP to another prefix — republish the OLD prefix too or its atom keeps serving the stale reservation.
    if (vrfChanged) {
      await this.dhcpPublisher.republishForReservation(
        before.address,
        this.contextService.organizationId,
        previousVrfId,
      );
    }
    return updated;
  }

  async archiveIpAddress(id: string): Promise<IpAddress> {
    this.contextService.requirePermission('ipam', 'delete');
    const before = await this.ipaddressRepository.restore(id);
    // Pre-flight fast fail: archiving a VIP IP would leave the prefix pointing at a soft-deleted IP with its Redis atom never torn down.
    await this.ipaddressRepository.ensureNotInUseAsVrrpVip(id);
    const entity = IpAddressEntity.restore(before);
    entity.archive();
    // archiveUnderLock (not a bare save) re-asserts the check in-tx — TOCTOU close vs a concurrent setPrefixVrrpVip.
    const archived = await this.ipaddressRepository.archiveUnderLock(entity, before);
    await this.dhcpPublisher.republishForIpAddress(archived.id);
    return archived;
  }
}
