import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NomadConfig } from '../../schemas';
import {
  BRIDGE_SERVICES_JOBSPEC_ID,
  BRIDGE_SERVICES_SAMPLE_VARIABLES,
  getJobspecPath,
  loadJobspec,
} from '../jobspecs';
import { NomadClient } from '../nomad.client';
import { NomadJobsService } from '../nomad-jobs.service';

const FORBIDDEN = [
  /hydra\.host/i,
  /registry\.gitlab\.com\/hydrahost/i,
  /brokkr\/data\//,
  /pki\/brokkr/,
  /vault\s*\{/,
];

const config: NomadConfig = {
  address: 'http://nomad.test:4646',
  token: 'test-acl-token',
  namespace: 'default',
  timeoutMs: 5_000,
  tlsSkipVerify: false,
};

function nomadBinaryAvailable(): boolean {
  try {
    execFileSync('nomad', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('bridge-services jobspec', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the primary shipped HCL with a literal job label and required variables', () => {
    const hcl = loadJobspec(BRIDGE_SERVICES_JOBSPEC_ID);
    expect(hcl).toMatch(/^job "[a-z0-9-]+" \{/m);
    expect(hcl).not.toContain('job "${var.job_name}"');
    expect(hcl).toContain('variable "datacenter"');
    expect(hcl).toContain('variable "bridge_api_image"');
    expect(hcl).toContain('HOST           = "0.0.0.0"');
    expect(hcl).not.toContain('task "nginx"');
  });

  it('contains no Hydra registry, hostname, or Vault mount strings', () => {
    const hcl = loadJobspec();
    for (const pattern of FORBIDDEN) {
      expect(hcl, `matched ${pattern}`).not.toMatch(pattern);
    }
  });

  it('rejects unknown jobspec ids before touching the filesystem', () => {
    expect(() => loadJobspec('../../etc/passwd')).toThrow(/Unknown shipped jobspec id/);
  });

  it('overrides Job.ID from variables.job_name and strips job_name from Nomad Variables', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/jobs/parse')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ID: 'bridge-services', Name: 'bridge-services', Type: 'system' }),
        };
      }
      if (String(url).includes('/v1/validate/job')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ValidationErrors: null, DriverConfigValidated: true }),
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new NomadJobsService(new NomadClient(config));
    const result = await service.validate({
      jobspecId: 'bridge-services',
      variables: { ...BRIDGE_SERVICES_SAMPLE_VARIABLES },
    });

    expect(result.status).toBe('ok');
    expect(result.jobId).toBe(BRIDGE_SERVICES_SAMPLE_VARIABLES.job_name);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { JobHCL: string; Variables: string };
    expect(body.JobHCL).toMatch(/^job "bridge-services" \{/m);
    expect(body.Variables).not.toContain('"job_name"');
    expect(body.Variables).toContain(BRIDGE_SERVICES_SAMPLE_VARIABLES.bridge_api_image);
  });

  it.skipIf(!nomadBinaryAvailable())(
    'nomad job run -output parses the shipped HCL with sample variables',
    () => {
      const path = getJobspecPath();
      const vars = [
        `-var=datacenter=${BRIDGE_SERVICES_SAMPLE_VARIABLES.datacenter}`,
        `-var=zone_id=${BRIDGE_SERVICES_SAMPLE_VARIABLES.zone_id}`,
        `-var=bridge_api_image=${BRIDGE_SERVICES_SAMPLE_VARIABLES.bridge_api_image}`,
        `-var=bind_image=${BRIDGE_SERVICES_SAMPLE_VARIABLES.bind_image}`,
        `-var=kea_image=${BRIDGE_SERVICES_SAMPLE_VARIABLES.kea_image}`,
      ];
      const out = execFileSync('nomad', ['job', 'run', '-output', ...vars, path], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(out) as { Job?: { ID?: string; Name?: string } };
      expect(parsed.Job?.ID ?? parsed.Job?.Name).toBe('bridge-services');
    },
  );
});
