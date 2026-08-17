import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { RouterController } from './router.controller';
import { RouterService } from './router.service';

@Module({
  imports: [PrismaModule],
  controllers: [RouterController],
  providers: [RouterService],
  exports: [RouterService],
})
export class RouterModule {}
