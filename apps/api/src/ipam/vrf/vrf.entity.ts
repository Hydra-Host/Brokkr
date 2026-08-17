import { CreateVrfRequest, UpdateVrfRequest, Vrf } from '@repo/api-client';

interface VrfChangeSet {
  name: boolean;
  rd: boolean;
  description: boolean;
}

interface VrfUniquenessProbe {
  name: string | null;
  rd: string | null;
}

export class VrfEntity {
  private _vrf: Vrf;
  private _changes: VrfChangeSet;
  private _isNew: boolean;
  private _isArchived: boolean;

  private constructor(vrf: Vrf, isNew: boolean) {
    this._vrf = vrf;
    this._isNew = isNew;
    this._isArchived = false;
    this._changes = {
      name: false,
      rd: false,
      description: false,
    };
  }

  static create(input: CreateVrfRequest, organizationId: string): VrfEntity {
    return new VrfEntity(
      {
        id: '',
        name: input.name,
        rd: input.rd ?? null,
        description: input.description ?? null,
        organizationId,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      true,
    );
  }

  static restore(vrf: Vrf): VrfEntity {
    return new VrfEntity(vrf, false);
  }

  get state(): Vrf {
    return this._vrf;
  }

  get changes(): VrfChangeSet {
    return this._changes;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get isArchived(): boolean {
    return this._isArchived;
  }

  get shouldValidateRd(): boolean {
    return this._isNew || this._changes.rd;
  }

  get shouldCheckUniqueness(): boolean {
    return this._isNew || this._changes.name || this._changes.rd;
  }

  get uniquenessProbe(): VrfUniquenessProbe {
    if (this._isNew) {
      return {
        name: this._vrf.name,
        rd: this._vrf.rd,
      };
    }

    return {
      name: this._changes.name ? this._vrf.name : null,
      rd: this._changes.rd ? this._vrf.rd : null,
    };
  }

  applyUpdate(input: UpdateVrfRequest): void {
    if (input.name !== undefined) {
      this._vrf.name = input.name;
      this._changes.name = true;
    }
    if (input.rd !== undefined) {
      this._vrf.rd = input.rd ?? null;
      this._changes.rd = true;
    }
    if (input.description !== undefined) {
      this._vrf.description = input.description ?? null;
      this._changes.description = true;
    }
  }

  archive(): void {
    this._isArchived = true;
  }
}
