import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma';
import { TagController } from './tag.controller';
import { TagService } from './tag.service';

@Module({
  imports: [PrismaModule],
  controllers: [TagController],
  providers: [TagService],
})
export class TagModule {}
