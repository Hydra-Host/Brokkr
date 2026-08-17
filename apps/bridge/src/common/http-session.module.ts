import { Global, Module, type Provider } from '@nestjs/common';

import { HTTP_SESSION, HttpSessionService } from './http-session';

const httpSessionServiceProvider: Provider = {
  provide: HttpSessionService,
  useFactory: () => new HttpSessionService(),
};

@Global()
@Module({
  providers: [
    httpSessionServiceProvider,
    {
      provide: HTTP_SESSION,
      useExisting: HttpSessionService,
    },
  ],
  exports: [HttpSessionService, HTTP_SESSION],
})
export class HttpSessionModule {}
