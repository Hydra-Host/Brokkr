import type { SessionUser } from 'src/common/context/context.service';

// On @SessionOnly routes the guard attaches the authenticated session user here;
// org identity context is intentionally not populated on those routes.
declare module 'express' {
  interface Request {
    user?: SessionUser;
  }
}
