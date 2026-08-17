import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { SshkeysController } from './sshkeys.controller';
import { SshKeysService } from './sshkeys.service';

@Module({
  imports: [PrismaModule],
  providers: [SshKeysService],
  controllers: [SshkeysController],
  exports: [SshKeysService],
})
export class SshKeysModule {}
