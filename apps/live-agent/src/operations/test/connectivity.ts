import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

interface SubResult {
  status: string;
  [k: string]: unknown;
}

const TIMEOUT_MS = 120_000;

async function runCheck(
  cmd: string,
  args: string[],
  resultKey: string,
  failStatus: 'error' | 'fail' = 'error',
): Promise<SubResult> {
  try {
    const { stdout, exit_code, stderr } = await run(cmd, args, { timeout_ms: TIMEOUT_MS });
    if (exit_code !== 0) {
      return { status: failStatus, error: stderr.trim() || `exit=${exit_code}` };
    }
    return { status: 'pass', [resultKey]: stdout };
  } catch (error) {
    return { status: failStatus, error: getErrorMessage(error) };
  }
}

async function testNetworkInterfaces(): Promise<SubResult> {
  return runCheck('ip', ['link', 'show'], 'interfaces');
}

async function testBmcConnectivity(): Promise<SubResult> {
  return runCheck('ipmitool', ['mc', 'info'], 'bmc_info');
}

async function testLldpDiscovery(): Promise<SubResult> {
  try {
    const which = await run('which', ['lldpctl'], { timeout_ms: 10_000 });
    if (which.exit_code !== 0) {
      return { status: 'unavailable', reason: 'lldpctl not installed' };
    }
  } catch {
    return { status: 'unavailable', reason: 'lldpctl not installed' };
  }
  return runCheck('lldpctl', [], 'lldp_neighbors');
}

async function testInternetConnectivity(): Promise<SubResult> {
  return runCheck('ping', ['-c', '3', '-W', '2', '8.8.8.8'], 'ping_test', 'fail');
}

async function testDnsResolution(): Promise<SubResult> {
  return runCheck('nslookup', ['google.com'], 'dns_test', 'fail');
}

export function registerConnectivityTest(): void {
  registerOperation('test.connectivity', async () => {
    const startTime = new Date().toISOString();

    const [networkInterfaces, bmc, lldp, internet, dns] = await Promise.all([
      testNetworkInterfaces(),
      testBmcConnectivity(),
      testLldpDiscovery(),
      testInternetConnectivity(),
      testDnsResolution(),
    ]);

    const endTime = new Date().toISOString();

    const statuses = [networkInterfaces.status, bmc.status, lldp.status, internet.status, dns.status];

    let overallStatus: 'pass' | 'partial' | 'fail';
    if (statuses.every((s) => s === 'pass')) {
      overallStatus = 'pass';
    } else if (statuses.some((s) => s === 'pass')) {
      overallStatus = 'partial';
    } else {
      overallStatus = 'fail';
    }

    return {
      connectivity: {
        test_type: 'connectivity_validation',
        start_time: startTime,
        network_interfaces: networkInterfaces,
        bmc,
        lldp,
        internet,
        dns,
        end_time: endTime,
        overall_status: overallStatus,
      },
    };
  });
}
