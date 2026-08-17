# Licensing

This repository is open-sourced under the **Apache License 2.0** (see [`LICENSE`](./LICENSE)).
The same license applies to every app and package in the repo, except where explicitly
marked proprietary (below).

## Adding a new package

- **Open-source package** → set `"license": "Apache-2.0"` in its `package.json` and include an
  Apache-2.0 `LICENSE` file (copy the root `LICENSE`).
- **Proprietary / not-open-source package** (e.g. a closed plugin, or `@hydrahost/managed-edition`)
  → set `"license": "UNLICENSED"` and `"private": true`, do **not** add an Apache `LICENSE` file,
  and ensure it is **excluded from the public sync** so it never ships in the open-source build.

## Closed-source plugins are allowed

Apache-2.0 is permissive (no copyleft). You can build **proprietary, closed-source plugins** on top
of the Apache-licensed plugin SDK (`@hydrahost/plugin-sdk`, `@hydrahost/plugin-runtime`) without
open-sourcing them. Apache's obligations (preserve the license text + `NOTICE`) apply only when
**redistributing the SDK itself** — not to a plugin that merely depends on it. Mark such a plugin
proprietary per the rule above.

## Third-party dependencies

[`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md) aggregates the licenses of bundled
**production** dependencies. It is generated — do not edit it by hand. Regenerate with:

```sh
pnpm licenses:third-party
```

Dependency licenses flagged "needing review" (Unknown / MPL-2.0 / CC-BY-4.0 / Python-2.0) are
tracked for review. CI enforces an explicit allowlist via `pnpm licenses:check`
(`scripts/generate-third-party-licenses.mjs --check`): any prod-dependency license outside the
allowlist (notably GPL/AGPL/LGPL/SSPL or an unresolved "Unknown"), or drift of
`THIRD-PARTY-LICENSES.md` from `pnpm-lock.yaml`, fails the pipeline.

### Scope: the GPL prohibition covers npm dependencies, not bundled boot artifacts

The allowlist applies to **npm production dependencies resolved from `pnpm-lock.yaml`** — that is
the only thing `pnpm licenses:check` reads. It does not see the third-party **boot artifacts** the
bridge ships (GNU GRUB, iPXE, static curl), which are built from upstream source or redistributed
as upstream release binaries rather than installed by pnpm.

Bundled boot artifacts are a separate category and GPL is **permitted** there — GRUB is
GPL-3.0-or-later and iPXE is GPL-2.0-or-later. Each is enumerated in [`NOTICE`](./NOTICE) with its
upstream project, license, pinned version, our modifications and their paths, and a written offer
for the corresponding source. Add any new bundled boot artifact to that section. The npm rule above
is unchanged: a GPL/AGPL/LGPL/SSPL **npm** dependency still fails the pipeline.

## Python dependencies (apps/local-sim)

`apps/local-sim` is Apache-2.0 (`pyproject.toml` `[project].license`). Its runtime deps are
license-compatible with Apache-2.0 redistribution; verified posture per dependency:

| Dependency           | License      | Compatible | Note                                                     |
| -------------------- | ------------ | ---------- | -------------------------------------------------------- |
| virtualbmc           | Apache-2.0   | yes        | OpenStack project                                        |
| pyghmi               | Apache-2.0   | yes        | OpenStack project; vendored patch under patches/         |
| sushy-tools          | Apache-2.0   | yes        | OpenStack project                                        |
| psycopg[binary]      | LGPL-3.0     | yes        | used as an unmodified library; no LGPL source is shipped |
| redis                | MIT          | yes        |                                                          |
| pydantic / -settings | MIT          | yes        |                                                          |
| pyyaml               | MIT          | yes        |                                                          |
| jinja2               | BSD-3-Clause | yes        |                                                          |
| click                | BSD-3-Clause | yes        |                                                          |
| rich                 | MIT          | yes        |                                                          |
| termcolor            | MIT          | yes        |                                                          |

`psycopg` is LGPL-3.0: we depend on it as an unmodified library (dynamic use), which the LGPL
permits without copylefting our code; we do not redistribute a modified psycopg. The dev-only
group (pytest, ruff) is not shipped. No MPL/Python-2.0/Unknown deps are present
in the local-sim tree.

## Legal sign-off

> **PENDING LEGAL — NOT YET APPROVED.** The items below require counsel sign-off before the
> OSS release. Do not treat this section as an approval; replace it with the signed record
> (approver, date) once obtained.

Counsel must confirm:

- The repository's **Apache-2.0** license is approved for the OSS release.
- The **dompurify Apache-2.0 election** (from `MPL-2.0 OR Apache-2.0`) is acceptable.
- The **MPL-2.0** and **CC-BY-4.0** obligation handling recorded in `THIRD-PARTY-LICENSES.md`
  satisfies the attribution / source-availability requirements.
- The `@mapbox/jsonlint-lines-primitives` MIT resolution — currently noted "Confirm at publish"
  in `scripts/generate-third-party-licenses.mjs` — is confirmed.
