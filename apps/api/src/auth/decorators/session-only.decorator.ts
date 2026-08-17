import { SetMetadata } from '@nestjs/common';

export const IS_SESSION_ONLY_KEY = 'isSessionOnly';
export const SessionOnly = () => SetMetadata(IS_SESSION_ONLY_KEY, true);
