import { registerOperation } from '../../dispatch/registry';
import { getErrorMessage } from '../../errors';
import { run } from '../../exec';

const DIAGNOSTICS_PACKAGE = 'brokkr-diagnostics';
const DIAGNOSTICS_VERSION = '0.6.1';
const PIP_SHOW_TIMEOUT_MS = 15_000;
const PIP_INSTALL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;

const CC_PROBE_SCRIPT = `
from brokkr_diagnostics.confidential_compute import ConfidentialComputeManager
mgr = ConfidentialComputeManager()
devices = mgr.get_devices()
cc_on = False
for bdf in devices:
    gpu = mgr.get_by_bdf(str(bdf))
    if gpu and gpu.query_cc_mode() == "on":
        cc_on = True
print('CC_ENABLED' if cc_on else 'CC_DISABLED')
`.trim();

type EnsureDiagnosticsResult = { ok: true } | { ok: false; reason: string };

type CcModeResult = { cc_enabled: boolean; cc_check_error?: string; skip_benchmarks?: boolean };

async function ensureBrokkrDiagnostics(): Promise<EnsureDiagnosticsResult> {
  const show = await run('python3', ['-m', 'pip', 'show', DIAGNOSTICS_PACKAGE], {
    timeout_ms: PIP_SHOW_TIMEOUT_MS,
  }).catch(() => null);
  if (show && show.exit_code === 0 && show.stdout.includes(`Name: ${DIAGNOSTICS_PACKAGE}`)) {
    return { ok: true };
  }

  const spec = `${DIAGNOSTICS_PACKAGE}==${DIAGNOSTICS_VERSION}`;
  try {
    const install = await run('python3', ['-m', 'pip', 'install', '--break-system-packages', spec], {
      timeout_ms: PIP_INSTALL_TIMEOUT_MS,
    });
    if (install.exit_code === 0) {
      return { ok: true };
    }
    return { ok: false, reason: `pip install ${spec} failed (exit=${install.exit_code}): ${install.stderr.trim()}` };
  } catch (error) {
    return { ok: false, reason: `pip install ${spec} errored: ${getErrorMessage(error)}` };
  }
}

export async function checkCcMode(): Promise<CcModeResult> {
  try {
    const ensured = await ensureBrokkrDiagnostics();
    if (!ensured.ok) {
      return {
        cc_enabled: false,
        cc_check_error: `${DIAGNOSTICS_PACKAGE} unavailable: ${ensured.reason}`,
      };
    }

    const { stdout, exit_code, stderr } = await run('python3', ['-c', CC_PROBE_SCRIPT], {
      timeout_ms: PROBE_TIMEOUT_MS,
    });
    if (exit_code !== 0) {
      return {
        cc_enabled: false,
        cc_check_error: `python3 probe failed (exit=${exit_code}): ${stderr.trim()}`,
      };
    }
    if (stdout.includes('CC_ENABLED')) {
      return { cc_enabled: true, skip_benchmarks: true };
    }
    return { cc_enabled: false };
  } catch (error) {
    return {
      cc_enabled: false,
      cc_check_error: getErrorMessage(error),
    };
  }
}

export function registerCcModeChecker(): void {
  registerOperation('benchmark.checkCcMode', checkCcMode);
}
