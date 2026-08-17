import type { DcimRackRole } from '@repo/api-client';
import type { RackRoleRecord } from './rack-role.record';

export class RackRolePresenter {
  static toResponse(record: RackRoleRecord): DcimRackRole {
    const data = record.data;
    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      color: data.color,
      description: data.description,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}
