import { Module } from '@nestjs/common';
import { AuthClientModule } from 'src/auth/auth-client.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [PrismaModule, OrganizationsModule, AuthClientModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
