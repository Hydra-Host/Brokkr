import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';

@Injectable()
export class DiscoveryS3UploadService {
  private client: S3Client | null = null;
  private bucket: string;

  constructor(
    private readonly configService: ConfigService,
    @Logger(DiscoveryS3UploadService.name) private readonly logger: LoggerService,
  ) {
    this.bucket = this.configService.get('S3_BUCKET') || 'brokkr-device-data-dev';
  }

  static runTimestamp(date: Date = new Date()): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    const y = date.getUTCFullYear();
    const m = pad(date.getUTCMonth() + 1);
    const d = pad(date.getUTCDate());
    const h = pad(date.getUTCHours());
    const mi = pad(date.getUTCMinutes());
    return `${y}${m}${d}-${h}${mi}`;
  }

  static prefixFor(deviceId: string | number, timestamp: string): string {
    return `${deviceId}/${timestamp}/`;
  }

  static collectorKey(deviceId: string | number, timestamp: string, collectorName: string): string {
    return `${DiscoveryS3UploadService.prefixFor(deviceId, timestamp)}${collectorName}.json`;
  }

  async uploadCollectorPayload(
    deviceId: string | number,
    timestamp: string,
    collectorName: string,
    raw: unknown,
  ): Promise<boolean> {
    const client = this.getClient();
    if (!client) return false;

    const key = DiscoveryS3UploadService.collectorKey(deviceId, timestamp, collectorName);

    try {
      const body = typeof raw === 'string' ? raw : JSON.stringify(raw);
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
        }),
      );
      this.logger.debug?.(`Uploaded collector ${collectorName} to S3: ${key} (${body.length} B)`);
      return true;
    } catch (error) {
      this.logger.error(`S3 upload failed for ${key}: ${getErrorMessage(error)}`);
      return false;
    }
  }

  private getClient(): S3Client | null {
    if (this.client) return this.client;

    const endpoint = this.configService.get('S3_ENDPOINT_URL');
    const accessKeyId = this.configService.get('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get('S3_SECRET_ACCESS_KEY');

    if (!endpoint || !accessKeyId || !secretAccessKey) {
      this.logger.warn('S3 credentials not configured, upload disabled');
      return null;
    }

    this.client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
    });

    return this.client;
  }
}
