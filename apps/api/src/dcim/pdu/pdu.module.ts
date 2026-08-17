import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { PduController } from './pdu.controller';
import { PduService } from './pdu.service';

@Module({
  imports: [PrismaModule],
  controllers: [PduController],
  providers: [PduService],
  exports: [PduService],
})
export class PduModule {}
