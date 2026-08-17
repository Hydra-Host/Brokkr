import { z } from 'zod';

export const SshKeyTypeSchema = z
  .enum([
    'ssh-dss',
    'ssh-rsa',
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'sk-ecdsa-sha2-nistp256@openssh.com',
    'sk-ssh-ed25519@openssh.com',
  ])
  .describe('SSH key algorithm type (OpenSSH public-key prefix)');

export type SshKeyType = z.infer<typeof SshKeyTypeSchema>;

export const SshKeySchema = z.object({
  id: z.string().describe('Unique identifier for the SSH key'),
  dateCreated: z.coerce.date().describe('When the SSH key was created'),
  dateDeleted: z.coerce.date().nullable().describe('When the SSH key was soft-deleted, or null if active'),
  name: z.string().describe('User-assigned name for the SSH key'),
  fingerprint: z.string().describe('Cryptographic fingerprint of the public key'),
  key: z.string().describe('Full public key string'),
  userId: z.string().describe('ID of the user who owns this key'),
});

export type SshKey = z.infer<typeof SshKeySchema>;

export const SshKeyWithUserSchema = SshKeySchema.extend({
  user: z
    .object({
      firstName: z.string().describe('First name of the key owner'),
      lastName: z.string().describe('Last name of the key owner'),
    })
    .describe('User details for the SSH key owner'),
});

export type SshKeyWithUser = z.infer<typeof SshKeyWithUserSchema>;

export const CreateSshKeyRequestSchema = z.object({
  name: z.string().describe('Display name for the new SSH key'),
  key: z.string().describe('Public key content in OpenSSH format'),
});

export type CreateSshKeyRequest = z.infer<typeof CreateSshKeyRequestSchema>;
