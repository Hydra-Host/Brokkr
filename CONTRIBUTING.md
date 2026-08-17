# Contributing to Brokkr

Thanks for your interest in contributing to Brokkr! This guide covers the
general contribution workflow for the public GitHub repository. By
participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

- Reporting a security vulnerability? Do **not** open a public issue — follow
  the [Security Policy](./SECURITY.md) instead.
- Writing a plugin? See [CONTRIBUTING-PLUGINS.md](./CONTRIBUTING-PLUGINS.md)
  for the plugin authoring and submission workflow.

## Contribution Workflow

Brokkr uses the standard GitHub fork-and-pull-request flow:

1. **Fork** the repository on GitHub to your own account.
2. **Clone** your fork and add the upstream repository as a remote:
   ```bash
   git clone git@github.com:<your-username>/Brokkr.git
   cd Brokkr
   git remote add upstream git@github.com:Hydra-Host/Brokkr.git
   ```
3. **Create a branch** off the default branch for your change:
   ```bash
   git checkout -b feat/my-change
   ```
4. **Make your change**, including tests and documentation where appropriate.
5. **Run the quality gates** locally (see below) and make sure they pass.
6. **Commit** using Conventional Commits (see below) and **push** to your fork.
7. **Open a pull request** against the upstream default branch. Describe what
   the change does and why, and link any related issues.

A maintainer will review your PR. Please be responsive to review feedback and
keep PRs focused — smaller, single-purpose PRs are easier to review and merge.

### How accepted contributions land

Worth knowing before you invest effort: this repository is a **mirror** of Hydra
Host's internal monorepo. Each release replaces the mirror's default branch with
a tree derived from the internal branch, so a pull request merged directly here
would be overwritten at the next release.

Accepted contributions are instead back-ported into the internal monorepo, and
reach this repository at the next release as part of that tree. Your authorship
survives the round trip: the back-port carries your commit's `Signed-off-by:`
and `Co-authored-by:` trailers, and the published commit credits every
contributor whose work it includes.

In practice nothing changes about how you contribute — review and discussion
happen on your PR as usual. Just expect your PR to be **closed with a link to
the shipped change** rather than showing as merged.

## Development Setup

Brokkr is a pnpm + [Turborepo](https://turborepo.dev/) monorepo. Full local
environment setup (devenv/Nix toolchain, datastores, and the simulator fleet)
is documented in the [README](./README.md). For most code contributions you
need Node.js `>=22.12 <25` (the `engines` range in `package.json`) and the
repo's pinned pnpm version (`pnpm@8.15.9`, also declared there):

```bash
pnpm install
```

## Quality Gates

Run these from the repo root before opening a PR. `build`, `lint`, `typecheck`,
and `test` are the same commands the GitHub Actions workflow runs on your pull
request, orchestrated across the workspace by Turborepo:

```bash
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint
pnpm test        # Unit tests (Vitest)
pnpm build       # Build every app and package
pnpm format      # Auto-format the tree (treefmt)
```

Please make sure `typecheck`, `lint`, and `test` are green before requesting
review. `pnpm format` is not a CI gate; run it so your diff carries no
formatting noise.

## Commit & PR Conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint (`commitlint.config.mjs`). Use one of the allowed
types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. The commit header must be **100 characters or fewer**.

Examples:

```
feat(api): add zone reassignment endpoint
fix(web): correct deployment status polling interval
docs: clarify spoke bootstrap steps
```

PR titles should follow the same convention. Keep the PR description clear
about the motivation and the change.

Every commit must also carry a [Developer Certificate of
Origin](https://developercertificate.org/) sign-off — a `Signed-off-by:`
trailer certifying you have the right to submit the code under the
project's license. Where the DCO check app is enabled it enforces this on
every pull request; sign off regardless, because a maintainer cannot accept
an unsigned commit.

Rather than remembering `git commit -s` every time, configure your clone to
add the trailer automatically with a `prepare-commit-msg` hook:

```bash
cat > .git/hooks/prepare-commit-msg <<'EOF'
#!/bin/sh
NAME=$(git config user.name)
EMAIL=$(git config user.email)
git interpret-trailers --if-exists doNothing \
  --trailer "Signed-off-by: $NAME <$EMAIL>" --in-place "$1"
EOF
chmod +x .git/hooks/prepare-commit-msg
```

The hook is idempotent — it won't duplicate the trailer on `--amend` or on
commits you already signed with `-s`.

The DCO attests per-commit _provenance_; it is separate from the one-time
Contributor License Agreement below, which grants Hydra Host _rights_ to
your contribution — both are required.

## Release / SBOM

A Software Bill of Materials (SBOM) can be generated on demand in CycloneDX
format directly from the installed dependency tree:

```bash
npx @cyclonedx/cyclonedx-npm --output-file bom.cdx.json
```

We intentionally **do not commit a generated SBOM** to the repository — a
static SBOM goes stale as soon as dependencies change. Generate it on demand
(or as a release-pipeline artifact) from the current dependency tree instead.

## License and Contributor License Agreement

Brokkr is licensed under the [Apache License 2.0](./LICENSE). See
[LICENSING.md](./LICENSING.md) for details on per-package licensing.

Before your first contribution can be merged, you must sign the
[Hydra Host Individual Contributor License Agreement](./cla/individual.md).
This is automated: when you open your first pull request, the CLA Assistant
bot comments with instructions, and you sign by replying with the requested
statement. You retain full ownership of your contributions — the CLA grants
Hydra Host a license to distribute and build upon your work.

If you are contributing on behalf of a company, the company should also
execute the [Corporate CLA](./cla/corporate.md) — see
[cla/README.md](./cla/README.md) for the full details.
