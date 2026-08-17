# Proto contract changelog

Wire-compatibility log for the `brokkr.agent.v1` gRPC contract (`AgentService`,
bridge ↔ agent). External code generators and schema validators should update
in lockstep with entries here. All changes below are additive unless marked
**breaking**; `protocol_version` only bumps on breaking changes.

Keep the Zod envelopes in `packages/bridge-agent-protocol` in sync — the
`proto-zod-drift` test enforces parity for operation payloads, but envelope
fields (e.g. `WorkRequest`) are mirrored by hand.

## 2026-07-17 — agent tracing (protocol_version 1, additive)

- New RPC `AgentService.ReportTraces(TraceBatch) returns (ReportTracesAck)`:
  agent ships a pre-serialized OTLP `ExportTraceServiceRequest`; the bridge
  relays the bytes to its own OTLP endpoint. Best-effort — bridges without
  telemetry drop and ack; old bridges return `UNIMPLEMENTED`, which agents
  treat as a silent drop.
- New messages `TraceBatch { device_id = 1; otlp_traces = 2 }` and
  `ReportTracesAck {}`.
- `WorkRequest` gains W3C trace context: `traceparent = 7`, `tracestate = 8`
  (empty when the dispatching bridge runs with telemetry disabled; agents that
  don't understand tracing ignore both). Mirrored as optional fields on the
  Zod `WorkRequest` envelope.

## Baseline — protocol_version 1

`AgentService` as ported from the Python bridge-api: `OpenSession` (server
stream), `ReportResult`, `ReportProgress`, `ReportPartialResult`,
`FetchBundle` (server stream), `ReportLogs`, `RenewToken`, `PhoneHome`.
Operation payloads ride as JSON-encoded `bytes` validated against
`@repo/bridge-agent-protocol`.
