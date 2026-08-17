import type { Interceptor } from '@connectrpc/connect';

export function bearerTokenInterceptor(token: string): Interceptor {
  return (next) => async (req) => {
    req.header.set('authorization', `Bearer ${token}`);
    return next(req);
  };
}
