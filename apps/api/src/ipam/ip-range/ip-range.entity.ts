import { CreateIpRangeRequest, IpRange, UpdateIpRangeRequest } from '@repo/api-client';

interface IpRangeChangeSet {
  start: boolean;
  end: boolean;
  status: boolean;
  purpose: boolean;
  vrfId: boolean;
}

export class IpRangeEntity {
  private _ipRange: IpRange;
  private _changes: IpRangeChangeSet;
  private _isNew: boolean;
  private _isArchived: boolean;

  private constructor(ipRange: IpRange, isNew: boolean) {
    this._ipRange = ipRange;
    this._isNew = isNew;
    this._isArchived = false;
    this._changes = {
      start: false,
      end: false,
      status: false,
      purpose: false,
      vrfId: false,
    };
  }

  static create(input: CreateIpRangeRequest, organizationId: string, scopedVrfId: string | null): IpRangeEntity {
    return new IpRangeEntity(
      {
        id: '',
        start: input.start,
        end: input.end,
        status: input.status ?? 'ACTIVE',
        purpose: input.purpose ?? null,
        organizationId,
        prefixId: input.prefixId,
        vrfId: scopedVrfId,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        deletedAt: null,
      },
      true,
    );
  }

  static restore(ipRange: IpRange): IpRangeEntity {
    return new IpRangeEntity(ipRange, false);
  }

  get state(): IpRange {
    return this._ipRange;
  }

  get changes(): IpRangeChangeSet {
    return this._changes;
  }

  get isNew(): boolean {
    return this._isNew;
  }

  get isArchived(): boolean {
    return this._isArchived;
  }

  get shouldNormalizeBounds(): boolean {
    return this._isNew || this._changes.start || this._changes.end;
  }

  get shouldValidatePlacement(): boolean {
    return this._isNew || this._changes.start || this._changes.end || this._changes.vrfId;
  }

  applyNormalizedBounds(start: string, end: string): void {
    this._ipRange.start = start;
    this._ipRange.end = end;
  }

  applyUpdate(input: UpdateIpRangeRequest): void {
    if (input.start !== undefined) {
      this._ipRange.start = input.start;
      this._changes.start = true;
    }
    if (input.end !== undefined) {
      this._ipRange.end = input.end;
      this._changes.end = true;
    }
    if (input.status !== undefined) {
      this._ipRange.status = input.status;
      this._changes.status = true;
    }
    if (input.purpose !== undefined) {
      this._ipRange.purpose = input.purpose ?? null;
      this._changes.purpose = true;
    }
    if (input.vrfId !== undefined) {
      this._ipRange.vrfId = input.vrfId ?? null;
      this._changes.vrfId = true;
    }
  }

  archive(): void {
    this._isArchived = true;
  }
}
