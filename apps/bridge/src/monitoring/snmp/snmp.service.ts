import { getErrorMessage } from '../../common/error-utils';
import { logDebug, logError } from '../../logger/logger.service';
import { SnmpClient, type SnmpParams, type Varbind } from '../../snmp';
import { getSnmpMonitoringConfig, type SnmpMonitoringConfig } from '../monitoring.config';

import { SnmpValidationError, validateIpAddress, validateOid, validatePort, validateSnmpParams } from './snmp-validate';

export { SnmpValidationError, validateSnmpParams } from './snmp-validate';

export class SnmpMonitoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnmpMonitoringError';
  }
}

export interface SnmpResultSuccess {
  result: 'success' | 'partial';
  target: string;
  data: Varbind[];
  truncated?: true;
  truncation_reason?: string | null;
}

export interface SnmpResultFailure {
  result: 'failure';
  target: string;
  error: string;
}

export type SnmpResult = SnmpResultSuccess | SnmpResultFailure;

export class SnmpMonitoringService {
  readonly jobId: string;
  private readonly config: SnmpMonitoringConfig;
  private readonly client: SnmpClient;

  constructor(jobId = '') {
    this.jobId = jobId;
    this.config = getSnmpMonitoringConfig();
    this.client = new SnmpClient(jobId);
  }

  validateIpAddress(ipString: string): string {
    return validateIpAddress(ipString);
  }

  validateOid(oid: string): string {
    return validateOid(oid);
  }

  validatePort(port: unknown): number {
    return validatePort(port);
  }

  validateSnmpParams(params: Record<string, unknown>): SnmpParams {
    return validateSnmpParams(params, this.config);
  }

  async executeSnmpGet(
    target: string,
    port: number,
    oids: ReadonlyArray<string>,
    snmpParams: Record<string, unknown>,
  ): Promise<SnmpResult> {
    let validatedIp: string;
    let validatedPort: number;
    let validatedOids: string[];
    let validatedParams: SnmpParams;
    try {
      validatedIp = this.validateIpAddress(target);
      validatedPort = this.validatePort(port);
      validatedOids = oids.map((o) => this.validateOid(o));
      validatedParams = this.validateSnmpParams(snmpParams);
    } catch (error) {
      if (!(error instanceof SnmpValidationError)) throw error;
      await logError(`SNMP GET validation error: ${error.message}`, { jobId: this.jobId });
      throw new SnmpMonitoringError(error.message);
    }

    await logDebug(
      `SNMP GET - target: ${validatedIp}:${validatedPort}, OIDs: ${formatPyList(validatedOids)}, version: ${validatedParams.version}`,
      { jobId: this.jobId },
    );

    try {
      const varbinds = await this.client.get(validatedIp, validatedPort, validatedOids, validatedParams);
      await logDebug(`SNMP GET successful - ${varbinds.length} varbinds returned`, { jobId: this.jobId });
      return { result: 'success', target: validatedIp, data: varbinds };
    } catch (error) {
      const msg = getErrorMessage(error);
      await logError(`SNMP GET failed: ${msg}`, { jobId: this.jobId });
      return { result: 'failure', target: validatedIp, error: msg };
    }
  }

  async executeSnmpWalk(
    target: string,
    port: number,
    oid: string,
    snmpParams: Record<string, unknown>,
    maxResults?: number,
  ): Promise<SnmpResult> {
    let validatedIp: string;
    let validatedPort: number;
    let validatedOid: string;
    let validatedParams: SnmpParams;
    try {
      validatedIp = this.validateIpAddress(target);
      validatedPort = this.validatePort(port);
      validatedOid = this.validateOid(oid);
      validatedParams = this.validateSnmpParams(snmpParams);
    } catch (error) {
      if (!(error instanceof SnmpValidationError)) throw error;
      await logError(`SNMP WALK validation error: ${error.message}`, { jobId: this.jobId });
      throw new SnmpMonitoringError(error.message);
    }

    await logDebug(
      `SNMP WALK - target: ${validatedIp}:${validatedPort}, OID: ${validatedOid}, max: ${maxResults ?? 'unknown'}`,
      { jobId: this.jobId },
    );

    try {
      const walk = await this.client.walk(validatedIp, validatedPort, validatedOid, validatedParams, maxResults);
      const resultStatus: 'success' | 'partial' = walk.hadError ? 'partial' : 'success';
      await logDebug(`SNMP WALK ${resultStatus} - ${walk.varbinds.length} varbinds returned`, {
        jobId: this.jobId,
      });
      const response: SnmpResultSuccess = {
        result: resultStatus,
        target: validatedIp,
        data: walk.varbinds,
      };
      if (walk.truncated) {
        response.truncated = true;
        response.truncation_reason = walk.truncationReason;
      }
      return response;
    } catch (error) {
      const msg = getErrorMessage(error);
      await logError(`SNMP WALK failed: ${msg}`, { jobId: this.jobId });
      return { result: 'failure', target: validatedIp, error: msg };
    }
  }
}

export function createSnmpMonitoringService(jobId = ''): SnmpMonitoringService {
  return new SnmpMonitoringService(jobId);
}

function formatPyList(items: ReadonlyArray<string>): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`;
}
