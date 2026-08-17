import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KEY_SIZE, derivePublicKey } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';

/** Unset key → dormant (enrollment 503s); present-but-malformed → throws at boot — loud failure, never silent dormancy. */
@Injectable()
export class ZoneCryptoConfig implements OnModuleInit {
  private _privateKey: Buffer | null = null;
  private _publicKey: Buffer | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Logger(ZoneCryptoConfig.name) private readonly logger: LoggerService,
  ) {}

  onModuleInit(): void {
    const raw = this.configService.get<string>('BROKKR_HUB_PRIVATE_KEY')?.trim() ?? '';
    if (raw === '') {
      this.logger.warn(
        'BROKKR_HUB_PRIVATE_KEY not set; zone enrollment endpoint is dormant. ' +
          'Set this to a base64-encoded 32-byte X25519 private key to enable bridges to enroll.',
      );
      return;
    }

    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== KEY_SIZE) {
      throw new Error(
        `BROKKR_HUB_PRIVATE_KEY must decode to ${KEY_SIZE} bytes from base64, got ${decoded.length}. ` +
          'Verify the env var holds a base64-encoded 32-byte X25519 private key.',
      );
    }

    this._privateKey = decoded;
    this._publicKey = derivePublicKey(decoded);
    this.logger.log(`Hub crypto loaded; hub_pub=${this._publicKey.toString('hex')}`);
  }

  get isAvailable(): boolean {
    return this._privateKey !== null && this._publicKey !== null;
  }

  /** Never persisted; never logged. */
  get privateKey(): Buffer | null {
    return this._privateKey;
  }

  get publicKey(): Buffer | null {
    return this._publicKey;
  }

  toJSON(): Record<string, unknown> {
    return {
      isAvailable: this.isAvailable,
      publicKey: this._publicKey?.toString('hex') ?? null,
      privateKey: '[REDACTED]',
    };
  }

  toString(): string {
    return `ZoneCryptoConfig { isAvailable=${this.isAvailable}, privateKey=[REDACTED] }`;
  }
}
