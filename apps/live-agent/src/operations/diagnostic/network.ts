import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { makeLogger } from '../../logger';
import { numOr, runStrict, sh, type HealthSection } from './utils';

const logger = makeLogger('diagnostic.network');

const TIMEOUT_MS = 60_000;

export async function runNetworkDiagnostic(): Promise<{ network: Record<string, unknown> }> {
  const ifaceHealth: HealthSection = {};
  const linkQuality: HealthSection = {};
  const errorRates: HealthSection = {};
  const connectivityTests: HealthSection = {};

  let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
  const networkIssues: string[] = [];
  const networkWarnings: string[] = [];
  let physicalInterfaces: string[] = [];

  try {
    const ipOutput = await sh('ip link show', TIMEOUT_MS);
    if (ipOutput) {
      const interfaces: string[] = [];

      for (const line of ipOutput.split('\n')) {
        if (line.includes(': ') && (line.toLowerCase().includes('state ') || line.toLowerCase().includes('mtu '))) {
          const parts = line.split(': ');
          if (parts.length >= 2) {
            const interfaceName = parts[1]!.split('@')[0]!;
            interfaces.push(interfaceName);

            const interfaceInfo: Record<string, unknown> = {
              name: interfaceName,
              status: 'unknown',
              mtu: null,
              flags: [] satisfies string[],
            };

            if (line.includes('<') && line.includes('>')) {
              const flagsSection = line.split('<')[1]!.split('>')[0]!;
              const flags = flagsSection.split(',');
              interfaceInfo['flags'] = flags;

              if (flags.includes('UP') && flags.includes('LOWER_UP')) {
                interfaceInfo['status'] = 'up';
              } else if (flags.includes('UP')) {
                interfaceInfo['status'] = 'no-carrier';
              } else {
                interfaceInfo['status'] = 'down';
              }
            }

            if (line.includes('mtu ')) {
              try {
                const mtuPart = line.split('mtu ')[1]!.split(/\s+/)[0]!;
                interfaceInfo['mtu'] = Number.parseInt(mtuPart, 10);
              } catch (error) {
                logger.trace('interface mtu parse failed', { iface: interfaceName, error: getErrorMessage(error) });
              }
            }

            ifaceHealth[interfaceName] = interfaceInfo;
          }
        }
      }

      physicalInterfaces = interfaces.filter(
        (name) => !['lo', 'virbr', 'docker', 'veth'].some((p) => name.startsWith(p)),
      );
      ifaceHealth['physical_interfaces'] = physicalInterfaces;
      ifaceHealth['total_interfaces'] = interfaces.length;
    }
  } catch (error) {
    ifaceHealth['error'] = getErrorMessage(error);
  }

  for (const iface of physicalInterfaces.slice(0, 5)) {
    try {
      try {
        const ethtoolOutput = await runStrict('ethtool', ['-S', iface], TIMEOUT_MS);
        if (ethtoolOutput) {
          const stats: Record<string, number | string> = {};
          for (const line of ethtoolOutput.split('\n')) {
            if (line.includes(': ')) {
              const [keyRaw, valueRaw] = line.split(/: (.*)/s);
              const key = keyRaw!.trim();
              const value = (valueRaw ?? '').trim();
              const asInt = Number.parseInt(value, 10);
              stats[key] = Number.isNaN(asInt) || String(asInt) !== value ? value : asInt;
            }
          }

          const rxErr = numOr(stats['rx_errors']);
          const txErr = numOr(stats['tx_errors']);
          const rxDrop = numOr(stats['rx_dropped']);
          const txDrop = numOr(stats['tx_dropped']);
          const collisions = numOr(stats['collisions']);

          const ifaceStats: Record<string, unknown> = {
            raw_stats: stats,
            rx_errors: rxErr,
            tx_errors: txErr,
            rx_dropped: rxDrop,
            tx_dropped: txDrop,
            collisions,
          };

          const totalRx = numOr(stats['rx_packets']);
          const totalTx = numOr(stats['tx_packets']);

          if (totalRx > 0) {
            const rxErrorRate = (rxErr / totalRx) * 100;
            ifaceStats['rx_error_rate_percent'] = Math.round(rxErrorRate * 1000) / 1000;
            if (rxErrorRate > 1.0) {
              if (overallStatus === 'healthy') overallStatus = 'critical';
              networkIssues.push(`${iface}: High RX error rate ${rxErrorRate.toFixed(2)}%`);
            } else if (rxErrorRate > 0.1) {
              if (overallStatus === 'healthy') overallStatus = 'warning';
              networkWarnings.push(`${iface}: Elevated RX error rate ${rxErrorRate.toFixed(2)}%`);
            }
          }

          if (totalTx > 0) {
            const txErrorRate = (txErr / totalTx) * 100;
            ifaceStats['tx_error_rate_percent'] = Math.round(txErrorRate * 1000) / 1000;
            if (txErrorRate > 1.0) {
              if (overallStatus === 'healthy') overallStatus = 'critical';
              networkIssues.push(`${iface}: High TX error rate ${txErrorRate.toFixed(2)}%`);
            } else if (txErrorRate > 0.1) {
              if (overallStatus === 'healthy') overallStatus = 'warning';
              networkWarnings.push(`${iface}: Elevated TX error rate ${txErrorRate.toFixed(2)}%`);
            }
          }

          errorRates[iface] = ifaceStats;
        }
      } catch {
        networkWarnings.push(`ethtool not available for ${iface} analysis`);
      }

      try {
        const ethtoolLink = await runStrict('ethtool', [iface], TIMEOUT_MS);
        if (ethtoolLink) {
          const linkInfo: Record<string, unknown> = { interface: iface };

          for (const rawLine of ethtoolLink.split('\n')) {
            const line = rawLine.trim();
            if (line.includes('Speed:')) {
              linkInfo['speed'] = line.split('Speed:')[1]!.trim();
            } else if (line.includes('Duplex:')) {
              linkInfo['duplex'] = line.split('Duplex:')[1]!.trim();
            } else if (line.includes('Link detected:')) {
              const linkDetected = line.split('Link detected:')[1]!.trim().toLowerCase();
              linkInfo['link_detected'] = linkDetected === 'yes';
              if (!linkInfo['link_detected'] && physicalInterfaces.includes(iface)) {
                networkWarnings.push(`${iface}: No link detected`);
              }
            }
          }

          linkQuality[iface] = linkInfo;
        }
      } catch (error) {
        logger.trace('ethtool link probe failed', { iface, error: getErrorMessage(error) });
      }
    } catch (error) {
      logger.trace('interface diagnostics failed', { iface, error: getErrorMessage(error) });
    }
  }

  if (physicalInterfaces.length > 0) {
    try {
      const routeOutput = await sh('ip route show default', TIMEOUT_MS);
      if (routeOutput && routeOutput.includes('via')) {
        const gateway = routeOutput.split('via')[1]!.trim().split(/\s+/)[0]!;

        try {
          const pingOutput = await runStrict('ping', ['-c', '3', '-W', '2', gateway], TIMEOUT_MS);
          if (pingOutput) {
            const pingStats: Record<string, unknown> = { target: gateway };

            if (pingOutput.includes('0% packet loss')) {
              pingStats['status'] = 'success';
              pingStats['packet_loss'] = '0%';
            } else if (pingOutput.includes('% packet loss')) {
              const lossLine = pingOutput.split('\n').filter((line) => line.includes('% packet loss'));
              if (lossLine.length > 0) {
                const lossPctStr = lossLine[0]!.split('%')[0]!.split(/\s+/).slice(-1)[0]!;
                pingStats['packet_loss'] = lossPctStr + '%';
                const lossPct = parseFloat(lossPctStr);
                if (lossPct > 50) {
                  pingStats['status'] = 'failed';
                  networkIssues.push(`High packet loss to gateway: ${lossPct}%`);
                } else if (lossPct > 0) {
                  pingStats['status'] = 'degraded';
                  networkWarnings.push(`Packet loss to gateway: ${lossPct}%`);
                } else {
                  pingStats['status'] = 'success';
                }
              }
            } else {
              pingStats['status'] = 'failed';
              networkIssues.push('Cannot reach gateway - network connectivity issue');
            }

            connectivityTests['gateway'] = pingStats;
          }
        } catch (error) {
          logger.debug('gateway ping failed', { gateway, error: getErrorMessage(error) });
        }
      }
    } catch (error) {
      connectivityTests['error'] = getErrorMessage(error);
    }
  }

  try {
    const dmesgOutput = await sh('dmesg', TIMEOUT_MS);
    if (dmesgOutput) {
      const networkErrorPatterns = [
        'network',
        'ethernet',
        'link down',
        'link up',
        'carrier',
        'duplex',
        'autoneg',
        'phy',
        'NIC',
        'rx',
        'tx',
        'timeout',
      ];

      const networkErrors: string[] = [];
      for (const line of dmesgOutput.split('\n')) {
        const lineLower = line.toLowerCase();
        if (physicalInterfaces.some((iface) => lineLower.includes(iface))) {
          for (const pattern of networkErrorPatterns) {
            if (lineLower.includes(pattern)) {
              networkErrors.push(line.trim());
              break;
            }
          }
        }
      }

      if (networkErrors.length > 0) {
        connectivityTests['dmesg_network_events'] = networkErrors.slice(-10);
        connectivityTests['total_network_events'] = networkErrors.length;

        const criticalPatterns = ['firmware', 'timeout', 'reset', 'error', 'failed'];
        const criticalEvents = networkErrors.filter((e) => criticalPatterns.some((p) => e.toLowerCase().includes(p)));

        if (criticalEvents.length > 0) {
          if (criticalEvents.length > 5) {
            if (overallStatus === 'healthy') overallStatus = 'critical';
            networkIssues.push(`Multiple critical network events: ${criticalEvents.length} events`);
          } else {
            if (overallStatus === 'healthy') overallStatus = 'warning';
            networkWarnings.push(`Network events detected: ${criticalEvents.length} critical events`);
          }
        }
      }
    }
  } catch (error) {
    connectivityTests['dmesg_error'] = getErrorMessage(error);
  }

  const recommendations: string[] = [];
  if (networkIssues.length > 0) {
    recommendations.push('Network issues detected - investigate immediately');
    if (networkIssues.some((i) => i.toLowerCase().includes('error rate'))) {
      recommendations.push('Check network cables and switch ports');
    }
    if (networkIssues.some((i) => i.toLowerCase().includes('packet loss'))) {
      recommendations.push('Investigate network infrastructure and routing');
    }
    if (networkIssues.some((i) => i.toLowerCase().includes('link'))) {
      recommendations.push('Check physical network connections');
    }
  } else if (networkWarnings.length > 0) {
    recommendations.push('Monitor network performance closely');
    if (networkWarnings.some((w) => w.toLowerCase().includes('error'))) {
      recommendations.push('Monitor error rates - possible network degradation');
    }
  } else {
    recommendations.push('Network health appears normal');
    if (physicalInterfaces.length === 0) {
      recommendations.push('No physical network interfaces detected');
    }
  }

  const health_assessment: HealthSection = {
    overall_status: overallStatus,
    issues: networkIssues,
    warnings: networkWarnings,
    physical_interfaces_count: physicalInterfaces.length,
    checks_performed: [
      'Interface enumeration and status',
      'Error rate analysis',
      'Link quality assessment',
      'Connectivity testing',
      'Network event log analysis',
    ],
    recommendations,
  };

  return {
    network: {
      status: overallStatus,
      interface_health: ifaceHealth,
      link_quality: linkQuality,
      error_rates: errorRates,
      connectivity_tests: connectivityTests,
      health_assessment,
    },
  };
}

export function registerNetworkDiagnostic(): void {
  registerOperation('diagnostic.network', async () => runNetworkDiagnostic());
}
