import { Controller, Get, Header, Query } from '@nestjs/common';

import { getRedocHtml, getSwaggerHtml } from '../common/docs-html';
import { generateLabApiDocument } from '../common/openapi';

const SPEC_URL = '/api/swagger-json';

function firstStringOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

// the framed docs viewers fetch the spec url with no credential channel of their own, so the
// already-accepted query token rides along; a loopback viewer carries none and gets the bare url.
function specUrlOf(rawToken: unknown): string {
  const token = firstStringOf(rawToken);
  return token === undefined ? SPEC_URL : `${SPEC_URL}?token=${encodeURIComponent(token)}`;
}

// a Nest controller rather than httpAdapter.get() so the global LabAuthGuard sees these routes —
// registering on the raw adapter bypasses the guard pipeline and exposes the whole spec off-loopback.
@Controller('api')
export class ApiDocsController {
  private cachedSpec: ReturnType<typeof generateLabApiDocument> | undefined;

  @Get('swagger-json')
  spec() {
    this.cachedSpec ??= generateLabApiDocument();
    return this.cachedSpec;
  }

  @Get('redoc')
  @Header('content-type', 'text/html; charset=utf-8')
  redoc(@Query('theme') theme: unknown, @Query('token') token: unknown): string {
    return getRedocHtml(specUrlOf(token), firstStringOf(theme));
  }

  @Get('swagger')
  @Header('content-type', 'text/html; charset=utf-8')
  swagger(@Query('theme') theme: unknown, @Query('token') token: unknown): string {
    return getSwaggerHtml(specUrlOf(token), firstStringOf(theme));
  }
}
