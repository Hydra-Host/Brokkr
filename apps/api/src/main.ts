// Must be first: @hydrahost/plugins-config gates plugins at module-load time, so env vars must exist before it loads.
import 'dotenv/config';

// Must init after dotenv (OTEL_* env) and before plugins-config/@nestjs/core — require-patch instrumentation only covers modules loaded after it; guarded by telemetry-import-order.spec.ts.
import './telemetry/init';

import { formatCspSources, mergePluginCsp } from '@hydrahost/plugin-sdk';
import pluginsConfig from '@hydrahost/plugins-config';
// Root import on purpose: apps/api's classic `node` module resolution ignores the package `exports` submap, so the `./server` subpath won't resolve.
import {
  isWebvmTerminalPath,
  WEBVM_TERMINAL_COEP_HEADERS,
  WEBVM_TERMINAL_HTML,
} from '@hydrahost/plugin-webvm-terminal';
import { NestFactory } from '@nestjs/core';

import { Transport } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { blockUnsupportedMethods } from './common/block-unsupported-methods.middleware';
import { bootstrapInstanceOperator } from './common/bootstrap/operator-bootstrap';
import { seedBypassUser } from './common/bootstrap/seed-bypass-user';
import { seedRbac } from './common/bootstrap/seed-rbac';
import { registerApiDocs } from './common/docs-setup';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { PrismaKnownRequestExceptionFilter } from './common/errors/prisma-known-request-exception.filter';
import { RecordNotFoundExceptionFilter } from './common/errors/record-not-found-exception.filter';
import { TenantContextRequiredExceptionFilter } from './common/errors/tenant-context-required-exception.filter';
import { assertAuthBypassEnvSafe, describeAuthBypass, resolveAuthBypassPolicy } from './common/local-simulation';
import { createRedisTransportConnectionConfig } from './common/redis/redis.config';
import { resolveTrustProxyConfig } from './common/trust-proxy.config';
import { getLogLevels } from './logger/log-levels';

async function bootstrap() {
  try {
    assertAuthBypassEnvSafe();
    describeAuthBypass(resolveAuthBypassPolicy()).forEach((line) => console.warn(line));
    const app = await NestFactory.create<NestExpressApplication>(await AppModule.withPluginBackends(), {
      logger: getLogLevels(),
      bodyParser: false,
    });

    // Off unless TRUST_PROXY is set — trusting x-forwarded-for by default would let a client spoof `req.ip`, which feeds the rate limiter.
    app.set('trust proxy', resolveTrustProxyConfig().setting);

    // Helmet must be first so even 405/413 error responses carry security headers; CSP is handled separately below (Redoc/Swagger need a relaxed policy).
    app.use(
      helmet({
        contentSecurityPolicy: false,
        xFrameOptions: { action: 'deny' },
        strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      }),
    );

    app.use((_req, res, next) => {
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      next();
    });

    // COEP only on the /webvm-terminal popup document (CheerpX needs cross-origin isolation; app-wide COEP would break third-party iframes like Stripe) — Helmet above already sets the COOP half on every response.
    // Global middleware on purpose: a path-mounted app.use('/webvm-terminal', ...) strips and re-prepends the prefix around the rewrite, mangling it into /webvm-terminal/webvm-terminal.html.
    const webvmTerminalEnabled = pluginsConfig.some((entry) => entry.enabled && entry.plugin.id === 'webvm-terminal');
    app.use((req, res, next) => {
      const pathname = req.path;
      if (webvmTerminalEnabled && isWebvmTerminalPath(pathname)) {
        for (const [name, value] of Object.entries(WEBVM_TERMINAL_COEP_HEADERS)) {
          res.setHeader(name, value);
        }
        if (pathname !== WEBVM_TERMINAL_HTML) {
          req.url = WEBVM_TERMINAL_HTML + req.url.slice(pathname.length);
        }
      }
      next();
    });

    // Block TRACE/TRACK before body parsing so no body memory is allocated.
    app.use(blockUnsupportedMethods);

    // Must be registered before the global 1MB parser; PhoneHomeGuard-gated, 50MB covers hardware diagnostic dumps.
    app.use('/api/v1/bmc/diagnostics', express.json({ limit: '50mb' }));

    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ limit: '1mb', extended: true }));

    app.useGlobalFilters(
      new TenantContextRequiredExceptionFilter(),
      new RecordNotFoundExceptionFilter(),
      new PrismaKnownRequestExceptionFilter(),
      new HttpExceptionFilter(),
    );

    const pluginCsp = mergePluginCsp(pluginsConfig.filter((entry) => entry.enabled).map((entry) => entry.plugin.csp));

    app.use((req: { path: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
      if (req.path.startsWith('/api/redoc') || req.path.startsWith('/api/swagger')) {
        return next();
      }
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          `script-src 'self'${formatCspSources(pluginCsp.scriptSrc)}`,
          `worker-src 'self'${formatCspSources(pluginCsp.workerSrc)}`,
          `style-src 'self' 'unsafe-inline'${formatCspSources(pluginCsp.styleSrc)}`,
          `img-src 'self' data: blob:${formatCspSources(pluginCsp.imgSrc)}`,
          `font-src 'self' data:${formatCspSources(pluginCsp.fontSrc)}`,
          `connect-src 'self'${formatCspSources(pluginCsp.connectSrc)}`,
          ...(pluginCsp.frameSrc.length > 0 ? [`frame-src${formatCspSources(pluginCsp.frameSrc)}`] : []),
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          'upgrade-insecure-requests',
        ].join('; '),
      );
      next();
    });

    await registerApiDocs(app);

    const redisTransportConfig = createRedisTransportConnectionConfig({
      redisUrl: process.env.REDIS_URL,
      redisCaCert: process.env.REDIS_CA_CERT,
      nodeTlsRejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
    });
    app.connectMicroservice({
      transport: Transport.REDIS,
      options: {
        host: redisTransportConfig.host,
        port: redisTransportConfig.port,
        ...(redisTransportConfig.username ? { username: redisTransportConfig.username } : {}),
        ...(redisTransportConfig.password ? { password: redisTransportConfig.password } : {}),
        ...(redisTransportConfig.tls ? { tls: redisTransportConfig.tls } : {}),
        retryAttempts: 5,
        retryDelay: 3000,
      },
    });

    await app.startAllMicroservices();

    const baseUrl = process.env.BASE_URL?.trim();
    if (process.env.NODE_ENV === 'production' && !baseUrl) {
      throw new Error('BASE_URL must be set in production (it is the CORS origin).');
    }

    app.enableCors({
      origin: baseUrl || 'http://localhost:5173',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
      // Without this the SPA cannot read the event-log export's truncation signal cross-origin.
      exposedHeaders: ['Content-Disposition', 'X-Event-Log-Truncated'],
    });
    app.enableShutdownHooks();

    await seedRbac(app);
    await bootstrapInstanceOperator(app);
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT', rehashCredential: true });

    const port = Number(process.env.HUB_PORT) || 3000;
    await app.listen(port);
    console.log(`Server is running on port ${port}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

void bootstrap();
