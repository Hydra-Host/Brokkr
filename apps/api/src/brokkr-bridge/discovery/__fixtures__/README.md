# Discovery Collector Fixtures

Per-collector fixtures used by handler spec tests. Structure:

```
__fixtures__/
  <collector_name>/
    happy-<descriptor>.json     # common-case samples
    edge-<descriptor>.json      # unusual but valid
    malformed-<descriptor>.json # deliberately broken (for resilience tests)
```

Sourced from real prod discovery data pulled via the S3 bucket, see
`.discovery-samples/data/<collector>/<deviceId>.json`. **Never** commit raw
prod fixtures without scrubbing IPs, serials, and BMC credentials first.

## Scrubbing

Before committing:

- IPv4/IPv6 addresses → `10.0.0.1` / `fd00::1`
- Serial numbers → `SERIAL-XXXX`
- BMC IP + MAC → `10.0.0.2` / `02:00:00:00:00:01`
- Any `.uuid` field → regenerate with `uuidgen`
- SMBIOS asset tags stay as-is (usually OEM placeholders anyway)

## Populating

Phase 3 work: for each collector, copy 3 samples from
`.discovery-samples/data/<collector>/` — one common, one edge (e.g. empty
nvidia, polymorphic lldp), one vendor-quirk.
