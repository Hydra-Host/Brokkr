import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import { registerOperation } from '../../dispatch/registry';

const DEFAULT_CHECK_URL = 'https://icanhazip.com';
const SIMULATION_CHECK_URL = 'local-simulation';
const REQUEST_TIMEOUT_MS = 3_000;

function simulationEnabled(): boolean {
  return (process.env.LOCAL_SIMULATION_ENABLED ?? '').toLowerCase() === 'true';
}

async function fetchIp(family: 4 | 6, urlStr: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      resolve(null);
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      resolve(null);
      return;
    }

    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = httpsRequest(
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        family,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Host: url.host },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done(null);
          return;
        }
        res.setEncoding('utf-8');
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => done(body.trim()));
        res.on('error', () => done(null));
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

export function registerPublicIpCollector(): void {
  registerOperation('collection.public_ip', async (input) => {
    if (simulationEnabled()) {
      return { public_ip: { ipv4: null, ipv6: null, check_url: SIMULATION_CHECK_URL } };
    }
    const check_url = input.check_url ?? DEFAULT_CHECK_URL;
    const [ipv4, ipv6] = await Promise.all([fetchIp(4, check_url), fetchIp(6, check_url)]);
    return { public_ip: { ipv4, ipv6, check_url } };
  });
}
