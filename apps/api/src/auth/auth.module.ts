import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthClientModule } from './auth-client.module';
import { AuthController } from './auth.controller';
import { UnifiedIdentityGuard } from './unified-identity.guard';

@Module({
  controllers: [AuthController],
  imports: [AuthClientModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: UnifiedIdentityGuard,
    },
  ],
  exports: [AuthClientModule],
})
export class AuthModule {}
