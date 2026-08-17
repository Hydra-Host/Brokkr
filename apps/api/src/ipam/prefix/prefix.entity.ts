import { CreatePrefixRequest, IpamPrefix, UpdatePrefixRequest } from '@repo/api-client';

interface PrefixChangeSet {
  status: boolean;
  isPool: boolean;
  role: boolean;
  zoneId: boolean;
  vrfId: boolean;
  parentId: boolean;
  vlanId: boolean;
  gatewayIpId: boolean;
  vrrpVipId: boolean;
  prefixRoleId: boolean;
  enableVlanTag: boolean;
  bondParameters: boolean;
}

export class PrefixEntity {
  private _prefix: IpamPrefix;
  private _changes: PrefixChangeSet;
  private _isNew: boolean;
  private _isArchived: boolean;

  private constructor(prefix: IpamPrefix, isNew: boolean) {
    this._prefix = prefix;
    this._isNew = isNew;
    this._isArchived = false;
    this._changes = {
      status: false,
      isPool: false,
      role: false,
      zoneId: false,
      vrfId: false,
      parentId: false,
      vlanId: false,
      gatewayIpId: false,
      vrrpVipId: false,
      prefixRoleId: false,
      enableVlanTag: false,
      bondParameters: false,
    };
  }

  static create(input: CreatePrefixRequest, organizationId: string, normalizedPrefix: string): PrefixEntity {
    return new PrefixEntity(
      {
        id: '',
        prefix: normalizedPrefix,
        status: input.status ?? 'ACTIVE',
        isPool: input.isPool ?? false,
        role: input.role ?? null,
        zoneId: input.zoneId ?? null,
        organizationId,
        vrfId: input.vrfId ?? null,
        parentId: input.parentId ?? null,
        vlanId: null,
        gatewayIpId: null,
        vrrpVipId: null,
        prefixRoleId: input.prefixRoleId ?? null,
        enableVlanTag: input.enableVlanTag ?? false,
        bondParameters: input.bondParameters ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      true,
    );
  }

  static restore(prefix: IpamPrefix): PrefixEntity {
    return new PrefixEntity({ ...prefix }, false);
  }

  get state(): IpamPrefix {
    return this._prefix;
  }

  get changes(): PrefixChangeSet {
    return this._changes;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get isArchived(): boolean {
    return this._isArchived;
  }

  get shouldValidateVrf(): boolean {
    return (this._isNew || this._changes.vrfId) && this._prefix.vrfId !== null;
  }

  get shouldValidateZone(): boolean {
    return (this._isNew || this._changes.zoneId) && this._prefix.zoneId !== null;
  }

  get shouldValidateParent(): boolean {
    return this._isNew || this._changes.vrfId || this._changes.parentId;
  }

  get shouldValidateVlanCompatibility(): boolean {
    return this._isNew || this._changes.vrfId || this._changes.vlanId;
  }

  get shouldValidateGateway(): boolean {
    return this._isNew || this._changes.vrfId || this._changes.gatewayIpId;
  }

  get shouldValidatePrefixRole(): boolean {
    return (this._isNew || this._changes.prefixRoleId) && this._prefix.prefixRoleId !== null;
  }

  applyUpdate(input: UpdatePrefixRequest): void {
    if (input.status !== undefined) {
      this._prefix.status = input.status;
      this._changes.status = true;
    }
    if (input.isPool !== undefined) {
      this._prefix.isPool = input.isPool;
      this._changes.isPool = true;
    }
    if (input.role !== undefined) {
      this._prefix.role = input.role ?? null;
      this._changes.role = true;
    }
    if (input.zoneId !== undefined) {
      this._prefix.zoneId = input.zoneId ?? null;
      this._changes.zoneId = true;
    }
    // Value-diffed, not presence-tracked: an edit form force-writes the unchanged vrfId every PATCH,
    // and re-validating would fail unrelated edits with "VRF not found" when the prefix's VRF is archived.
    if (input.vrfId !== undefined && (input.vrfId ?? null) !== this._prefix.vrfId) {
      this._prefix.vrfId = input.vrfId ?? null;
      this._changes.vrfId = true;
    }
    if (input.parentId !== undefined) {
      this._prefix.parentId = input.parentId ?? null;
      this._changes.parentId = true;
    }
    if (input.vlanId !== undefined) {
      this._prefix.vlanId = input.vlanId ?? null;
      this._changes.vlanId = true;
    }
    if (input.gatewayIpId !== undefined) {
      this._prefix.gatewayIpId = input.gatewayIpId ?? null;
      this._changes.gatewayIpId = true;
    }
    // Value-diffed like vrfId: the edit form force-writes the unchanged prefixRoleId every PATCH;
    // presence-tracking would re-run ensurePrefixRole on unrelated edits (a needless DB query).
    if (input.prefixRoleId !== undefined && (input.prefixRoleId ?? null) !== this._prefix.prefixRoleId) {
      this._prefix.prefixRoleId = input.prefixRoleId ?? null;
      this._changes.prefixRoleId = true;
    }
    if (input.enableVlanTag !== undefined) {
      this._prefix.enableVlanTag = input.enableVlanTag;
      this._changes.enableVlanTag = true;
    }
    if (input.bondParameters !== undefined) {
      this._prefix.bondParameters = input.bondParameters ?? null;
      this._changes.bondParameters = true;
    }
  }

  setGateway(gatewayIpId: string): void {
    this._prefix.gatewayIpId = gatewayIpId;
    this._changes.gatewayIpId = true;
  }

  clearGateway(): void {
    this._prefix.gatewayIpId = null;
    this._changes.gatewayIpId = true;
  }

  setVrrpVip(vrrpVipId: string): void {
    this._prefix.vrrpVipId = vrrpVipId;
    this._changes.vrrpVipId = true;
  }

  clearVrrpVip(): void {
    this._prefix.vrrpVipId = null;
    this._changes.vrrpVipId = true;
  }

  archive(): void {
    this._isArchived = true;
  }
}
