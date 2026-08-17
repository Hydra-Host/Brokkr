import { createSocket } from 'node:dgram';

import { Logger } from '@nestjs/common';

const logger = new Logger('adapter-ipmi-ping');

export const RMCP_VERSION_1_0 = 0x06;
export const RMCP_SEQ_NO_ACK = 0xff;
export const RMCP_CLASS_IPMI = 0x07;
export const IPMI_AUTH_TYPE_NONE = 0x00;
export const IPMI_SLAVE_ADDRESS_BMC = 0x20;
export const IPMI_NET_FN_APP_RQ = 0x06;
export const IPMI_NET_FN_APP_RS = 0x07;
export const IPMI_BMC_IPMB_LUN = 0x00;
export const IPMI_CMD_GET_CHANNEL_AUTH_CAPABILITIES = 0x38;
export const IPMI_CHANNEL_CURRENT = 0x0e;
export const IPMI_PRIVILEGE_LEVEL_USER = 0x02;

export type PingOutcome = 'reachable' | 'timeout' | 'no_response' | 'error';

export interface IpmiPingOptions {
  port?: number;
  timeout?: number;
  jobId?: string;
}

export interface IpmiPingRetryOptions extends IpmiPingOptions {
  maxAttempts?: number;
  backoffSeconds?: number;
}

export function ipmiChecksum(data: readonly number[]): number {
  let sum = 0;
  for (const byte of data) sum += byte;
  return -sum & 0xff;
}

export function buildIpmiPingPacket(sequenceNumber = 0): Buffer {
  const rmcpHeader = [RMCP_VERSION_1_0, 0x00, RMCP_SEQ_NO_ACK, RMCP_CLASS_IPMI];
  const msgLen = 9;
  const lanSessionHeader = [IPMI_AUTH_TYPE_NONE, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, msgLen];

  const rsAddr = IPMI_SLAVE_ADDRESS_BMC;
  const netfnLun = (IPMI_NET_FN_APP_RQ << 2) | IPMI_BMC_IPMB_LUN;
  const checksum1 = ipmiChecksum([rsAddr, netfnLun]);

  const rqAddr = 0x81;
  const rqSeqLun = ((sequenceNumber & 0x3f) << 2) | IPMI_BMC_IPMB_LUN;
  const cmd = IPMI_CMD_GET_CHANNEL_AUTH_CAPABILITIES;
  const cmdData = [IPMI_CHANNEL_CURRENT, IPMI_PRIVILEGE_LEVEL_USER];
  const checksum2 = ipmiChecksum([rqAddr, rqSeqLun, cmd, ...cmdData]);

  return Buffer.from([
    ...rmcpHeader,
    ...lanSessionHeader,
    rsAddr,
    netfnLun,
    checksum1,
    rqAddr,
    rqSeqLun,
    cmd,
    ...cmdData,
    checksum2,
  ]);
}

export function isValidIpmiResponse(data: Buffer): boolean {
  if (data.length < 21) return false;
  if (data[0] !== RMCP_VERSION_1_0) return false;
  const classByte = data[3];
  if (classByte === undefined || (classByte & 0x1f) !== RMCP_CLASS_IPMI) return false;
  if (data.length > 15) {
    const netfnByte = data[15];
    if (netfnByte === undefined) return false;
    const netFn = (netfnByte >> 2) & 0x3f;
    if (netFn !== IPMI_NET_FN_APP_RS) return false;
  }
  return true;
}

function probe(ip: string, port: number, timeout: number): Promise<PingOutcome> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (outcome: PingOutcome): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };

    timer = setTimeout(() => finish('timeout'), timeout * 1000);

    socket.on('message', (data) => finish(isValidIpmiResponse(data) ? 'reachable' : 'no_response'));
    socket.on('error', () => finish('no_response'));
    socket.send(buildIpmiPingPacket(0), port, ip, (err) => {
      if (err) finish('no_response');
    });
  });
}

export async function ipmiPingOutcome(ip: string, opts: IpmiPingOptions = {}): Promise<PingOutcome> {
  const port = opts.port ?? 623;
  const timeout = opts.timeout ?? 2.0;
  const jobId = opts.jobId ?? '';
  logger.log(`IPMI ping ${ip}:${port}`, jobId);

  let outcome: PingOutcome;
  try {
    outcome = await probe(ip, port, timeout);
  } catch (e) {
    logger.error(`IPMI ping error for ${ip}: ${e instanceof Error ? e.message : String(e)}`, jobId);
    return 'error';
  }
  if (outcome === 'timeout') {
    logger.log(`IPMI ping timeout for ${ip}`, jobId);
  }
  return outcome;
}

export async function ipmiPing(ip: string, opts: IpmiPingOptions = {}): Promise<boolean> {
  return (await ipmiPingOutcome(ip, opts)) === 'reachable';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ipmiPingWithRetry(ip: string, opts: IpmiPingRetryOptions = {}): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffSeconds = opts.backoffSeconds ?? 2.0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await ipmiPing(ip, opts)) return true;
    if (attempt < maxAttempts) await sleep(backoffSeconds * 1000);
  }
  return false;
}
