import { HttpException, HttpStatus } from '@nestjs/common';
import { LoggerService } from 'src/logger/logger.service';

export function extractOrganizationIdFromApiKeyMetadata(
  metadata: unknown,
  logger: Pick<LoggerService, 'warn'>,
  warnMessage = 'Failed to parse API key metadata',
): string | undefined {
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const value = (parsed as Record<string, unknown>).organizationId;
    return typeof value === 'string' ? value : undefined;
  } catch {
    logger.warn(warnMessage);
    return undefined;
  }
}

export function assertOrganizationNotDeleted(organization: { deletedAt: Date | null }): void {
  if (!organization.deletedAt) return;
  throw new HttpException('This organization has been deleted.', HttpStatus.FORBIDDEN);
}

export function assertUserNotBanned(user: { banned: boolean; banExpires: Date | null }): void {
  if (!user.banned) return;
  if (user.banExpires && user.banExpires <= new Date()) return;
  throw new HttpException('There is an issue with your account, please contact support.', HttpStatus.FORBIDDEN);
}
