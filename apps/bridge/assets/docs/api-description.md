# {{ api_title }}

Bare metal infrastructure management API deployed globally across datacenters. Each bridge instance provides unified control over hardware discovery, OS provisioning, out-of-band management, and network boot orchestration.

## Authentication

Production endpoints are served over HTTPS with server-certificate validation. The bridge presents a certificate signed by the zone trust chain; clients must trust the CA bundle distributed with the bridge deployment.

## Job Tracking

Include a job ID header to correlate related operations across requests:

```http
x-brokkr-job-id: YOUR_JOB_ID
```

The API also accepts `job_id` as a query parameter or in the request body.

## Deployment Modes

Bridges run in one of three modes depending on the datacenter configuration:

- **Full** — All capabilities: lifecycle, OOB, network boot, monitoring
- **Primary** — Lifecycle and network boot without OOB management
- **OOB** — Out-of-band management only (IPMI, Redfish, SOL, virtual media)
