# Security Policy

We take the security of Brokkr seriously. Brokkr ships cryptographic and
authentication code, so we ask that you report vulnerabilities privately and
responsibly so we can fix them before they are disclosed publicly.

## Reporting a Vulnerability

**Please do not open a public issue or pull request for security
vulnerabilities.** Disclosing a vulnerability publicly before a fix is
available puts all users at risk.

Instead, report it privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability** (this opens a private GitHub Security
   Advisory draft visible only to you and the maintainers).
3. Describe the issue with enough detail for us to reproduce it:
   - the affected component(s) and version/commit,
   - reproduction steps or a proof of concept,
   - the impact you believe it has, and
   - any suggested remediation, if you have one.

This keeps the report private and lets us collaborate with you on a fix and a
coordinated disclosure timeline through the same advisory thread.

> If you cannot use GitHub's private vulnerability reporting, open a regular
> issue that contains **no vulnerability details** asking a maintainer to open
> a private channel, and we will follow up.

## Response Targets

We aim to:

- **Acknowledge** your report within **3 business days**.
- Provide an **initial assessment** (severity and triage) within **7 business
  days**.
- Keep you informed of remediation progress and coordinate a disclosure date
  once a fix is available.

These are targets, not contractual guarantees; complex issues may take longer.

## Supported Versions

Brokkr is under active development and is released from the default branch.
Security fixes are applied to the latest released version on that branch.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

If you are running an older build, please update to the latest release before
reporting, and confirm the issue still reproduces.

## Coordinated Disclosure

We follow a coordinated disclosure model: we will work with you to understand
and fix the issue, and we ask that you give us a reasonable opportunity to
release a fix before any public disclosure. With your consent, we are happy to
credit you in the published advisory.

## Dependency Vulnerability Triage

This repository commits a single `pnpm-lock.yaml` (the regression baseline). Audit the
dependency tree with:

```bash
pnpm audit --audit-level=high --prod   # production scope — this is the gating scope
pnpm audit --audit-level=high          # full workspace, including dev chains (informational)
```

Triage policy:

- **Runtime-reachable critical/high advisories** are remediated before release —
  preferably by pinning a fixed transitive version via the `overrides` block in
  `pnpm-workspace.yaml` (the established mechanism), or by upgrading the direct
  dependency.
- **Dev/build-time-only advisories** (test runners, bundlers, lint tooling) that are not
  on the server runtime attack surface are kept out of the gate by **production scope**
  (`--prod`), not by a suppression list. There is no tool-enforced ignore list, and the
  `--prod` scope is the entire allowlisting mechanism. pnpm 11 does support `audit.ignore`,
  but we deliberately do not use it: an ignore list drifts silently, while production scope
  is a property of the dependency graph. We do not chase the full-workspace
  advisory count to zero.
- Because `pnpm audit` queries the **live** advisory database, the tree is re-audited on
  every dependency change, and swept again daily by Hydra Host's internal release
  pipeline. That daily sweep runs upstream of this repository and is not observable from
  it. Together they mean an advisory published mid-flight cannot fail unrelated work,
  while a new advisory against an already-present dependency is still caught within a day.

Maintainers keep the per-advisory disposition of every critical and production-path high
advisory — including runtime-reachability traces — together with a frozen audit snapshot.
If you need the current disposition of a specific advisory, ask through the private
advisory channel above.

## Logging & Sensitive Data

Running the app at debug or verbose log level may emit event metadata, so treat
debug-level logs as sensitive and restrict access accordingly. Webhook delivery
deliberately logs only payload size and delivery metadata so it does not log full
request payloads, nor third-party response bodies or headers.

See [`docs/LOGGING_PRIVACY.md`](docs/LOGGING_PRIVACY.md) for the categories of
identifiers logged (client IPs, BMC account usernames, device/zone/token IDs),
their legitimate-interest basis, retention posture, and the GDPR sign-off
checklist operators must complete before release.

## Secret Scanning

Secrets are scanned at three points:

- **Commit-time** — `gitleaks protect --staged` runs in the pre-commit hook (fast, local).
- **Full working tree** — `task secrets:scan` runs `gitleaks detect` over the whole tree.
- **Full history** — `task secrets:scan:history` scans the entire commit graph across all
  refs. CI runs the same full-history scan on a schedule.

Run `task secrets:scan` before publishing or when in doubt.

## Open/Closed Boundary

Brokkr is open-core. This repository is a filtered mirror of Hydra Host's internal
monorepo: the open BOSS core is published here, and two separate categories are stripped
before publish and never reach this tree. The first is the proprietary managed surface —
the managed-edition package, the standalone admin panel, and the internal deploy/CI
infrastructure. The second is a set of first-party plugins that carry the same Apache-2.0
license as the core but are withheld as a product decision, so the plugin surface here is
a curated subset rather than everything Hydra Host runs.

The filter is a default-deny allowlist. A path is published only if it is listed
explicitly, so an internal directory added upstream stays private by default rather than
leaking. Automated guards run ahead of every publish and fail the release if a package
marked proprietary is not excluded, if a public package hard-depends on an excluded one,
or if internal references appear in a publishable file.

The public source is clean at rest: the managed edition, and every withheld plugin the host
registry installs, load through a guarded optional `require`, so nothing here is redacted or
elided in-file. What you read in this repository is what runs.

If you believe internal or proprietary material has reached this repository, report it
through the private channel above rather than opening a public issue.

### Legal / Compliance Sign-off

The open/closed boundary above — open-sourcing BOSS under Apache-2.0 while retaining
`@hydrahost/managed-edition` (license `UNLICENSED`) as proprietary, redacted from the
public sync — has been reviewed and approved by Hydra Host legal/compliance for the
BOSS open-source release. Any change to the set of proprietary packages or to the
licenses in this repository must be re-reviewed and this note updated before publish.
