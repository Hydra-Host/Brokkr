import { isEmptyRecord, logger } from '../base/base.js';
import { DellRedfishLib, JobOutcome } from './lib.js';

const APP_CLASS = 'adapters-redfish';

export class RedfishDellHandler extends DellRedfishLib {
  async runBiosConfigLifecycle(): Promise<void> {
    const baseline = await this.getLastResetTime();

    const biosPath = !isEmptyRecord(this.device.biosPendingParams);
    let jobOutcome: JobOutcome | null = null;
    if (biosPath) {
      const [accepted, jobUrl] = await this.createBiosConfigJob();
      if (!accepted) {
        this.device.rebootNeeded = false;
        return;
      }
      if (jobUrl) {
        jobOutcome = await this.waitForBiosJobTerminal(jobUrl);
      } else {
        jobOutcome = 'stalled';
      }
    } else {
      await this.issueNormalReboot();
    }

    const rebootOutcome = await this.waitForHostReboot(baseline);
    logger.info(`reboot lifecycle terminal state: ${rebootOutcome}`, { jobId: this.jobId, appClassName: APP_CLASS });

    const jobClean = jobOutcome === null || jobOutcome === 'completed';
    if (jobClean && rebootOutcome === 'os_running') {
      this.device.rebootNeeded = false;
    }
  }
}
