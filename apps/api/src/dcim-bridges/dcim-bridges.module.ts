import { Module } from '@nestjs/common';
import { ContextModule } from 'src/common/context/context.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { BridgePresenceReconcilerService } from './bridge-presence-reconciler.service';
import { BridgesController } from './bridges.controller';
import { BridgesService } from './bridges.service';

@Module({
  imports: [PrismaModule, ContextModule],
  controllers: [BridgesController],
  providers: [BridgesService, BridgePresenceReconcilerService],
  exports: [BridgesService],
})
export class DcimBridgesModule {}
