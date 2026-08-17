#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');

const CONTAINER = 'brokkr-otel-lgtm';
const IMAGE = 'grafana/otel-lgtm';
const GRAFANA_PORT = 3200;
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;

function docker(args, opts = {}) {
  const out = execFileSync('docker', args, { encoding: 'utf8', ...opts });
  return out === null ? '' : out.trim();
}

function isRunning() {
  const out = spawnSync('docker', ['ps', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  return out.stdout.trim() === CONTAINER;
}

async function waitFor(url, label, { attempts = 60, anyResponse = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      // anyResponse: the OTLP receiver answers GET /v1/traces with 405 by design — any response proves the listener is up.
      if (anyResponse || res.ok) return;
    } catch (error) {
      console.warn(`${label} readiness check failed:`, error.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function pushDashboards() {
  const dir = join(__dirname, '..', 'dashboards');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const auth = {
    Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64'),
    'Content-Type': 'application/json',
  };
  for (const file of files) {
    const dashboard = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    delete dashboard.id;
    const res = await fetch(`http://127.0.0.1:${GRAFANA_PORT}/api/dashboards/db`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ dashboard, overwrite: true, message: `imported from ${file}` }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`dashboard import failed for ${file}: ${JSON.stringify(body)}`);
    console.log(`  dashboard: http://localhost:${GRAFANA_PORT}${body.url}  (${file})`);
  }
}

async function up() {
  if (isRunning()) {
    console.log(`${CONTAINER} already running`);
  } else {
    console.log(`starting ${IMAGE} (first run pulls ~a few GB — be patient)...`);
    docker(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        CONTAINER,
        '-p',
        `${GRAFANA_PORT}:3000`,
        '-p',
        `${OTLP_GRPC_PORT}:4317`,
        '-p',
        `${OTLP_HTTP_PORT}:4318`,
        IMAGE,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }
  process.stdout.write('waiting for Grafana + OTLP receiver...\n');
  await waitFor(`http://127.0.0.1:${GRAFANA_PORT}/api/health`, 'Grafana');
  await waitFor(`http://127.0.0.1:${OTLP_HTTP_PORT}/v1/traces`, 'OTLP/HTTP receiver', { anyResponse: true });
  console.log('ready.');
  await pushDashboards();
  console.log(`
  Grafana:   http://localhost:${GRAFANA_PORT}  (admin/admin)
  OTLP:      http://127.0.0.1:${OTLP_HTTP_PORT}  (http/protobuf)

point the hub at it:
  OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${OTLP_HTTP_PORT} pnpm dev
`);
}

function down() {
  if (!isRunning()) {
    console.log(`${CONTAINER} not running`);
    return;
  }
  docker(['stop', CONTAINER]);
  console.log('stopped (container was --rm, data discarded)');
}

function status() {
  console.log(
    isRunning() ? `${CONTAINER} running — Grafana at http://localhost:${GRAFANA_PORT}` : `${CONTAINER} not running`,
  );
}

const command = process.argv[2];
const run = { up, down, status, dashboards: pushDashboards }[command];
if (!run) {
  console.error('usage: lgtm.cjs <up|down|status|dashboards>');
  process.exit(2);
}
Promise.resolve(run()).catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
