# Logging, Data Handling & Retention

This note documents the categories of identifiers Brokkr writes to application
logs, the legal basis for processing them, and the operator's retention
obligations. It is intended for operators deploying Brokkr and for the
privacy/legal review that precedes a release.

> **Sign-off status: PLACEHOLDER — requires privacy/legal/DPO sign-off.** This
> document records the engineering view of what is logged. It is **not** a final
> compliance determination. A data protection officer or equivalent must review
> and record sign-off before relying on it for a GDPR retention posture.

## Logged identifier categories

Brokkr logs are dominated by machine/device identifiers (device IDs, zone IDs,
boot IDs, token contexts), which are not personal data. The two categories below
carry some personal-data relevance and are called out explicitly.

| Category                         | Where                                                                                            | Personal data?                                | Basis                                    | Notes                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| Client IP address                | `apps/api` zone-crypto enrollment audit (`zone-crypto.service.ts`, `logRejection`/enrollment-ok) | Yes (GDPR)                                    | Legitimate interest (security telemetry) | Intentional per-token brute-force audit trail for SIEM grouping. |
| BMC/IPMI account username        | `apps/bridge` Redfish password-reset flow (`redfish/handlers/boot.ts`)                           | No (device-account name, e.g. `root`/`admin`) | Operational diagnostics                  | Device-administration account name, not a customer identity.     |
| Device / zone / token / boot IDs | `apps/api` (e.g. `device-tokens.service.ts` `context=…`), `apps/bridge`                          | No                                            | Operational diagnostics                  | Machine identifiers, not personal data.                          |

The `device-tokens.service.ts` log lines key on `context=${token.context}` —
token/device identifiers, not personal data. Client IPs handled by that service
go to structured audit events rather than these warn/log lines.

## Legitimate-interest basis

The client-IP logging in zone-crypto enrollment is deliberate security
telemetry: every rejection branch emits a stable, SIEM-groupable reason plus the
source IP so that an attacker brute-forcing enrollment tokens leaves a per-token
audit trail. For a hosting/BMC product this is an accepted security-logging
practice with a strong legitimate-interest basis under GDPR Art. 6(1)(f), and is
therefore retained in full rather than truncated/hashed.

## Retention

Application-log retention is an **operator responsibility**: Brokkr does not
itself enforce a retention window. Operators must configure their log pipeline
to retain these records only as long as needed for the security/diagnostic
purpose above and to comply with applicable law.

- **Default posture:** logs are emitted to the operator's own sink; Brokkr
  ships no managed log retention.
- **Operator action required:** set a documented retention window for logs
  containing the categories above, and apply it in your log store.

## Log destinations & DPA

Brokkr writes logs to the operator-configured sink. Operators must **confirm
that application logs are not shipped to any public or unauthenticated sink, and
not to any third-party processor without a Data Processing Agreement (DPA)** in
place. Running at debug/verbose level may emit additional event metadata; treat
such logs as sensitive and restrict access accordingly (see `SECURITY.md`).

## Data-minimization options (deferred to compliance)

If a privacy review concludes full-IP retention is not required for the SIEM use
case, the client IP in zone-crypto rejection logs could be truncated or hashed;
the BMC `UserName` in `boot.ts` could be dropped (marginal diagnostic value).
These are optional and are **not** applied by default, because the audit-trail
rationale argues for retaining the source IP.

## Pre-publish checklist

- [ ] Retention window for logs containing client IPs / device-account names is
      documented and configured in the operator's log store.
- [ ] Confirmed application logs are not shipped to a public/third-party sink
      without a DPA.
- [ ] Privacy/legal/DPO sign-off on the GDPR retention posture recorded
      (replacing the PLACEHOLDER above).
