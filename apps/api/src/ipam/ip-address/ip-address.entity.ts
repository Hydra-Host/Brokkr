import { CreateIpAddressRequest, IpAddress, UpdateIpAddressRequest } from '@repo/api-client';

interface IpAddressChangeSet {
  status: boolean;
  dnsName: boolean;
  vrfId: boolean;
  // Covers interfaceId AND its dual-written assignedObjectType/assignedObjectId — they always change together.
  interfaceId: boolean;
}

export class IpAddressEntity {
  private _ipAddress: IpAddress;
  private _changes: IpAddressChangeSet;
  private _isNew: boolean;
  private _isArchived: boolean;

  private constructor(ipAddress: IpAddress, isNew: boolean) {
    this._ipAddress = ipAddress;
    this._isNew = isNew;
    this._isArchived = false;
    this._changes = {
      status: false,
      dnsName: false,
      vrfId: false,
      interfaceId: false,
    };
  }

  static create(input: CreateIpAddressRequest, organizationId: string, normalizedAddress: string): IpAddressEntity {
    return new IpAddressEntity(
      {
        id: '',
        address: normalizedAddress,
        status: input.status ?? 'ACTIVE',
        dnsName: input.dnsName ?? null,
        organizationId,
        vrfId: input.vrfId ?? null,
        // Dual-write the polymorphic assignment in lockstep with interfaceId, mirroring the
        // reconciler's ensureIpAddress, so an interface-assigned IP is visible to polymorphic filters.
        assignedObjectType: input.interfaceId ? 'Interface' : null,
        assignedObjectId: input.interfaceId ?? null,
        interfaceId: input.interfaceId ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      true,
    );
  }

  static restore(ipAddress: IpAddress): IpAddressEntity {
    // Clone: applyUpdate mutates in place; aliasing would corrupt the caller's changelog "before" snapshot.
    return new IpAddressEntity({ ...ipAddress }, false);
  }

  get state(): IpAddress {
    return this._ipAddress;
  }

  get changes(): IpAddressChangeSet {
    return this._changes;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get isArchived(): boolean {
    return this._isArchived;
  }

  get shouldValidateVrf(): boolean {
    return (this._isNew || this._changes.vrfId) && this._ipAddress.vrfId !== null;
  }

  get shouldCheckAddressUniqueness(): boolean {
    return this._isNew || this._changes.vrfId;
  }

  applyUpdate(input: UpdateIpAddressRequest): void {
    if (input.status !== undefined) {
      this._ipAddress.status = input.status;
      this._changes.status = true;
    }
    if (input.dnsName !== undefined) {
      this._ipAddress.dnsName = input.dnsName ?? null;
      this._changes.dnsName = true;
    }
    if (input.vrfId !== undefined) {
      this._ipAddress.vrfId = input.vrfId ?? null;
      this._changes.vrfId = true;
    }
    if (input.interfaceId !== undefined) {
      this._ipAddress.interfaceId = input.interfaceId ?? null;
      this._changes.interfaceId = true;
      // Lockstep dual-write (see create); an unassign must also clear the stale assignedObjectId.
      this._ipAddress.assignedObjectType = input.interfaceId ? 'Interface' : null;
      this._ipAddress.assignedObjectId = input.interfaceId ?? null;
    }
  }

  archive(): void {
    this._isArchived = true;
  }
}
