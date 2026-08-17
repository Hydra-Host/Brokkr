import {
  asRecord,
  isEmptyRecord,
  JsonRecord,
  logger,
  PropertyAccessError,
  RecordIndexError,
  RecordKeyError,
  RecordTypeError,
  RedfishBaseHandler,
  sleep,
} from '../base/base.js';

import { isRecord } from '@repo/utils';

const APP_CLASS = 'adapters-redfish';

export const DELL_IDRAC9_TERMINAL_FAILURE_STATES: ReadonlySet<string> = new Set([
  'failed',
  'completedwitherrors',
  'rebootfailed',
  'killed',
]);
export const DELL_JOB_STALL_TIMEOUT = 20 * 60;
export const DELL_BOOTPROGRESS_SUCCESS: ReadonlySet<string> = new Set(['osrunning', 'osbootstarted']);
export const DELL_BOOTPROGRESS_HARD_FAIL: ReadonlySet<string> = new Set(['setupentered']);
export const DELL_SEL_ENTRIES_ENDPOINT = '/redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Sel/Entries';
export const DELL_LAST_RESET_UNKNOWN = '0001-01-01T00:00:00+00:00';

export const DELL_JID_RESOLVE_ATTEMPTS = 5;
export const DELL_JID_RESOLVE_INTERVAL = 2;

export type JobOutcome = 'completed' | 'failed' | 'stalled';

export type RebootOutcome = 'os_running' | 'setup_halt' | 'hardware_fail' | 'timeout' | 'bios_not_applied';

function membersOrEmpty(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  const typeName = typeof value === 'string' ? 'str' : isRecord(value) ? 'str' : value === null ? 'null' : typeof value;
  throw new PropertyAccessError(`'${typeName}' cannot read properties of non-object`);
}

export class DellRedfishLib extends RedfishBaseHandler {
  async createBiosConfigJob(): Promise<readonly [boolean, string]> {
    const prePostJobIds = await this.listJobIds();
    const response = await this.fetch('POST', this.device.jobserviceEndpoint, {
      JobType: 'BIOSConfiguration',
      TargetSettingsURI: this.device.biosPatchEndpoint,
      RebootJobType: 'PowerCycle',
    });

    if ('error' in response) {
      try {
        const errObj = response['error'];
        const errRecord = asRecord(errObj);
        if (!('@Message.ExtendedInfo' in errRecord)) throw new RecordKeyError('@Message.ExtendedInfo');
        const extendedInfo = errRecord['@Message.ExtendedInfo'];
        if (!Array.isArray(extendedInfo)) throw new RecordTypeError(`'${typeof extendedInfo}' object is not indexable`);
        if (extendedInfo.length === 0) throw new RecordIndexError();
        const first = asRecord(extendedInfo[0]);
        if (!('Message' in first)) throw new RecordKeyError('Message');
        const message = first['Message'];
        logger.error(`reboot is not proceeding: ${String(message)}`, { jobId: this.jobId, appClassName: APP_CLASS });
      } catch (err) {
        if (err instanceof Error && err.name === 'RecordKeyError') {
          const errObj = asRecord(response['error']);
          if ('message' in errObj) {
            logger.error(`reboot is not proceeding: ${String(errObj['message'])}`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
          } else {
            logger.error(`reboot is not proceeding: ${JSON.stringify(response['error'])}`, {
              jobId: this.jobId,
              appClassName: APP_CLASS,
            });
          }
        } else {
          throw err;
        }
      }
      return [false, ''];
    }

    for (let attempt = 0; attempt < DELL_JID_RESOLVE_ATTEMPTS; attempt++) {
      const jobUrl = await this.findNewBiosJobUrl(prePostJobIds);
      if (jobUrl) {
        return [true, jobUrl];
      }
      await sleep(DELL_JID_RESOLVE_INTERVAL * 1000);
    }

    logger.error('BIOSConfiguration POST accepted but new job @odata.id never appeared; deferring to host signal', {
      jobId: this.jobId,
      appClassName: APP_CLASS,
    });
    return [true, ''];
  }

  async issueNormalReboot(): Promise<void> {
    await this.fetch('POST', this.device.rebootEndpoint, { ResetType: 'GracefulRestart' });
    await sleep(this.device.rebootTimeout * 1000);
  }

  async recoverFromPoweredoff(): Promise<void> {
    logger.warning('host reports ServerStatus=PoweredOff after BIOS job; issuing ResetType=On to recover', {
      jobId: this.jobId,
      appClassName: APP_CLASS,
    });
    await this.fetch('POST', this.device.rebootEndpoint, { ResetType: 'On' });
    await sleep(this.device.rebootTimeout * 1000);
  }

  async waitForBiosJobTerminal(jobUrl: string): Promise<JobOutcome> {
    logger.info('monitoring bios change job progress', { jobId: this.jobId, appClassName: APP_CLASS });
    await sleep(this.device.rebootTimeout * 1000);
    let attempt = 0;
    let lastPercent: unknown = null;
    const stallCap = Math.max(1, Math.floor(DELL_JOB_STALL_TIMEOUT / Math.max(1, this.device.rebootTimeout)));
    while (attempt <= stallCap) {
      const response = await this.fetch('GET', jobUrl, {});
      const percentComplete: unknown = 'PercentComplete' in response ? response['PercentComplete'] : 'na';
      const stateRaw = 'JobState' in response ? response['JobState'] : '';
      const state = String(stateRaw).toLowerCase();
      const messageRaw = 'Message' in response ? response['Message'] : '';
      const message = String(messageRaw);
      logger.info(`bios change job progress: ${percentComplete}% (state=${state || 'unknown'})`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      if (state === 'completed') {
        logger.info('bios change job completed', { jobId: this.jobId, appClassName: APP_CLASS });
        return 'completed';
      }
      if (DELL_IDRAC9_TERMINAL_FAILURE_STATES.has(state)) {
        logger.error(
          `bios change job terminated in failure (state=${JSON.stringify(state)}, message=${JSON.stringify(message)})`,
          {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          },
        );
        return 'failed';
      }
      await sleep(this.device.rebootTimeout * 1000);
      if (percentComplete !== 'na' && percentComplete !== lastPercent) {
        lastPercent = percentComplete;
        attempt = 0;
      } else {
        attempt += 1;
      }
    }
    logger.error(
      `bios change job stalled at ${JSON.stringify(lastPercent)}% for ~${DELL_JOB_STALL_TIMEOUT}s; giving up`,
      {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      },
    );
    return 'stalled';
  }

  async waitForHostReboot(baseline: string): Promise<RebootOutcome> {
    logger.info('monitoring device power state', { jobId: this.jobId, appClassName: APP_CLASS });
    const baselineKnown = baseline !== DELL_LAST_RESET_UNKNOWN;
    if (!baselineKnown) {
      logger.warning('LastResetTime baseline unavailable; success requires observed BootProgress transition', {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
    }
    const baselineParsed = DellRedfishLib.parseIso(baseline);
    let observedLeftOsRunning = false;

    for (let i = 0; i < this.device.rebootWaits; i++) {
      const [bootStateRaw, health, currentReset] = await this.getBootProgressAndHealth();
      const bootState = bootStateRaw.toLowerCase().trim();
      const status = await this.getRemoteServicesStatus();
      const serverStatusRaw = 'ServerStatus' in status ? status['ServerStatus'] : '';
      if (typeof serverStatusRaw !== 'string') {
        throw new PropertyAccessError(
          `'${serverStatusRaw === null ? 'null' : typeof serverStatusRaw}' cannot read property 'toLowerCase' of non-string`,
        );
      }
      const serverStatus = serverStatusRaw.toLowerCase().trim();

      if (bootState && !DELL_BOOTPROGRESS_SUCCESS.has(bootState)) {
        observedLeftOsRunning = true;
      }

      if (DELL_BOOTPROGRESS_SUCCESS.has(bootState)) {
        const currentParsed = DellRedfishLib.parseIso(currentReset);
        const resetAdvanced =
          baselineKnown && baselineParsed !== null && currentParsed !== null && currentParsed > baselineParsed;
        if (resetAdvanced || observedLeftOsRunning) {
          logger.info(
            `device has rebooted (BootProgress.LastState=${JSON.stringify(bootStateRaw)}, ` +
              `LastResetTime=${JSON.stringify(currentReset)}, ` +
              `proof=${resetAdvanced ? 'reset_advanced' : 'observed_transition'})`,
            { jobId: this.jobId, appClassName: APP_CLASS },
          );
          if (!isEmptyRecord(this.device.biosPendingParams) && !(await this.verifyPendingBiosCleared())) {
            logger.error(
              'host returned to OS_RUNNING but iDRAC still reports pending BIOS settings, the config did not apply',
              {
                jobId: this.jobId,
                appClassName: APP_CLASS,
              },
            );
            return 'bios_not_applied';
          }
          return 'os_running';
        }
        logger.info(
          `BootProgress.LastState=${JSON.stringify(bootStateRaw)} but no proof of reboot yet ` +
            `(LastResetTime=${JSON.stringify(currentReset)}, baseline=${JSON.stringify(baseline)}); continuing`,
          { jobId: this.jobId, appClassName: APP_CLASS },
        );
        await sleep(this.device.rebootTimeout * 1000);
        continue;
      }

      if (DELL_BOOTPROGRESS_HARD_FAIL.has(bootState)) {
        logger.error(
          `hard-failure BootProgress.LastState=${JSON.stringify(bootStateRaw)}; host requires operator intervention`,
          {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          },
        );
        return 'setup_halt';
      }

      if (health === 'Critical') {
        const freshSel = await this.recentCriticalSel(baseline);
        if (freshSel) {
          logger.error(`host Status.Health=Critical with post-reset Critical SEL entries: ${freshSel}`, {
            jobId: this.jobId,
            appClassName: APP_CLASS,
          });
          return 'hardware_fail';
        }
      }

      if (serverStatus === 'poweredoff') {
        await this.recoverFromPoweredoff();
        continue;
      }

      logger.info(
        `device is still booting (BootProgress.LastState=${JSON.stringify(bootStateRaw)}, ` +
          `ServerStatus=${JSON.stringify(status['ServerStatus'] ?? null)}, Health=${JSON.stringify(health)}, ` +
          `LastResetTime=${JSON.stringify(currentReset)})`,
        { jobId: this.jobId, appClassName: APP_CLASS },
      );
      await sleep(this.device.rebootTimeout * 1000);
    }

    logger.info('failed to reboot or to detect the reboot', { jobId: this.jobId, appClassName: APP_CLASS });
    return 'timeout';
  }

  async listJobIds(): Promise<Set<string>> {
    if (!this.device.jobserviceEndpoint) {
      return new Set();
    }
    const response = await this.fetch('GET', `${this.device.jobserviceEndpoint}?$expand=*($levels=1)`, {});
    if (isEmptyRecord(response)) {
      return new Set();
    }
    const members = membersOrEmpty(response['Members']);
    const ids = new Set<string>();
    for (const member of members) {
      if (!isRecord(member)) {
        throw new PropertyAccessError(
          `'${member === null ? 'null' : typeof member}' cannot read properties of non-object`,
        );
      }
      const odataId = member['@odata.id'];
      if (odataId !== null && odataId !== undefined && odataId !== '' && odataId !== 0 && odataId !== false) {
        ids.add(String(odataId));
      }
    }
    return ids;
  }

  async findNewBiosJobUrl(excludeIds: Set<string>): Promise<string> {
    if (!this.device.jobserviceEndpoint) {
      return '';
    }
    const response = await this.fetch('GET', `${this.device.jobserviceEndpoint}?$expand=*($levels=1)`, {});
    if (isEmptyRecord(response)) {
      return '';
    }
    const candidatesMembers = membersOrEmpty(response['Members']);
    const candidates: JsonRecord[] = [];
    for (const member of candidatesMembers) {
      if (!isRecord(member)) {
        throw new PropertyAccessError(
          `'${member === null ? 'null' : typeof member}' cannot read properties of non-object`,
        );
      }
      const odataId = member['@odata.id'];
      if (
        odataId !== null &&
        odataId !== undefined &&
        odataId !== '' &&
        odataId !== 0 &&
        odataId !== false &&
        !excludeIds.has(String(odataId)) &&
        member['JobType'] === 'BIOSConfiguration'
      ) {
        candidates.push(member);
      }
    }
    if (candidates.length === 0) {
      return '';
    }
    candidates.sort((a, b) => {
      const av = String(a['StartTime'] ?? '');
      const bv = String(b['StartTime'] ?? '');
      if (av === bv) return 0;
      return av < bv ? 1 : -1;
    });
    return String(candidates[0]?.['@odata.id'] ?? '');
  }

  async getRemoteServicesStatus(): Promise<JsonRecord> {
    if (this.device.dellLcServiceEndpoint === undefined) {
      throw new PropertyAccessError(`'RedfishDevice' cannot read property 'dellLcServiceEndpoint' of undefined`);
    }
    if (!this.device.dellLcServiceEndpoint) {
      return {};
    }
    const response = await this.fetch('POST', this.device.dellLcServiceEndpoint, { _: '' });
    return response;
  }

  async verifyPendingBiosCleared(): Promise<boolean> {
    if (!this.device.biosPatchEndpoint) {
      return false;
    }
    const response = await this.fetch('GET', this.device.biosPatchEndpoint, {});
    if (isEmptyRecord(response) || !('Attributes' in response)) {
      return false;
    }
    const attrs = response['Attributes'];
    if (attrs === null || attrs === undefined || attrs === '' || attrs === 0 || attrs === false) return true;
    if (Array.isArray(attrs)) return attrs.length === 0;
    if (isRecord(attrs)) return Object.keys(attrs).length === 0;
    return false;
  }

  async getBootProgressAndHealth(): Promise<readonly [string, string, string | null]> {
    if (!this.device.systemEndpoint) {
      return ['', '', null];
    }
    const response = await this.fetch('GET', this.device.systemEndpoint, {});
    if (isEmptyRecord(response)) {
      return ['', '', null];
    }
    const bootProgressRaw = response['BootProgress'] ?? {};
    if (!isRecord(bootProgressRaw)) {
      throw new PropertyAccessError(
        `'${bootProgressRaw === null ? 'null' : typeof bootProgressRaw}' cannot read properties of non-object`,
      );
    }
    const statusRaw = response['Status'] ?? {};
    if (!isRecord(statusRaw)) {
      throw new PropertyAccessError(
        `'${statusRaw === null ? 'null' : typeof statusRaw}' cannot read properties of non-object`,
      );
    }
    const bootProgress: JsonRecord = bootProgressRaw;
    const status: JsonRecord = statusRaw;
    const lastReset = response['LastResetTime'];
    const bootLast = bootProgress['LastState'] ?? '';
    const healthLast = status['Health'] ?? '';
    return [
      String(bootLast),
      String(healthLast),
      lastReset !== null && lastReset !== undefined && lastReset !== '' && lastReset !== 0 && lastReset !== false
        ? String(lastReset)
        : null,
    ];
  }

  async getLastResetTime(): Promise<string> {
    if (!this.device.systemEndpoint) {
      return DELL_LAST_RESET_UNKNOWN;
    }
    const response = await this.fetch('GET', this.device.systemEndpoint, {});
    if (isEmptyRecord(response)) {
      return DELL_LAST_RESET_UNKNOWN;
    }
    const value = response['LastResetTime'];
    return value !== null && value !== undefined && value !== '' && value !== 0 && value !== false
      ? String(value)
      : DELL_LAST_RESET_UNKNOWN;
  }

  async recentCriticalSel(since: string, limit = 5): Promise<string> {
    if (since === DELL_LAST_RESET_UNKNOWN) {
      return '';
    }
    const response = await this.fetch('GET', `${DELL_SEL_ENTRIES_ENDPOINT}?$top=${limit}`, {});
    if (isEmptyRecord(response)) {
      return '';
    }
    const members = membersOrEmpty(response['Members']);
    const baseline = DellRedfishLib.parseIso(since);
    const fresh: string[] = [];
    for (const member of members) {
      if (!isRecord(member)) {
        throw new PropertyAccessError(
          `'${member === null ? 'null' : typeof member}' cannot read properties of non-object`,
        );
      }
      const entry = member;
      if (entry['Severity'] !== 'Critical') {
        continue;
      }
      const createdRaw = 'Created' in entry ? entry['Created'] : '';
      if (baseline !== null) {
        if (
          createdRaw === null ||
          createdRaw === undefined ||
          createdRaw === '' ||
          createdRaw === 0 ||
          createdRaw === false
        ) {
          continue;
        }
        if (typeof createdRaw !== 'string') {
          throw new PropertyAccessError(`'${typeof createdRaw}' cannot read property 'endsWith' of non-string`);
        }
        const createdParsed = DellRedfishLib.parseIso(createdRaw);
        if (createdParsed === null || createdParsed <= baseline) {
          continue;
        }
      }
      const messageId = 'MessageId' in entry ? String(entry['MessageId']) : '?';
      const message = 'Message' in entry ? String(entry['Message']) : '';
      fresh.push(`${String(createdRaw)} ${messageId} ${message}`);
    }
    return fresh.join('; ');
  }

  static parseIso(value: string | null): number | null {
    if (!value) {
      return null;
    }
    const normalized = value.endsWith('Z') ? `${value.slice(0, -1)}+00:00` : value;
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }
}
