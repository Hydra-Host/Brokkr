import { CreateVlanRequest, UpdateVlanRequest, Vlan } from '@repo/api-client';

interface VlanChangeSet {
  name: boolean;
  vid: boolean;
  description: boolean;
  status: boolean;
  vrfId: boolean;
}

interface VlanUniquenessProbe {
  name: string | null;
  vid: number | null;
}

export class VlanEntity {
  private _vlan: Vlan;
  private _changes: VlanChangeSet;
  private _isNew: boolean;
  private _isArchived: boolean;

  private constructor(vlan: Vlan, isNew: boolean) {
    this._vlan = vlan;
    this._isNew = isNew;
    this._isArchived = false;
    this._changes = {
      name: false,
      vid: false,
      description: false,
      status: false,
      vrfId: false,
    };
  }

  static create(input: CreateVlanRequest, organizationId: string): VlanEntity {
    return new VlanEntity(
      {
        id: '',
        name: input.name,
        vid: input.vid,
        description: input.description ?? null,
        status: input.status ?? 'ACTIVE',
        organizationId,
        vrfId: input.vrfId ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      true,
    );
  }

  static restore(vlan: Vlan): VlanEntity {
    return new VlanEntity(vlan, false);
  }

  get state(): Vlan {
    return this._vlan;
  }

  get changes(): VlanChangeSet {
    return this._changes;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get isArchived(): boolean {
    return this._isArchived;
  }

  get shouldValidateVrf(): boolean {
    return this._vlan.vrfId !== null;
  }

  get shouldCheckUniqueness(): boolean {
    return this._isNew || this._changes.name || this._changes.vid || this._changes.vrfId;
  }

  get uniquenessProbe(): VlanUniquenessProbe {
    if (this._isNew || this._changes.vrfId) {
      return {
        name: this._vlan.name,
        vid: this._vlan.vid,
      };
    }

    return {
      name: this._changes.name ? this._vlan.name : null,
      vid: this._changes.vid ? this._vlan.vid : null,
    };
  }

  applyUpdate(input: UpdateVlanRequest): void {
    if (input.name !== undefined) {
      this._vlan.name = input.name;
      this._changes.name = true;
    }
    if (input.vid !== undefined) {
      this._vlan.vid = input.vid;
      this._changes.vid = true;
    }
    if (input.description !== undefined) {
      this._vlan.description = input.description ?? null;
      this._changes.description = true;
    }
    if (input.status !== undefined) {
      this._vlan.status = input.status;
      this._changes.status = true;
    }
    if (input.vrfId !== undefined) {
      this._vlan.vrfId = input.vrfId ?? null;
      this._changes.vrfId = true;
    }
  }

  archive(): void {
    this._isArchived = true;
  }
}
