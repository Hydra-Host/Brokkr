import { Module, type OnModuleInit } from '@nestjs/common';

import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildNetworkScanSaga } from './network-scan.workflow';
import { NetworkScanServiceFactory, NetworkScanStep } from './steps/network-scan.step';

@Module({
  providers: [NetworkScanServiceFactory, NetworkScanStep],
  exports: [NetworkScanServiceFactory, NetworkScanStep],
})
export class NetworkScanModule implements OnModuleInit {
  constructor(private readonly networkScan: NetworkScanStep) {}

  onModuleInit(): void {
    registerSagaDef(buildNetworkScanSaga({ networkScan: this.networkScan }));
  }
}
