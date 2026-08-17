import { syncLogWarning } from '../../logger/sync-log';

const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

function parseIntWithWarn(raw: string, defaultValue: number, varName: string): number {
  if (!STRICT_INT_PATTERN.test(raw)) {
    syncLogWarning(`Invalid integer for ${varName}=${JSON.stringify(raw)}, using default ${defaultValue}`);
    return defaultValue;
  }
  return Number.parseInt(raw.replace(/_/g, ''), 10);
}

export interface GrpcConfig {
  enabled: boolean;
  internalHost: string;
  internalPort: number;
  externalPort: number;
}

export function buildGrpcConfig(env: NodeJS.ProcessEnv = process.env): GrpcConfig {
  return {
    enabled: (env.GRPC_ENABLED ?? 'true').toLowerCase() === 'true',
    internalHost: env.GRPC_INTERNAL_HOST ?? '127.0.0.1',
    internalPort: parseIntWithWarn(env.GRPC_INTERNAL_PORT ?? '9082', 9082, 'GRPC_INTERNAL_PORT'),
    externalPort: parseIntWithWarn(env.GRPC_EXTERNAL_PORT ?? '443', 443, 'GRPC_EXTERNAL_PORT'),
  };
}

let _instance: GrpcConfig | null = null;

export function getGrpcConfig(): GrpcConfig {
  if (_instance === null) {
    _instance = buildGrpcConfig();
  }
  return _instance;
}

export function resetGrpcConfigForTests(): void {
  _instance = null;
}
