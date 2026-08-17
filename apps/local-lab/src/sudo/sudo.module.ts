import { Module } from '@nestjs/common';

import { SudoController } from './sudo.controller';
import { SudoService } from './sudo.service';

@Module({
  controllers: [SudoController],
  providers: [SudoService],
  exports: [SudoService],
})
export class SudoModule {}
