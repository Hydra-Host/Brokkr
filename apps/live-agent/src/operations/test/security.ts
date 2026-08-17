import { access, readFile } from 'node:fs/promises';
import { registerOperation } from '../../dispatch/registry';
import { run } from '../../exec';
import { makeLogger } from '../../logger';

const logger = makeLogger('test');

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFileQuiet(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function testTdxCapability(): Promise<Record<string, unknown>> {
  const tdx: Record<string, unknown> = {
    test_type: 'tdx_validation',
    cpu_support: false,
    bios_enabled: false,
    module_present: false,
    seam_status: 'unknown',
    attestation_capable: false,
  };

  const cpuinfo = await readFileQuiet('/proc/cpuinfo');
  if (cpuinfo && cpuinfo.toLowerCase().includes('tdx')) {
    tdx['cpu_support'] = true;
  }

  try {
    const { stdout, exit_code } = await run('lscpu', [], { timeout_ms: 30_000 });
    if (exit_code === 0 && stdout.toLowerCase().includes('tdx')) {
      tdx['cpu_support'] = true;
    }
  } catch (error) {
    logger.debug('lscpu tdx probe failed', { error: String(error) });
  }

  try {
    const { stdout, exit_code } = await run('dmesg', [], { timeout_ms: 30_000 });
    if (exit_code === 0) {
      const lower = stdout.toLowerCase();
      if (lower.includes('tdx') && lower.includes('enabled')) {
        tdx['bios_enabled'] = true;
        tdx['seam_status'] = lower.includes('seam') ? 'active' : 'unknown';
      }
    }
  } catch (error) {
    logger.debug('dmesg tdx probe failed', { error: String(error) });
  }

  const tdxSys = await fileExists('/sys/firmware/tdx');
  const tdxProc = await fileExists('/proc/tdx');
  if (tdxSys || tdxProc) {
    tdx['module_present'] = true;
  }

  if (tdx['cpu_support'] && tdx['bios_enabled']) {
    tdx['overall_status'] = 'ready';
    tdx['attestation_capable'] = true;
  } else if (tdx['cpu_support']) {
    tdx['overall_status'] = 'capable_but_disabled';
  } else {
    tdx['overall_status'] = 'not_supported';
  }

  return tdx;
}

async function testAmdSev(): Promise<Record<string, unknown>> {
  const sev: Record<string, unknown> = { support: false, enabled: false };

  const cpuinfo = await readFileQuiet('/proc/cpuinfo');
  if (cpuinfo) {
    const lower = cpuinfo.toLowerCase();
    if (lower.includes('amd') && lower.includes('sev')) {
      sev['support'] = true;
    }
  }

  if (await fileExists('/dev/sev')) {
    sev['enabled'] = true;
  }

  const modules = await readFileQuiet('/proc/modules');
  if (modules && modules.toLowerCase().includes('sev')) {
    sev['enabled'] = true;
  }

  return sev;
}

async function testIntelSgx(): Promise<Record<string, unknown>> {
  const sgx: Record<string, unknown> = { support: false, enabled: false };

  const cpuinfo = await readFileQuiet('/proc/cpuinfo');
  if (cpuinfo && cpuinfo.toLowerCase().includes('sgx')) {
    sgx['support'] = true;
  }

  if (await fileExists('/dev/sgx_enclave')) {
    sgx['enabled'] = true;
  }

  return sgx;
}

async function testArmCca(): Promise<Record<string, unknown>> {
  const cca: Record<string, unknown> = { support: false, enabled: false };

  const cpuinfo = await readFileQuiet('/proc/cpuinfo');
  if (cpuinfo) {
    const lower = cpuinfo.toLowerCase();
    if (lower.includes('arm') || lower.includes('aarch64')) {
      if (lower.includes('cca') || lower.includes('realm')) {
        cca['support'] = true;
      }
    }
  }

  if (await fileExists('/sys/firmware/arm_cca')) {
    cca['enabled'] = true;
  }

  return cca;
}

async function testTeeCapabilities(): Promise<Record<string, unknown>> {
  return {
    test_type: 'tee_validation',
    amd_sev: await testAmdSev(),
    intel_sgx: await testIntelSgx(),
    arm_cca: await testArmCca(),
  };
}

async function testTpmFunctionality(): Promise<Record<string, unknown>> {
  const tpm: Record<string, unknown> = { present: false, functional: false };

  const tpm0 = await fileExists('/dev/tpm0');
  const tpmrm0 = await fileExists('/dev/tpmrm0');
  tpm['present'] = tpm0 || tpmrm0;

  if (tpm['present']) {
    try {
      const { stdout, exit_code } = await run('tpm2_getcap', ['properties-fixed'], {
        timeout_ms: 30_000,
      });
      if (exit_code === 0 && stdout) {
        tpm['functional'] = true;
        tpm['capabilities'] = stdout;
      }
    } catch (error) {
      logger.debug('tpm2_getcap probe failed', { error: String(error) });
    }
  }

  tpm['overall_status'] = tpm['functional'] ? 'pass' : tpm['present'] ? 'present_not_functional' : 'not_present';

  return tpm;
}

async function testSecureBootStatus(): Promise<Record<string, unknown>> {
  const sb: Record<string, unknown> = { enabled: false };

  try {
    const { stdout, exit_code } = await run('mokutil', ['--sb-state'], { timeout_ms: 30_000 });
    if (exit_code === 0) {
      if (stdout.toLowerCase().includes('secureboot enabled')) {
        sb['enabled'] = true;
      }
      sb['mokutil_output'] = stdout;
    }
  } catch (error) {
    logger.debug('mokutil sb-state probe failed', { error: String(error) });
  }

  if (!sb['enabled']) {
    const efiPath = '/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';
    if (await fileExists(efiPath)) {
      try {
        const { stdout, exit_code } = await run('sh', ['-c', `xxd -p ${efiPath} | tr -d '\\n'`], {
          timeout_ms: 10_000,
        });
        if (exit_code === 0 && stdout && stdout.length >= 10 && stdout.slice(-2) === '01') {
          sb['enabled'] = true;
        }
      } catch (error) {
        logger.debug('secureboot efivar read failed', { error: String(error) });
      }
    }
  }

  sb['overall_status'] = sb['enabled'] ? 'enabled' : 'disabled';
  return sb;
}

async function testMemoryEncryption(): Promise<Record<string, unknown>> {
  const enc: Record<string, unknown> = {
    tme_support: false,
    mktme_support: false,
    sme_support: false,
  };

  const cpuinfo = await readFileQuiet('/proc/cpuinfo');
  if (cpuinfo) {
    const lower = cpuinfo.toLowerCase();
    if (lower.includes('tme')) enc['tme_support'] = true;
    if (lower.includes('mktme')) enc['mktme_support'] = true;
    if (lower.includes('sme')) enc['sme_support'] = true;
  }

  const crypto = await readFileQuiet('/proc/crypto');
  enc['crypto_modules_loaded'] = !!(crypto && crypto.length > 0);

  enc['tpm_backed'] = await fileExists('/sys/kernel/security/tpm0');

  const hasEncryption = Boolean(enc['tme_support']) || Boolean(enc['mktme_support']) || Boolean(enc['sme_support']);
  enc['overall_status'] = hasEncryption ? 'pass' : 'not_detected';

  return enc;
}

async function testCertificateChain(): Promise<Record<string, unknown>> {
  const cert: Record<string, unknown> = { test_type: 'certificate_validation' };

  try {
    const { stdout, exit_code } = await run('openssl', ['version'], { timeout_ms: 10_000 });
    if (exit_code !== 0) {
      cert['openssl_available'] = false;
      cert['status'] = 'unavailable';
      return cert;
    }
    cert['openssl_available'] = true;
    cert['openssl_version'] = stdout.trim();
  } catch {
    cert['openssl_available'] = false;
    cert['status'] = 'unavailable';
    return cert;
  }

  try {
    const { stdout, exit_code } = await run(
      'sh',
      [
        '-c',
        "openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt 2>/dev/null || openssl verify -CAfile /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt 2>/dev/null || echo 'no_ca_bundle_found'",
      ],
      { timeout_ms: 30_000 },
    );
    if (exit_code === 0) {
      if (stdout.includes('no_ca_bundle_found')) {
        cert['ca_bundle'] = 'not_found';
      } else if (stdout.toLowerCase().includes('ok')) {
        cert['ca_bundle'] = 'valid';
      } else {
        cert['ca_bundle'] = 'unknown';
      }
    } else {
      cert['ca_bundle'] = 'error';
    }
  } catch {
    cert['ca_bundle'] = 'error';
  }

  cert['status'] = cert['ca_bundle'] === 'valid' ? 'pass' : 'info';
  return cert;
}

export function registerSecurityTest(): void {
  registerOperation('test.security', async () => {
    const startTime = new Date().toISOString();

    const tdx = await testTdxCapability();
    const tee = await testTeeCapabilities();
    const tpm = await testTpmFunctionality();
    const secureBoot = await testSecureBootStatus();
    const memoryEncryption = await testMemoryEncryption();
    const certificates = await testCertificateChain();

    const endTime = new Date().toISOString();

    let activeFeatures = 0;
    let totalChecks = 0;

    for (const section of [tdx, tpm, secureBoot, memoryEncryption]) {
      totalChecks += 1;
      const overall = section['overall_status'];
      const legacy = section['status'];
      const status = typeof overall === 'string' ? overall : typeof legacy === 'string' ? legacy : '';
      if (status === 'ready' || status === 'pass' || status === 'enabled') {
        activeFeatures += 1;
      }
    }

    for (const sub of [tee['amd_sev'], tee['intel_sgx'], tee['arm_cca']]) {
      totalChecks += 1;
      if (
        sub &&
        typeof sub === 'object' &&
        (('enabled' in sub && Boolean(sub.enabled)) || ('support' in sub && Boolean(sub.support)))
      ) {
        activeFeatures += 1;
      }
    }

    return {
      security: {
        test_type: 'security_validation',
        start_time: startTime,
        tdx,
        tee,
        tpm,
        secure_boot: secureBoot,
        memory_encryption: memoryEncryption,
        certificates,
        end_time: endTime,
        overall_status: activeFeatures > 0 ? 'pass' : 'info',
        active_features: activeFeatures,
        total_checks: totalChecks,
      },
    };
  });
}
