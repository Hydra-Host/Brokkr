import { Module } from '@nestjs/common';

import { SealedEnvelopeService } from './sealed-envelope.service';
import { ZoneCryptoService } from './zone-crypto.service';

@Module({
  providers: [ZoneCryptoService, SealedEnvelopeService],
  exports: [ZoneCryptoService, SealedEnvelopeService],
})
export class ZoneCryptoModule {}
