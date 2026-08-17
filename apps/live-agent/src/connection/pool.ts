import { readFileSync } from 'node:fs';

import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport, type GrpcTransportOptions } from '@connectrpc/connect-node';

import type { AgentConfig } from '../config';
import { getErrorMessage } from '../errors';
import { AgentService } from '../gen/brokkr/agent/v1/agent_pb';
import { makeLogger } from '../logger';
import { bearerTokenInterceptor } from './auth-interceptor';
const logger = makeLogger('pool');

export type AgentServiceClient = Client<typeof AgentService>;

export interface TransportPool {
  getClient(bridgeAddress: string): AgentServiceClient;
  removeBridge(bridgeAddress: string): void;
  listAddresses(): string[];
}

function tryReadPem(path: string, role: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    logger.warn('gRPC TLS material not readable, proceeding without it', {
      role,
      path,
      err: getErrorMessage(error),
    });
    return undefined;
  }
}

function readTlsMaterial(config: AgentConfig): {
  ca: Buffer | undefined;
  rejectUnauthorized: boolean;
} {
  const caPath = config.tls.ca_bundle_path;
  return {
    ca: caPath !== undefined ? tryReadPem(caPath, 'ca') : undefined,
    rejectUnauthorized: config.tls.reject_unauthorized,
  };
}

export type TransportFactory = (
  baseUrl: string,
  tlsMaterial: ReturnType<typeof readTlsMaterial>,
) => GrpcTransportOptions;

function defaultTransportFactory(
  baseUrl: string,
  tlsMaterial: ReturnType<typeof readTlsMaterial>,
): GrpcTransportOptions {
  return {
    baseUrl,
    nodeOptions: {
      ca: tlsMaterial.ca,
      rejectUnauthorized: tlsMaterial.rejectUnauthorized,
    },
  };
}

interface PoolEntry {
  client: AgentServiceClient;
}

export function createTransportPool(
  config: AgentConfig,
  transportFactory: TransportFactory = defaultTransportFactory,
): TransportPool {
  const entries = new Map<string, PoolEntry>();
  const tlsMaterial = readTlsMaterial(config);

  return {
    getClient(bridgeAddress: string): AgentServiceClient {
      let entry = entries.get(bridgeAddress);
      if (!entry) {
        logger.debug('creating gRPC transport', { address: bridgeAddress });
        const transportOpts = transportFactory(bridgeAddress, tlsMaterial);
        const transport = createGrpcTransport({
          ...transportOpts,
          interceptors: [bearerTokenInterceptor(config.auth.token), ...(transportOpts.interceptors ?? [])],
        });
        const client = createClient(AgentService, transport);
        entry = { client };
        entries.set(bridgeAddress, entry);
      }
      return entry.client;
    },

    removeBridge(bridgeAddress: string): void {
      if (entries.delete(bridgeAddress)) {
        logger.debug('removed gRPC transport from pool', { address: bridgeAddress });
      }
    },

    listAddresses(): string[] {
      return [...entries.keys()];
    },
  };
}
