import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type PublicIpInput, publicIpSchema } from './public_ip.schema';

@Injectable()
export class PublicIpHandler implements CollectorHandler<PublicIpInput> {
  readonly name = 'public_ip' as const;
  readonly schema = publicIpSchema;

  async handle(input: PublicIpInput): Promise<DeviceMutation> {
    if (!input.ipv4 && !input.ipv6) {
      return { warnings: ['public_ip: neither ipv4 nor ipv6 populated'] };
    }
    return {};
  }
}
