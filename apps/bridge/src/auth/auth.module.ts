import { DynamicModule, Module, Provider, Type } from '@nestjs/common';

import { ContextLogger } from '../logger/logger.service';

import { type AgentAuthConfig } from './agent-auth.config';
import { type AgentTokenCache, type AgentTokenServiceOptions, AgentTokenService } from './agent-token.service';
import { AuthContextService } from './auth-context.service';

export interface AuthModuleOptions {
  cacheToken: Type<AgentTokenCache> | symbol | string;
  options?: AgentTokenServiceOptions;
  config?: AgentAuthConfig;
}

@Module({
  providers: [AuthContextService],
  exports: [AuthContextService],
})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const serviceProvider: Provider = {
      provide: AgentTokenService,
      useFactory: (cache: AgentTokenCache, logger: ContextLogger) =>
        new AgentTokenService(cache, logger, options.options, options.config),
      inject: [options.cacheToken, ContextLogger],
    };
    return {
      module: AuthModule,
      providers: [serviceProvider, AuthContextService],
      exports: [AgentTokenService, AuthContextService],
    };
  }
}
