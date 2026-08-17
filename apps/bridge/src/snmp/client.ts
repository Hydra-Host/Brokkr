import * as snmp from 'net-snmp';

import { logDebug } from '../logger/logger.service.js';
import { getSnmpMonitoringConfig, SnmpMonitoringConfig } from '../monitoring/monitoring.config.js';
import { buildAuthData, SnmpAuthError, SnmpParams } from './auth.js';
import { getSnmpEngine } from './engine.js';
import { defaultSnmpLogger, SnmpLogger } from './snmp-logger.js';
import { decodeVarbind, Varbind } from './varbind.js';

export class SnmpError extends Error {}

export interface WalkResult {
  readonly varbinds: Varbind[];
  readonly truncated: boolean;
  readonly truncationReason: string | null;
  readonly hadError: boolean;
}

function isEndOfMib(varbind: snmp.Varbind): boolean {
  return varbind.type === snmp.ObjectType.EndOfMibView;
}

export class SnmpClient {
  readonly jobId: string;
  private readonly config: SnmpMonitoringConfig;
  private readonly logger: SnmpLogger;

  constructor(jobId = '', logger: SnmpLogger = defaultSnmpLogger()) {
    this.jobId = jobId;
    this.config = getSnmpMonitoringConfig();
    this.logger = logger;
  }

  private buildSession(target: string, port: number, snmpParams: SnmpParams): snmp.Session {
    let authData;
    try {
      authData = buildAuthData(snmpParams);
    } catch (exc) {
      if (exc instanceof SnmpAuthError) {
        throw new SnmpError(exc.message);
      }
      throw exc;
    }
    return getSnmpEngine().createSession(target, port, authData, {
      timeoutMs: this.config.commandTimeoutSeconds * 1000,
      retries: 1,
    });
  }

  async get(target: string, port: number, oids: string[], snmpParams: SnmpParams): Promise<Varbind[]> {
    const session = this.buildSession(target, port, snmpParams);

    return getSnmpEngine().acquire(
      () =>
        new Promise<Varbind[]>((resolve, reject) => {
          session.get(oids, (error, varbinds) => {
            try {
              if (error) {
                reject(new SnmpError(error.message));
                return;
              }
              resolve((varbinds ?? []).map((vb) => decodeVarbind(vb)));
            } finally {
              try {
                session.close();
              } catch (closeError) {
                const msg = closeError instanceof Error ? closeError.message : String(closeError);
                void logDebug(`SNMP session close failed: ${msg}`, { jobId: this.jobId });
              }
            }
          });
        }),
    );
  }

  async walk(
    target: string,
    port: number,
    oid: string,
    snmpParams: SnmpParams,
    maxResults?: number,
  ): Promise<WalkResult> {
    const session = this.buildSession(target, port, snmpParams);

    const cap = Math.min(maxResults ?? this.config.maxWalkResults, this.config.maxWalkResults);
    const maxRepetitions = this.config.bulkWalkMaxRepetitions;
    const jobId = this.jobId;

    return getSnmpEngine().acquire(
      () =>
        new Promise<WalkResult>((resolve, reject) => {
          const data: Varbind[] = [];
          let truncated = false;
          let truncationReason: string | null = null;
          let hadError = false;
          let settled = false;
          let pendingLog: Promise<void> = Promise.resolve();

          const closeSession = () => {
            try {
              session.close();
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              void logDebug(`SNMP session close failed: ${msg}`, { jobId });
            }
          };

          const logger = this.logger;
          const queueLog = (message: string) => {
            pendingLog = pendingLog.then(() => logger.warn(message, { jobId }));
          };

          const feedCb = (varbinds: snmp.Varbind[]): boolean | undefined => {
            for (const varbind of varbinds) {
              if (isEndOfMib(varbind)) {
                return true;
              }
              if (snmp.isVarbindError(varbind)) {
                const errorMsg = snmp.varbindError(varbind);
                if (data.length > 0) {
                  truncated = true;
                  hadError = true;
                  truncationReason = `Walk error-status after ${data.length} results: ${errorMsg}`;
                  queueLog(`SNMP WALK partial: ${truncationReason}`);
                  return true;
                }
                settled = true;
                closeSession();
                reject(new SnmpError(errorMsg));
                return true;
              }

              data.push(decodeVarbind(varbind));
              if (data.length >= cap) {
                truncated = true;
                truncationReason = `Reached max_results limit (${cap})`;
                queueLog(`SNMP WALK hit max_results limit (${cap})`);
                return true;
              }
            }
            return undefined;
          };

          const doneCb = (error: Error | null): void => {
            if (settled) {
              closeSession();
              return;
            }
            settled = true;
            if (error) {
              const errorMsg = error.message;
              if (data.length === 0) {
                closeSession();
                reject(new SnmpError(errorMsg));
                return;
              }
              truncated = true;
              hadError = true;
              truncationReason = `Walk error after ${data.length} results: ${errorMsg}`;
              queueLog(`SNMP WALK partial: ${truncationReason}`);
            }
            closeSession();
            pendingLog.then(() => resolve({ varbinds: data, truncated, truncationReason, hadError }), reject);
          };

          session.subtree(oid, maxRepetitions, feedCb, doneCb);
        }),
    );
  }
}
