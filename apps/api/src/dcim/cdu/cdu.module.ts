import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { CduController } from './cdu.controller';
import { CduService } from './cdu.service';

@Module({
  imports: [PrismaModule],
  controllers: [CduController],
  providers: [CduService],
  exports: [CduService],
})
export class CduModule {}
