export interface IpmiMonitoringService {
  executeIpmiCommand(
    ip: string,
    username: string,
    password: string,
    command: unknown,
    port?: number,
    timeout?: number | null,
  ): Promise<unknown>;
  executeBatchIpmiCommands(
    ip: string,
    username: string,
    password: string,
    commands: readonly unknown[],
    port?: number,
  ): Promise<unknown>;
}

export interface IpmiMonitoringServiceFactory {
  create(jobId: string): IpmiMonitoringService;
}

export const IPMI_MONITORING_SERVICE_FACTORY = Symbol('IPMI_MONITORING_SERVICE_FACTORY');
