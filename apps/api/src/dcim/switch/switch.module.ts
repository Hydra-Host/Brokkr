import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { SwitchController } from './switch.controller';
import { SwitchService } from './switch.service';

@Module({
  imports: [PrismaModule],
  controllers: [SwitchController],
  providers: [SwitchService],
  exports: [SwitchService],
})
export class SwitchModule {}
