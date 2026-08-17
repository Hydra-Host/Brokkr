#!/usr/bin/env node
// Guards the init-before-require contract: if instrumentation ordering breaks, no spans are created and the sink stays empty.
'use strict';

const http = require('http');

async function main() {
  let tracePosts = 0;
  let traceBytes = 0;
  let logPosts = 0;

  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/traces') {
        tracePosts += 1;
        traceBytes += Buffer.concat(chunks).length;
      }
      if (req.method === 'POST' && req.url === '/v1/logs') {
        logPosts += 1;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sinkPort = sink.address().port;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OTEL_')) delete process.env[key];
  }
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${sinkPort}`;
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';

  const telemetry = require('../dist/index.js');
  telemetry.initTelemetry({ serviceName: 'telemetry-smoke', preset: 'hub' });
  if (!telemetry.isTelemetryEnabled()) {
    console.error(`SMOKE FAIL: telemetry not enabled: ${telemetry.getTelemetryStatus().reason}`);
    process.exit(1);
  }

  // Must require express AFTER init so require-patching applies.
  const express = require('express');
  const app = express();
  app.get('/hello', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const appPort = server.address().port;

  const response = await fetch(`http://127.0.0.1:${appPort}/hello`);
  if (!response.ok) {
    console.error(`SMOKE FAIL: express request failed with ${response.status}`);
    process.exit(1);
  }
  await response.json();

  telemetry.emitTelemetryLog('telemetry-smoke', 'info', 'smoke log line', { smoke: true });

  await telemetry.shutdownTelemetry(10_000);
  server.close();
  sink.close();

  const status = telemetry.getTelemetryStatus();
  console.log(
    `sink: ${tracePosts} POST(s) to /v1/traces (${traceBytes} bytes), ${logPosts} POST(s) to /v1/logs; status: ` +
      `succeeded=${status.exportsSucceeded} failed=${status.exportsFailed} spans=${status.spansExported} ` +
      `logsEnabled=${status.logsEnabled} logsSucceeded=${status.logExportsSucceeded} logsFailed=${status.logExportsFailed}`,
  );
  if (tracePosts < 1 || status.spansExported < 1) {
    console.error('SMOKE FAIL: no spans were exported — instrumentation or export path is broken');
    process.exit(1);
  }
  if (status.exportsFailed > 0) {
    console.error(`SMOKE FAIL: export failures recorded (${status.lastErrorMessage ?? 'unknown'})`);
    process.exit(1);
  }
  if (logPosts < 1 || status.logExportsSucceeded < 1 || status.logExportsFailed > 0) {
    console.error(
      `SMOKE FAIL: log records did not reach the sink (${status.lastLogErrorMessage ?? 'no error recorded'})`,
    );
    process.exit(1);
  }
  console.log('SMOKE PASS: spans and log records instrumented and exported over OTLP/HTTP');
  process.exit(0);
}

main().catch((error) => {
  console.error('SMOKE FAIL:', error);
  process.exit(1);
});
