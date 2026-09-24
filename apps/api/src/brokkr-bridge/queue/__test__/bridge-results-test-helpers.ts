import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';

export class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}
