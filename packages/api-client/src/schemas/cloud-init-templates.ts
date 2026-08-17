import { z } from 'zod';

export const CloudInitTemplateSchema = z.object({
  id: z.string().uuid().describe('Unique identifier for the cloud-init template'),
  name: z.string().nullable().describe('User-provided name for the template'),
  content: z.string().describe('Cloud-init configuration as a YAML string'),
  organizationId: z.string().uuid().describe('Organization that owns this template'),
  createdById: z.string().uuid().describe('User who first saved this template'),
  createdAt: z.coerce.date().describe('When the template was first saved'),
  updatedAt: z.coerce.date().describe('When the template was last modified'),
});

export type CloudInitTemplate = z.infer<typeof CloudInitTemplateSchema>;

export const UpdateCloudInitTemplateSchema = z.object({
  name: z.string().min(1).optional().describe('New name for the template'),
  content: z.string().min(1).optional().describe('Updated cloud-init YAML content'),
});

export type UpdateCloudInitTemplate = z.infer<typeof UpdateCloudInitTemplateSchema>;
