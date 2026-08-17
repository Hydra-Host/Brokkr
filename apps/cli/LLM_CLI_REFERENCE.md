# Brokkr CLI Reference (for LLM consumption)

This document describes every command, flag, and JSON output shape of the Brokkr CLI. All sorting, searching, and pagination happen server-side via the API. Use `--json` on any list/detail command for machine-readable output.

**Tip:** Run `brokkr docs` from anywhere to print this reference to stdout.

## Invocation

```bash
# Development (from monorepo root)
pnpm --filter @repo/cli dev -- <command> [args] [flags]

# Installed globally
brokkr <command> [args] [flags]
```

All examples below use `brokkr` — substitute `pnpm --filter @repo/cli dev --` in development.

## Prerequisites

You must be authenticated before running commands. There are three ways to authenticate:

### Option 1: Email/Password (interactive)

```bash
brokkr env use <name>            # switch environment (local, brokkr)
brokkr login                     # prompts email, password, optional 2FA
brokkr org select                # pick an organization (skipped if only one)
brokkr whoami                    # verify: shows user, org, environment
```

### Option 2: API Key (via CLI)

```bash
brokkr env use <name>            # switch environment
BROKKR_API_KEY=brk_... brokkr login   # preferred for scripting: key via env, no argv leak
brokkr login -k                  # interactive: prompts for the key (masked)
brokkr login --api-key brk_...   # one-shot, but leaks the key to shell history / ps (warns)
brokkr whoami                    # verify: shows API Key auth + org
```

API keys are org-scoped, so `brokkr org select` is not needed. The key embeds the organization context.

### Option 3: API Key (via config file or environment variable)

For persistent auth that survives `brokkr logout`, add `apiKey` to the environment in `~/.config/brokkr/config.json`:

```json
{
  "activeEnv": "brokkr",
  "environments": {
    "brokkr": {
      "apiUrl": "https://brokkr.hydrahost.com",
      "apiKey": "brk_yourKeyHere"
    }
  }
}
```

For scripting, use the `BROKKR_API_KEY` environment variable (no login needed):

```bash
BROKKR_API_KEY=brk_... brokkr deployments --json
```

**Auth resolution order:** `BROKKR_API_KEY` env var > session file API key > session file cookie > config file API key.

## JSON Output Convention

All list commands return:

```json
{
  "data": [ ... ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 100, "totalPages": 5 }
}
```

All detail commands return the object directly (no wrapper).

Null values are preserved (not omitted) — you can rely on consistent key presence.

**Price fields** (any field ending in `Cents`) are in **cents**. Divide by 100 for dollars. Example: `pricePerHourCents: 10500` = $105.00/hr.

## Global List Flags (all list commands)

| Flag               | Type    | Default | Description                                                               |
| ------------------ | ------- | ------- | ------------------------------------------------------------------------- |
| `--page <N>`       | number  | 1       | Page number (1-indexed)                                                   |
| `--page-size <N>`  | number  | 20      | Items per page (max 100; some endpoints default higher — see per-command) |
| `--sort <expr>`    | string  | —       | Comma-delimited sort expression (see grammar below)                       |
| `--search <query>` | string  | —       | Free-text search, max 200 chars (server-side, case-insensitive)           |
| `--filters <expr>` | string  | —       | Pipe-delimited filter expression (only on supported commands)             |
| `--json`           | boolean | false   | Output machine-readable JSON                                              |

Commands vary in which of these they actually honor. Where a flag is silently ignored, the per-command section says so. Always check the command's entry below or run `brokkr <cmd> --help`.

---

## Filter, Sort, and Search Grammar

These grammars are shared by every endpoint that supports the flag. Per-command sections list which fields are available.

### `--filters`

```
--filters "field:op:value|field:op:value"
```

- **Delimiter**: `|` between tuples (pipe), `:` between `field`, `op`, and `value`.
- **Operators**: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`.
- **Case-sensitivity**: `eq`/`neq`/`contains` on string fields are case-insensitive. Enum values usually match case-insensitively too.
- **Multi-value**: repeating the same field with `eq` OR-combines the values (internally translated to a Prisma `IN` query). Example: `role:eq:Baremetal|role:eq:Decommissioned` returns records matching either role.
- **Multi-field**: different fields AND together. Combined with the rule above, `role:eq:Baremetal|role:eq:DiscoveredHost|gpuCount:gte:4` means "(Baremetal OR DiscoveredHost) AND gpuCount >= 4".
- **Types**: `number` values coerce via `Number()`; `date` values coerce via `new Date()`. Invalid coercions are silently dropped.
- **Unknown fields**: any tuple whose field is not in the resource's filterable-fields list is silently dropped by the API.
- **Values with colons**: preserved — the parser splits on the first two colons only.
- **Inventory exception**: `brokkr inventory` uses a simplified parser that only accepts the `eq` operator. See the inventory section.

### `--sort`

```
--sort "field:dir,field:dir"
```

- **Delimiter**: `,` between pairs, `:` between `field` and `dir`.
- **`dir`**: `asc` (default if omitted) or `desc`.
- **Unknown fields**: dropped; if nothing valid remains, the resource's default sort is applied.
- Some fields are sorted with nulls last (e.g. `hourlyPrice`, `ipv4` on devices) — see per-command notes.

### `--search`

- Free text, max 200 characters. Case-insensitive substring match (`contains`, `mode: insensitive`).
- Matches across a resource-specific list of fields — the result is "field1 contains text OR field2 contains text OR …".
- Some resources also check numeric fields when the search text parses as a number.

### Pagination

- Default `pageSize` is 20 unless noted (inventory defaults to 12; admin device list and reservation invites default to 25).
- Hard max `pageSize` is 100 across all resources.
- Response meta is `{ page, pageSize, totalItems, totalPages }`.

---

## Commands

### `brokkr docs`

Print full CLI reference to stdout. No flags.

### `brokkr completion install [shell]`

Install shell tab completion. Auto-detects your shell from `$SHELL` if the argument is omitted. Supports `bash`, `zsh`, `fish`. Idempotent — re-running is a no-op.

```bash
brokkr completion install          # detects shell, appends to ~/.zshrc / ~/.bashrc, or writes to ~/.config/fish/completions/brokkr.fish
brokkr completion install zsh      # explicit shell
brokkr completion uninstall        # remove
```

After `npm install -g @hydrahost/brokkr-cli` this runs automatically via a postinstall hook. For manual / advanced setups, `brokkr completion script <shell>` prints the raw script to stdout so you can source it yourself (e.g. `eval "$(brokkr completion script zsh)"`).

Restart your shell (or source the rc file) to activate. Press `<Tab>` after `brokkr ` to cycle through commands, subcommands, flags, and known flag values (`--expires-in`, `--role`, `--sort`, `--action`).

### `brokkr env list`

List all configured environments. No flags.

### `brokkr env use <name>`

Switch active environment. Argument: environment name (e.g., `local`, `brokkr`).

### `brokkr login [options]`

Authenticate with your Brokkr account.

| Flag                  | Type              | Description                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-k, --api-key [key]` | string (optional) | Log in with an API key instead of email/password. If `key` is omitted, reads `BROKKR_API_KEY` or prompts interactively. For scripting, prefer `BROKKR_API_KEY` over an inline key — an inline key leaks into shell history and process listings (`ps`), and triggers a warning. |

**Examples:**

```bash
brokkr login                             # email/password + optional 2FA
BROKKR_API_KEY=brk_abc123 brokkr login   # preferred for scripting: key via env (no argv leak)
brokkr login -k                          # interactive API key prompt (masked)
brokkr login --api-key brk_abc123        # one-shot, but leaks the key to shell history / ps (warns)
```

### `brokkr logout`

Clear session. No flags. Does not remove API keys stored in `config.json`.

### `brokkr whoami [--json]`

Show current authentication method, user/organization, and environment.

**JSON output shape — session auth** (`--json`):

```json
{
  "email": "string",
  "name": "string | null",
  "organization": {
    "id": "string",
    "name": "string",
    "tenantType": "DemandCustomer | SupplyCustomer | Unknown",
    "role": "string | null"
  },
  "environment": "string",
  "apiUrl": "string"
}
```

**JSON output shape — API key auth** (`--json`):

```json
{
  "authMethod": "api-key",
  "organization": {
    "id": "string",
    "name": "string",
    "tenantType": "string"
  },
  "environment": "string",
  "apiUrl": "string"
}
```

Note: `organization` is `null` if no organization is selected (session auth only). In bridge mode, the output shape is `{ "email": "string", "environment": "string", "mode": "bridge" }`.

### `brokkr org select [orgId] [--json]`

Switch the active organization. Interactive mode (no args) shows a picker listing organizations with tenant type and role; one-shot mode takes the organization ID as an argument. `--json` requires the orgId argument (fails fast instead of opening the picker, so non-TTY runs never block). Not available with API key auth (keys are bound to a single organization).

```bash
brokkr org select                       # Interactive picker
brokkr org select <orgId>               # One-shot
brokkr org select <orgId> --json        # Scripted mode
```

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "tenantType": "DemandCustomer | SupplyCustomer | Unknown",
  "role": "string"
}
```

### `brokkr org current [--json]`

Show the active organization (name, tenant type, and role).

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "tenantType": "DemandCustomer | SupplyCustomer | Unknown",
  "role": "string | null"
}
```

Note: In bridge mode, the output shape is `{ "id": "string", "mode": "bridge" }` (no `name`, `tenantType`, or `role` fields).

---

## Deployment Commands

### `brokkr deployments [--page N] [--page-size N] [--project NAME] [--json]`

Alias: `brokkr deploy`

List all deployments for the current organization. The CLI does not expose `--sort`, `--search`, or `--filters` — the server endpoint does not honor them.

- **Client-side filter**: `--project <name>` — case-insensitive substring match on the deployment's project name, applied by the CLI after fetching. Meta counts reflect the filtered result, not the full deployment list.
- **Default order** (CLI-side): project name ascending, then device name ascending.

Example:

```bash
brokkr deployments --project "prod" --json      # client-side filter
```

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "name": "string",
      "project": "string",
      "status": "string",
      "powerStatus": "string",
      "location": "string",
      "gpu": "string",
      "os": "string | null",
      "ipv4": "string | null",
      "sshCommand": "string | null (e.g. ssh ubuntu@66.85.148.90)",
      "isLocked": "boolean",
      "contractType": "string | null (ON_DEMAND, RESERVED, INTERRUPTIBLE)",
      "provisionedDate": "ISO date string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 3, "totalPages": 1 }
}
```

### `brokkr deployments <id> [--json]`

Show detail for a single deployment (includes specs, networking, SSH keys, lifecycle actions, available OS).

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "status": "string",
  "powerStatus": "string",
  "location": "string",
  "isLocked": "boolean",
  "isInterruptible": "boolean",
  "contractType": "string | null",
  "project": { "id": "string", "name": "string", "isDefault": "boolean" },
  "provisionedDate": "ISO date string",
  "rescueOs": "string | null",
  "specs": {
    "os": "string | null",
    "gpu": { "model": "string", "count": "number" },
    "cpu": {
      "model": "string",
      "count": "number",
      "totalCores": "number",
      "totalThreads": "number"
    },
    "memory": { "total": "number (GB)" },
    "storage": {
      "nvmeCount": "number",
      "nvmeSize": "number (bytes)",
      "ssdCount": "number",
      "ssdSize": "number (bytes)",
      "hddCount": "number",
      "hddSize": "number (bytes)",
      "total": "number (bytes)"
    }
  },
  "networking": {
    "ipv4": "string | null",
    "ipv6": "string | null",
    "mac": "string | null",
    "sshCommand": "string | null (e.g. ssh ubuntu@66.85.148.90)"
  },
  "sshKeys": [{ "name": "string", "user": "string" }],
  "lifecycleActions": [
    {
      "actionType": "string (e.g. Provision, Reprovision, Reboot)",
      "performedByName": "string",
      "performedAt": "ISO date string",
      "source": "string (UI, API, System)"
    }
  ],
  "availableBaseLayers": [
    {
      "id": "string",
      "slug": "string (base layer slug, e.g. ubuntu-noble-vanilla)",
      "name": "string",
      "family": "string | null",
      "version": "string | null"
    }
  ],
  "defaultDiskLayouts": [
    {
      "config": "string",
      "format": "string",
      "mountpoint": "string",
      "diskType": "string",
      "disks": ["string"],
      "wipe": "boolean (optional)"
    }
  ]
}
```

Note: `project` is `null` if the deployment has no project. `rescueOs` is `null` when not in rescue mode.

---

### `brokkr deployments:rename [id] [--name <name>] [--json]`

Rename a deployment. Interactive mode prompts for deployment and name.

```bash
brokkr deployments:rename                                    # Interactive
brokkr deployments:rename <id> --name "my-server"            # One-shot
brokkr deployments:rename <id> --name "my-server" --json     # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "name": "string"
}
```

---

### `brokkr deployments:power [id] [--action on|off|cycle] [--force] [--json]`

Power on, off, or hard-cycle a deployment. Interactive mode prompts for deployment and action.

Actions: `on` (IPMI power on), `off` (IPMI power off), `cycle` (hard reset, prompts confirmation unless `--force`).

```bash
brokkr deployments:power                                     # Interactive
brokkr deployments:power <id> --action on                    # Power on
brokkr deployments:power <id> --action off --json            # Power off, JSON
brokkr deployments:power <id> --action cycle --force         # Power cycle, skip confirmation
brokkr deployments:power <id> --action cycle --force --json  # Power cycle, scripted
```

**JSON output shape** (`--json`):

```json
{
  "success": "boolean",
  "errorCode": "string | null (optional — may be omitted when absent)",
  "message": "string | null (optional — may be omitted when absent)"
}
```

---

### `brokkr deployments:rescue [id] [--action activate|deactivate] [--json]`

Activate or deactivate rescue mode. Interactive mode shows current state and prompts.

```bash
brokkr deployments:rescue                                        # Interactive
brokkr deployments:rescue <id> --action activate --json          # Enter rescue mode
brokkr deployments:rescue <id> --action deactivate --json        # Exit rescue mode
```

**JSON output shape** (`--json`): Same as `deployments:power`.

---

### `brokkr deployments:lock [id] [--json]`

Toggle deployment lock. When locked, destructive actions (deprovision, reprovision) are prevented. Interactive mode shows current state and confirms toggle.

```bash
brokkr deployments:lock                                      # Interactive
brokkr deployments:lock <id>                                 # Toggle (one-shot)
brokkr deployments:lock <id> --json                          # Toggle with JSON
```

**JSON output shape** (`--json`): Same as `deployments:power`.

---

### `brokkr deployments:deprovision [id] [--force] [--json]`

Permanently deprovision a deployment. **Irreversible.** Deployment must not be locked.

`--force` skips the confirmation prompt (required for scripted/non-interactive usage).

```bash
brokkr deployments:deprovision                              # Interactive (confirms)
brokkr deployments:deprovision <id>                         # Prompts confirmation
brokkr deployments:deprovision <id> --force                 # Skip confirmation
brokkr deployments:deprovision <id> --force --json          # Scripted mode
```

**JSON output shape** (`--json`): Same as `deployments:power`.

---

### `brokkr deployments:reprovision [id] [--name <name>] [--os <slug>] [--ssh-keys <id,...>] [--disk-layout <json>] [--cloud-init <config>] [--ipxe-url <url>] [--customizations <json>] [--force] [--json]`

Wipe and reinstall OS on a deployment. **Destructive.** Deployment must not be locked.

Interactive mode prompts for name, OS, and SSH keys. Disk layouts default to the deployment's existing configuration.

Flags:

- `--name` — deployment name after reprovision
- `--os` — OS slug (e.g. `ubuntu-noble-vanilla`, `debian-bookworm-vanilla`)
- `--ssh-keys` — comma-separated SSH key UUIDs
- `--disk-layout` — JSON array of disk layout objects (overrides defaults)
- `--cloud-init` — cloud-init YAML string
- `--ipxe-url` — custom iPXE script URL (for `ipxe-custom` OS)
- `--customizations` — layer customizations as JSON object (optional, null = un-customized base)
- `--force` — skip confirmation prompt

```bash
brokkr deployments:reprovision                               # Fully interactive
brokkr deployments:reprovision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force
brokkr deployments:reprovision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json
```

**JSON output shape** (`--json`): Same as `deployments:power`.

---

### `brokkr deployments:projects [--page N] [--page-size N] [--json]`

List deployment projects for the current organization. The CLI does not expose `--sort`, `--search`, or `--filters` — the server endpoint does not honor them.

```bash
brokkr deployments:projects --json
```

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string (UUID)",
      "name": "string",
      "isDefault": "boolean",
      "deploymentCount": "number"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 3, "totalPages": 1 }
}
```

---

### `brokkr deployments:create-project [--name <name>] [--json]`

Create a deployment project. Interactive mode prompts for the name.

```bash
brokkr deployments:create-project                          # Interactive
brokkr deployments:create-project --name "Production"      # One-shot
brokkr deployments:create-project --name "Staging" --json  # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "id": "string (UUID)",
  "name": "string"
}
```

---

### `brokkr deployments:delete-project [id] [--force] [--json]`

Delete a deployment project. The project must not be the default project and must have no deployments assigned.

`--force` skips the confirmation prompt.

```bash
brokkr deployments:delete-project                          # Interactive (pick from list)
brokkr deployments:delete-project <id> --force             # One-shot
brokkr deployments:delete-project <id> --force --json      # Scripted mode
```

**JSON output shape** (`--json`):

```json
{
  "id": "string (UUID)",
  "name": "string"
}
```

---

### `brokkr dcim servers [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--filters <expr>] [--status <status>] [--json]`

List active baremetal servers, or show one by ID.

`--status <status>` is a legacy shortcut for `--filters "status:eq:<status>"`. Use `--filters` for richer queries.

**Filterable fields** (pass via `--filters "field:op:value|..."`):

| Field       | Type   | Operators                             | Notes / Allowed values                                                |
| ----------- | ------ | ------------------------------------- | --------------------------------------------------------------------- |
| `role`      | enum   | `eq`, `neq`                           | `Baremetal`, `DiscoveredHost`, `OffMarketplaceHost`, `Decommissioned` |
| `status`    | string | `eq`, `neq`, `contains`               | Device lifecycle status label                                         |
| `gpuModel`  | string | `eq`, `neq`, `contains`               | e.g. `H100`, `RTX6000`                                                |
| `gpuCount`  | number | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` |                                                                       |
| `memory`    | number | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | Bytes                                                                 |
| `name`      | string | `eq`, `neq`, `contains`               |                                                                       |
| `nickname`  | string | `eq`, `neq`, `contains`               |                                                                       |
| `createdAt` | date   | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | ISO 8601                                                              |

**Sortable fields**: `name`, `nickname`, `status`, `gpuCount`, `memory`, `isListed`, `hourlyPrice` (nulls last), `ipv4` (nulls last), `createdAt`. **Default sort**: `name:asc`. (`gpuModel` is filterable/searchable but not sortable — it's a representative scalar of the GPU relation.)

**Searchable fields**: `id`, `nickname`, `name`, `serial`, `gpuModel`, `cpuModel`.

Examples:

```bash
brokkr dcim servers --filters "role:eq:Baremetal|gpuCount:gte:8" --sort "memory:desc" --json
brokkr dcim servers --filters "gpuModel:contains:H100" --json
brokkr dcim servers --filters "status:eq:Active|status:eq:Maintenance" --json   # OR on same field
brokkr dcim servers --status Active --json                                      # legacy shortcut
```

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "name": "string",
      "ipv4": "string | null",
      "ipv6": "string | null",
      "gpuCount": "number | null",
      "gpuModel": "string | null",
      "cpuModel": "string | null",
      "isListed": "boolean | null",
      "isInterruptibleOnly": "boolean | null",
      "pricePerHourCents": "number | null  (cents — divide by 100 for dollars)",
      "isHealthy": "boolean | null",
      "status": "string",
      "datacenter": "string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 100, "totalPages": 5 }
}
```

### `brokkr dcim servers <id> [--json]`

Show detail for a single server.

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "displayName": "string",
  "status": "string",
  "powerStatus": "string",
  "isHealthy": "boolean | null",
  "ecoMode": "boolean",
  "isTeeCapable": "boolean",
  "datacenter": "string",
  "tenant": "string",
  "gpu": { "model": "string | null", "count": "number | null" },
  "cpu": {
    "model": "string | null",
    "count": "number | null",
    "totalCores": "number | null",
    "totalThreads": "number | null"
  },
  "memory": { "total": "number | null (GB)" },
  "storage": {
    "nvmeCount": "number | null",
    "nvmeSize": "number | null (GB)",
    "ssdCount": "number | null",
    "ssdSize": "number | null (GB)",
    "hddCount": "number | null",
    "hddSize": "number | null (GB)",
    "total": "number | null (GB)"
  },
  "networking": {
    "ipv4": "string | null",
    "ipv6": "string | null",
    "mac": "string | null",
    "ipmiIp": "string | null",
    "vpcCapable": "boolean | null"
  },
  "listing": {
    "isActive": "boolean | null",
    "isInterruptibleOnly": "boolean | null",
    "isPrivate": "boolean | null",
    "onDemandPricePerHourCents": "number | null (cents)",
    "interruptiblePricePerHourCents": "number | null (cents)"
  },
  "deployment": {
    "deployerEmail": "string | null",
    "billingFrequency": "string | null",
    "pricePerHourCents": "number | null (cents)"
  },
  "availableBaseLayers": [
    { "id": "string", "slug": "string", "name": "string", "family": "string | null", "version": "string | null" }
  ],
  "defaultDiskLayouts": [
    {
      "config": "string",
      "format": "string",
      "mountpoint": "string",
      "diskType": "string",
      "disks": ["string"],
      "wipe": "boolean (optional)"
    }
  ]
}
```

Note: `deployment` is `null` if the server has no active deployment.

---

### `brokkr dcim servers:decommission [id] [--force] [--json]`

Decommission a server, removing it from active inventory. The server record is retained for historical reporting. Without `--force`, prompts for confirmation showing the server name.

| Flag      | Type    | Default | Description                                       |
| --------- | ------- | ------- | ------------------------------------------------- |
| `--force` | boolean | false   | Skip confirmation prompt (required for scripting) |
| `--json`  | boolean | false   | Output machine-readable JSON                      |

```bash
brokkr dcim servers:decommission                              # Interactive (pick server, confirm)
brokkr dcim servers:decommission <id>                         # Prompts for confirmation
brokkr dcim servers:decommission <id> --force                 # Skip confirmation
brokkr dcim servers:decommission <id> --force --json          # Scripted mode
```

**JSON output shape** (`--json`):

```json
{
  "success": true
}
```

---

### `brokkr dcim servers:settings [id] [--nickname <name>] [--eco-mode on|off] [--json]`

Update server internal settings (nickname and eco mode). These are viewable only by members of your organization. At least one of `--nickname` or `--eco-mode` must be provided in one-shot mode; otherwise interactive mode prompts for both.

| Flag                 | Type    | Default | Description                                                      |
| -------------------- | ------- | ------- | ---------------------------------------------------------------- |
| `--nickname <name>`  | string  | —       | Device nickname (displayed instead of hardware name in UI)       |
| `--eco-mode <value>` | string  | —       | `on` or `off`. When on, idle (Inventory) machines auto power off |
| `--json`             | boolean | false   | Output machine-readable JSON                                     |

```bash
brokkr dcim servers:settings                                       # Interactive (prompts for both)
brokkr dcim servers:settings <id> --nickname "my-gpu-server"       # Set nickname only
brokkr dcim servers:settings <id> --eco-mode on                    # Enable eco mode only
brokkr dcim servers:settings <id> --nickname "srv" --eco-mode off  # Set both
brokkr dcim servers:settings <id> --nickname "srv" --json          # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "success": true
}
```

---

### `brokkr dcim servers:listing [id] [--hourly-price <USD>] [--floor-price <USD>] [--listed on|off] [--interruptible-only on|off] [--json]`

Update server marketplace listing and pricing. Controls visibility on Brokkr and on-demand/interruptible pricing.

**Important price convention:** `--hourly-price` and `--floor-price` accept **dollars** (e.g. `4.50` = $4.50/hr). The JSON output returns prices in **cents** (e.g. `450` = $4.50/hr). Divide output values by 100 to get dollars.

| Flag                           | Type    | Default   | Description                                                                  |
| ------------------------------ | ------- | --------- | ---------------------------------------------------------------------------- |
| `--hourly-price <price>`       | number  | (current) | On-demand hourly price in USD (must be > 0)                                  |
| `--floor-price <price>`        | number  | (current) | Floor (min interruptible) hourly price in USD (must be > 0, <= hourly price) |
| `--listed <value>`             | string  | (current) | `on` or `off` — whether the server is visible on the marketplace             |
| `--interruptible-only <value>` | string  | (current) | `on` or `off` — whether to only accept interruptible reservations            |
| `--json`                       | boolean | false     | Output machine-readable JSON                                                 |

When flags are partially provided, missing values default to the server's current settings. For example, `--listed off` keeps prices unchanged.

```bash
brokkr dcim servers:listing                                            # Interactive (prompts for all)
brokkr dcim servers:listing <id> --hourly-price 4.50 --listed on       # Set price and list
brokkr dcim servers:listing <id> --hourly-price 4.50 --floor-price 2.50 --listed on --interruptible-only off
brokkr dcim servers:listing <id> --listed off                          # Delist server (prices unchanged)
brokkr dcim servers:listing <id> --hourly-price 5.00 --json            # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "id": "string (UUID)",
  "name": "string",
  "nickname": "string | null",
  "ecoMode": "boolean",
  "status": "string",
  "listing": {
    "isActive": "boolean | null",
    "isInterruptibleOnly": "boolean | null",
    "onDemandPricePerHour": "number | null (cents — divide by 100 for dollars)",
    "interruptiblePricePerHour": "number | null (cents — divide by 100 for dollars)"
  }
}
```

---

### `brokkr dcim servers:provision [id] [--name <name>] [--os <slug>] [--ssh-keys <id,...>] [--disk-layout <json>] [--cloud-init <config>] [--ipxe-url <url>] [--customizations <json>] [--project-id <id>] [--contract-type <type>] [--force] [--json]`

Provision a baremetal server: installs OS, configures network, deploys SSH keys. Interactive mode prompts for name, OS, and SSH keys. Disk layouts default to the server's existing configuration. Required fields for one-shot mode: `--name`, `--os`, `--ssh-keys`, and `--force`.

To discover available OS slugs for a server, run `brokkr dcim servers <id> --json` and check the `availableBaseLayers[].slug` array.

| Flag                      | Type    | Default        | Description                                                                                                                                                                                          |
| ------------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`           | string  | —              | Deployment name (required)                                                                                                                                                                           |
| `--os <slug>`             | string  | —              | OS slug (required). See `availableBaseLayers` on server detail                                                                                                                                       |
| `--ssh-keys <ids>`        | string  | —              | Comma-separated SSH key UUIDs (required)                                                                                                                                                             |
| `--disk-layout <json>`    | string  | server default | JSON array of disk layout objects (see schema below)                                                                                                                                                 |
| `--cloud-init <config>`   | string  | —              | Cloud-init YAML string                                                                                                                                                                               |
| `--ipxe-url <url>`        | string  | —              | Custom iPXE script URL (for `ipxe-custom` OS)                                                                                                                                                        |
| `--customizations <json>` | string  | —              | Layer customizations as JSON object (e.g. `{"gpuDriver":"nvidia-driver-580","miscSoftware":["docker"]}`). Optional, null = un-customized base. See `availableComponentLayersByBase` on server detail |
| `--project-id <id>`       | string  | —              | Project ID to assign the deployment to                                                                                                                                                               |
| `--contract-type <type>`  | string  | —              | `ON_DEMAND`, `INTERRUPTIBLE`, `RESERVED_ROLLING`, or `RESERVED`                                                                                                                                      |
| `--force`                 | boolean | false          | Skip confirmation prompt                                                                                                                                                                             |
| `--json`                  | boolean | false          | Output machine-readable JSON                                                                                                                                                                         |

**`--disk-layout` JSON schema:**

```json
[
  {
    "config": "string (one of: lvm, direct, raid0, raid1, raid5, raid6, raid10, raid50, raid60)",
    "format": "string (e.g. ext4, xfs)",
    "mountpoint": "string (e.g. /, /data)",
    "diskType": "string (e.g. ssd, nvme, hdd)",
    "disks": ["string (disk identifiers)"]
  }
]
```

`direct` partitions only a single disk, leaving all other storage servers unpartitioned. When `direct` is used, the array must contain exactly one entry with `mountpoint: "/"`. Multi-entry payloads that include `direct` are rejected by the hub validator.

```bash
brokkr dcim servers:provision                               # Fully interactive
brokkr dcim servers:provision <id> --name "my-server" --os ubuntu-noble-vanilla --ssh-keys "key1-uuid,key2-uuid" --force
brokkr dcim servers:provision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json
brokkr dcim servers:provision <id> --name "srv" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --disk-layout '[{"config":"lvm","format":"ext4","mountpoint":"/","diskType":"ssd","disks":["disk0","disk1"]}]' --force --json
```

**JSON output shape** (`--json`):

```json
{
  "success": true
}
```

---

### `brokkr dcim decommissioned-servers [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--filters <expr>] [--status <status>] [--json]`

List decommissioned servers, or show one by ID. Same pagination config as `dcim servers`, with the `role` filter pinned to `Decommissioned` server-side.

**Filterable / sortable / searchable fields**: identical to `dcim servers` (role, status, gpuModel, gpuCount, memory, name, nickname, createdAt). See that section for the full table.

**JSON output shape** (`--json`): Same as `brokkr dcim servers --json`.

### `brokkr dcim decommissioned-servers <id> [--json]`

Show detail for a single decommissioned server. Same JSON schema as `brokkr dcim servers <id> --json`.

```bash
brokkr dcim decommissioned-servers --json                         # List all decommissioned servers
brokkr dcim decommissioned-servers --search "RTX" --json          # Search decommissioned servers
brokkr dcim decommissioned-servers <id> --json                    # Get server details
```

---

### `brokkr dcim datacenters [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--json]`

Alias: `brokkr dcim dc`

List data centers (backed by the `zones` entity server-side).

- **Sortable fields**: `name`, `createdAt`. **Default sort**: `name:asc`.
- **Searchable fields** (`--search`): `name`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "name": "string",
      "city": "string | null",
      "stateOrProvince": "string | null",
      "countryCode": "string | null",
      "timezone": "string | null",
      "contactCount": "number",
      "createdAt": "ISO date string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 10, "totalPages": 1 }
}
```

### `brokkr dcim datacenters <id> [--json]`

Show detail for a single data center (includes contacts and bridges).

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "organizationId": "string",
  "primaryAddress": {
    "formattedAddress": "string",
    "city": "string",
    "stateOrProvince": "string | null",
    "countryCode": "string",
    "timezone": "string",
    "latitude": "number",
    "longitude": "number"
  },
  "shippingAddress": { "formattedAddress": "string" },
  "bridges": [{ "id": "string", "name": "string" }],
  "createdAt": "ISO date string",
  "updatedAt": "ISO date string",
  "contacts": [
    {
      "id": "string",
      "name": "string",
      "title": "string",
      "email": "string",
      "phone": "string",
      "contactType": "string",
      "isShippingContact": "boolean"
    }
  ]
}
```

Note: `primaryAddress` and `shippingAddress` can be `null`.

---

### `brokkr dcim bridges [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--filters <expr>] [--json]`

List bridges.

**Filterable fields** (pass via `--filters "field:op:value|..."`):

| Field            | Type   | Operators               | Allowed values           |
| ---------------- | ------ | ----------------------- | ------------------------ |
| `status`         | string | `eq`, `neq`, `contains` |                          |
| `type`           | enum   | `eq`, `neq`             | `managed`, `self-hosted` |
| `datacenterName` | string | `eq`, `neq`, `contains` |                          |
| `zoneName`       | string | `eq`, `neq`, `contains` |                          |

**Sortable fields**: `name`, `status`, `type`, `datacenterName`, `zoneName`. **Default sort**: `name:asc`.

**Searchable fields** (`--search`): `name`, `status`, `type`, `datacenter.name`, `zone.name`.

Example:

```bash
brokkr dcim bridges --filters "type:eq:managed|status:contains:online" --json
```

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "number",
      "name": "string",
      "status": "string",
      "type": "string",
      "datacenterName": "string",
      "zoneName": "string",
      "interfaceCount": "number"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 5, "totalPages": 1 }
}
```

### `brokkr dcim bridges <id> [--json]`

Show detail for a single bridge (includes interfaces).

**JSON output shape** (`--json`):

```json
{
  "id": "number",
  "name": "string",
  "status": "string",
  "type": "string",
  "datacenter": { "id": "number", "name": "string" },
  "zone": { "id": "number", "name": "string", "brokkrId": "string | null" },
  "interfaces": [
    {
      "name": "string",
      "mac_address": "string",
      "ip_addresses": [{ "address": "string" }],
      "enabled": "boolean",
      "mgmt_only": "boolean",
      "mark_connected": "boolean"
    }
  ]
}
```

---

## Organization Commands

### `brokkr org settings [--json]`

Show organization profile (name, type, email, country, dates).

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "name": "string",
  "tenantType": "DemandCustomer | SupplyCustomer",
  "logo": "string | null",
  "email": "string | null",
  "country": "string | null",
  "createdAt": "ISO date string",
  "updatedAt": "ISO date string | null"
}
```

### `brokkr org update-settings [--name <name>] [--email <email>] [--country <country>] [--json]`

Update organization settings. In one-shot mode, only provided flags are changed. Use empty string (`""`) to clear email or country.

- **One-shot**: provide at least one flag
- **Interactive**: omit all flags to be prompted with current values pre-filled

```bash
brokkr org update-settings                                         # Interactive
brokkr org update-settings --name "My Org"                         # Update name only
brokkr org update-settings --email support@example.com             # Update email only
brokkr org update-settings --name "My Org" --email "" --json       # Update name, clear email
```

**JSON output shape** (`--json`): Same as `org settings` (organization object).

---

### `brokkr org members [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--role <role>] [--json]`

List organization members.

`--role <role>` is a legacy single-field filter (exact match). The `--filters` grammar is not supported on this endpoint.

- **Legacy filter flag**: `--role <role>` — exact match (not part of the `--filters` grammar; used instead of it). Common values: `Owner`, `Admin`, `Member`.
- **Sortable fields**: `role`, `name`, `email`, `createdAt`. **Default sort**: `role:asc`, then `name:asc`.
- **Searchable fields** (`--search`): `user.name`, `user.email`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "userId": "string",
      "name": "string | null",
      "email": "string",
      "role": "string",
      "createdAt": "ISO date string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 62, "totalPages": 4 }
}
```

### `brokkr org members <id> [--json]`

Show detail for a single member.

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "userId": "string",
  "organizationId": "string",
  "role": "string",
  "createdAt": "ISO date string",
  "updatedAt": "ISO date string",
  "deletedAt": "ISO date string | null"
}
```

---

### `brokkr org update-member-role [id] [--role <Role>] [--json]`

Update a member's role. Roles: `Admin`, `Member`, `Owner`.

- **One-shot**: provide membership ID and `--role`
- **Interactive**: omit ID to pick from members, omit role to be prompted

```bash
brokkr org update-member-role                                      # Interactive
brokkr org update-member-role <id> --role Admin                    # One-shot
brokkr org update-member-role <id> --role Admin --json             # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "userId": "string",
  "name": "string | null",
  "email": "string",
  "role": "string",
  "createdAt": "ISO date string"
}
```

### `brokkr org remove-member [id] [--json]`

Remove a member from the organization. Interactive mode confirms before removing. One-shot mode (with ID argument) skips confirmation.

- **One-shot**: provide membership ID as argument
- **Interactive**: omit ID to pick from members (with confirmation)

```bash
brokkr org remove-member                                           # Interactive
brokkr org remove-member <id>                                      # One-shot
brokkr org remove-member <id> --json                               # JSON output
```

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "userId": "string",
  "name": "string | null",
  "email": "string",
  "role": "string",
  "createdAt": "ISO date string"
}
```

---

### `brokkr org invite [email] [--role-id <id>] [--json]`

Invite a member to the organization. Supports both one-shot and interactive modes.

- **One-shot**: provide both email and `--role-id`
- **Interactive**: omit email or `--role-id` to select from the active organization’s system and custom roles

```bash
brokkr org invite user@example.com --role-id <role-id>          # one-shot
brokkr org invite user@example.com --role-id <role-id> --json   # one-shot with JSON
brokkr org invite                                              # fully interactive
brokkr org invite user@example.com                             # prompts for role
```

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "email": "string",
  "inviterId": "string",
  "organizationId": "string",
  "role": "string",
  "roleId": "string",
  "status": "pending",
  "createdAt": "ISO date string",
  "expiresAt": "ISO date string"
}
```

### `brokkr org cancel-invitation [id] [--json]`

Cancel a pending invitation. Supports both one-shot and interactive modes.

- **One-shot**: provide the invitation ID as argument
- **Interactive**: omit ID to pick from pending invitations

```bash
brokkr org cancel-invitation <id>              # one-shot
brokkr org cancel-invitation <id> --json       # one-shot with JSON
brokkr org cancel-invitation                   # interactive: pick from pending
```

**JSON output shape** (`--json`): Same as invitation detail object (with `"status": "canceled"`).

---

### `brokkr org invitations [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--json]`

List organization invitations (pending, accepted, rejected, canceled).

- **Sortable fields**: `email`, `role`, `status`, `createdAt`, `expiresAt`. **Default sort**: `createdAt:desc`.
- **Searchable fields** (`--search`): `email`, assigned role name.

The backend accepts `status` and assigned-role slug query params, but the CLI does not expose them as flags — use `--search` or re-filter the JSON output client-side.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "email": "string",
      "role": "string",
      "roleId": "string",
      "status": "pending | accepted | rejected | canceled",
      "createdAt": "ISO date string",
      "expiresAt": "ISO date string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 7, "totalPages": 1 }
}
```

### `brokkr org invitations <id> [--json]`

Show detail for a single invitation.

**JSON output shape** (`--json`):

```json
{
  "id": "string",
  "email": "string",
  "inviterId": "string",
  "organizationId": "string",
  "role": "string",
  "roleId": "string",
  "status": "pending | accepted | rejected | canceled",
  "createdAt": "ISO date string",
  "expiresAt": "ISO date string"
}
```

---

### `brokkr org api-keys [--page N] [--page-size N] [--sort <expr>] [--search <query>] [--created-by <email>] [--json]`

List API keys.

- **Legacy filter flag**: `--created-by <email>` — exact match against the creator's email (not part of the `--filters` grammar).
- **Sortable fields**: `name`, `createdAt`, `expiresAt`. **Default sort**: `createdAt:desc`.
- **Searchable fields** (`--search`): `name`, `user.email`, `user.name`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "name": "string | null",
      "start": "string | null",
      "prefix": "string | null",
      "role": "string",
      "enabled": "boolean",
      "expiresAt": "ISO date string | null",
      "createdAt": "ISO date string",
      "requestCount": "number",
      "remaining": "number | null",
      "lastRequest": "ISO date string | null",
      "createdByName": "string | null",
      "createdByEmail": "string"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 4, "totalPages": 1 }
}
```

### `brokkr org api-keys <id> [--json]`

Show detail for a single API key.

**JSON output shape** (`--json`): Same as list item (single object, no wrapper).

### `brokkr org create-api-key [name] [--expires-in <duration>] [--json]`

Create a new API key. The full key is only shown once at creation.

- **One-shot**: provide name and `--expires-in` (none, 7d, 30d, 90d, 1y)
- **Interactive**: omit values to be prompted

```bash
brokkr org create-api-key                                          # Interactive
brokkr org create-api-key "my-key"                                 # Prompts for expiration
brokkr org create-api-key "my-key" --expires-in 30d                # One-shot
brokkr org create-api-key "my-key" --expires-in none --json        # JSON output
```

**JSON output shape** (`--json`): Same as API key list item plus `"key": "string"` (full key).

### `brokkr org delete-api-key [id] [--json]`

Delete an API key.

- **One-shot**: provide API key ID as argument
- **Interactive**: omit ID to pick from keys

```bash
brokkr org delete-api-key                                          # Interactive
brokkr org delete-api-key <id>                                     # One-shot
brokkr org delete-api-key <id> --json                              # JSON output
```

**JSON output shape** (`--json`): `{ "success": true }`

---

### `brokkr org webhooks [--page N] [--page-size N] [--json]`

List webhooks. Only `--page` and `--page-size` are accepted; the CLI does not expose `--sort`, `--search`, or `--filters`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string (UUID)",
      "endpoint": "string",
      "description": "string | null",
      "events": ["DEVICE_LISTING_UPDATED", "DEVICE_LISTING_CREATED", "..."],
      "isActive": "boolean",
      "createdAt": "ISO date string",
      "updatedAt": "ISO date string | null"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 9, "totalPages": 1 }
}
```

### `brokkr org webhooks <id> [--json]`

Show detail for a single webhook.

**JSON output shape** (`--json`): Same as list item (single object, no wrapper).

### `brokkr org webhooks deliveries [--page N] [--page-size N] [--json]`

List webhook delivery attempts across all endpoints. Only `--page` and `--page-size` are accepted; the CLI does not expose `--sort`, `--search`, or `--filters`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string (UUID)",
      "webhookId": "string (UUID)",
      "webhookEndpoint": "string",
      "eventType": "string",
      "status": "PENDING | SUCCESS | FAILED | RETRYING",
      "statusCode": "number | null",
      "attemptNumber": "number",
      "error": "string | null",
      "createdAt": "ISO date string",
      "deliveredAt": "ISO date string | null"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 0, "totalPages": 0 }
}
```

### `brokkr org create-webhook [endpoint] [--description <desc>] [--events <csv>] [--active on|off] [--json]`

Create a new webhook. The signing secret is only shown once at creation.

Event types: `DEVICE_LISTING_UPDATED`, `DEVICE_LISTING_CREATED`, `DEVICE_LISTING_DECOMMISSIONED`, `DEPLOYMENT_INTERRUPTED`, `DEPLOYMENT_INTERRUPTION_COMPLETED`

- **One-shot**: provide endpoint and `--events` (comma-separated)
- **Interactive**: omit values to be prompted

```bash
brokkr org create-webhook                                                                      # Interactive
brokkr org create-webhook https://example.com/hook --events DEVICE_LISTING_UPDATED             # One-shot
brokkr org create-webhook https://example.com/hook --events DEVICE_LISTING_UPDATED --json      # JSON
```

**JSON output shape** (`--json`): Same as webhook list item plus `"secret": "string"` (signing secret).

### `brokkr org update-webhook [id] [--endpoint <url>] [--description <desc>] [--events <csv>] [--active on|off] [--json]`

Update a webhook. In one-shot mode, omitted flags keep current values.

- **One-shot**: provide webhook ID and any flags to change
- **Interactive**: omit ID to pick from webhooks, prompted for all fields

```bash
brokkr org update-webhook                                                                      # Interactive
brokkr org update-webhook <id> --active off                                                    # Disable
brokkr org update-webhook <id> --endpoint https://new.com/hook --json                          # Change endpoint
brokkr org update-webhook <id> --events DEVICE_LISTING_UPDATED,DEPLOYMENT_INTERRUPTED          # Change events
```

**JSON output shape** (`--json`): Same as webhook list item.

### `brokkr org delete-webhook [id] [--json]`

Delete a webhook.

- **One-shot**: provide webhook ID as argument
- **Interactive**: omit ID to pick from webhooks

```bash
brokkr org delete-webhook                                          # Interactive
brokkr org delete-webhook <id>                                     # One-shot
brokkr org delete-webhook <id> --json                              # JSON output
```

**JSON output shape** (`--json`): `{ "success": true }`

### `brokkr org retry-delivery [id] [--json]`

Retry a failed webhook delivery.

- **One-shot**: provide delivery ID as argument
- **Interactive**: omit ID to pick from failed/retrying deliveries

```bash
brokkr org retry-delivery                                          # Interactive
brokkr org retry-delivery <id>                                     # One-shot
brokkr org retry-delivery <id> --json                              # JSON output
```

**JSON output shape** (`--json`): Same as webhook delivery list item.

### `brokkr org webhooks stats [--json]`

Show aggregate webhook statistics.

**JSON output shape** (`--json`):

```json
{
  "total": "number",
  "active": "number",
  "failed": "number",
  "recentDeliveries": [
    {
      "id": "string",
      "webhookId": "string",
      "eventType": "string",
      "status": "string",
      "httpStatus": "number | null",
      "attempts": "number",
      "createdAt": "ISO date string",
      "deliveredAt": "ISO date string | null",
      "webhook": "{ endpoint: string, description: string | null } (optional — may be omitted)"
    }
  ]
}
```

---

### `brokkr org billing [--json]`

Show billing information and default payment method.

**JSON output shape** (`--json`):

```json
{
  "verifiedExtendTerms": "boolean",
  "netTerms": "P7D | P15D | P30D | null",
  "defaultPaymentMethod": {
    "id": "string",
    "isDefault": true,
    "type": "card",
    "brand": "string",
    "last4": "string",
    "expDate": "string",
    "country": "string",
    "city": "string",
    "state": "string",
    "postalCode": "string",
    "addressLine1": "string",
    "addressLine2": "string | null"
  }
}
```

Note: `defaultPaymentMethod` is `null` if no default is set.

### `brokkr org set-default-payment [id] [--json]`

Set the default payment method. Payment methods must be added via the web dashboard.

- **One-shot**: provide payment method ID as argument
- **Interactive**: omit ID to pick from payment methods

```bash
brokkr org set-default-payment                                     # Interactive
brokkr org set-default-payment <id>                                # One-shot
brokkr org set-default-payment <id> --json                         # JSON output
```

**JSON output shape** (`--json`): `{ "success": true }`

### `brokkr org billing payment-methods [--page N] [--page-size N] [--json]`

List all payment methods on file. Only `--page` and `--page-size` are accepted; the CLI does not expose `--sort`, `--search`, or `--filters`.

**JSON output shape** (`--json`):

```json
{
  "data": [
    {
      "id": "string",
      "isDefault": "boolean",
      "type": "card",
      "brand": "string",
      "last4": "string",
      "expDate": "string",
      "country": "string",
      "city": "string",
      "state": "string",
      "postalCode": "string",
      "addressLine1": "string",
      "addressLine2": "string | null"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 4, "totalPages": 1 }
}
```

---

## Common Workflows

### List all deployments

```bash
brokkr deployments --json
```

### Get full details for a deployment

```bash
brokkr deployments <deployment-id> --json
```

### Filter deployments by project

```bash
brokkr deployments --project "default" --json
```

### Search deployments by name

```bash
brokkr deployments --search "my-server" --json
```

### Rename a deployment

```bash
brokkr deployments:rename <id> --name "new-name"
```

### Power cycle a deployment

```bash
brokkr deployments:power <id> --action cycle --force        # --force skips confirmation
```

### Lock a deployment to prevent destructive actions

```bash
brokkr deployments:lock <id>
```

### Reprovision with a new OS

```bash
brokkr deployments:reprovision <id> --name "my-server" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json
```

### Create a project and delete it

```bash
brokkr deployments:create-project --name "Staging" --json
brokkr deployments:delete-project <project-id> --force --json
```

### Find the most expensive device (server-side sorted)

```bash
brokkr dcim servers --sort hourlyPrice:desc --page-size 1 --json
```

### List all active devices sorted by GPU count

```bash
brokkr dcim servers --status Active --sort gpuCount:desc --json
```

### Search for devices with a specific GPU model

```bash
brokkr dcim servers --search "RTX" --json
```

### Get full specs for a specific device

```bash
brokkr dcim servers <device-id> --json
```

### List all data centers

```bash
brokkr dcim dc --json --page-size 100
```

### Search data centers by location

```bash
brokkr dcim dc --search "Arizona" --json
```

### Paginate through large result sets

```bash
brokkr dcim servers --json --page 1 --page-size 100
# Check meta.totalPages, then:
brokkr dcim servers --json --page 2 --page-size 100
```

### List all organization owners

```bash
brokkr org members --role Owner --json
```

### List API keys created by a specific user

```bash
brokkr org api-keys --created-by "user@example.com" --json
```

### Create an API key with 30-day expiration

```bash
brokkr org create-api-key "ci-pipeline" --expires-in 30d --json
```

### Update a member's role

```bash
brokkr org update-member-role <membership-id> --role Admin --json
```

### Create a webhook for deployment events

```bash
brokkr org create-webhook https://example.com/hook --events DEPLOYMENT_INTERRUPTED,DEPLOYMENT_INTERRUPTION_COMPLETED --json
```

### Disable a webhook

```bash
brokkr org update-webhook <webhook-id> --active off --json
```

### Retry a failed webhook delivery

```bash
brokkr org retry-delivery <delivery-id> --json
```

### Update organization name

```bash
brokkr org update-settings --name "New Org Name" --json
```

### Set default payment method

```bash
brokkr org set-default-payment <payment-method-id> --json
```

### View billing info and default payment method

```bash
brokkr org billing --json
```

### Check webhook health

```bash
brokkr org webhooks stats --json
```

### Update device nickname and eco mode

```bash
brokkr dcim servers:settings <device-id> --nickname "my-gpu-server"
brokkr dcim servers:settings <device-id> --eco-mode on
brokkr dcim servers:settings <device-id> --nickname "srv" --eco-mode off
```

### Update device listing price and make it visible

```bash
# Prices are in USD. Use decimal notation (4.50 = $4.50/hr)
brokkr dcim servers:listing <device-id> --hourly-price 4.50 --floor-price 2.50 --listed on
```

### Delist a device from the marketplace

```bash
# Only changes listed status; prices remain unchanged
brokkr dcim servers:listing <device-id> --listed off
```

### Check current device settings before updating

```bash
# Get current state (eco mode, listing, prices are in the JSON)
brokkr dcim servers <device-id> --json
# Then update what you need
brokkr dcim servers:settings <device-id> --eco-mode on --json
brokkr dcim servers:listing <device-id> --hourly-price 5.00 --json
```

### Provision a device (full one-shot scripted flow)

```bash
# 1. Find available OS slugs for the device
brokkr dcim servers <device-id> --json | jq '.availableBaseLayers[].slug'
# 2. Provision with chosen OS and SSH keys
brokkr dcim servers:provision <device-id> --name "my-server" --os ubuntu-noble-vanilla --ssh-keys "key-uuid" --force --json
```

### Decommission a device

```bash
brokkr dcim servers:decommission <device-id> --force --json
```

### Get current user and org context (for scripting)

```bash
brokkr whoami --json
brokkr org current --json
```

### Invite a member and verify

```bash
brokkr org invite user@example.com --role-id <role-id> --json
brokkr org invitations --search "user@example.com" --json
```

### Remove a member by ID

```bash
brokkr org remove-member <membership-id> --json
```

### Cancel a pending invitation

```bash
brokkr org cancel-invitation <invitation-id> --json
```

---

## Inventory (Rent Servers)

### `brokkr inventory [id] [--page N] [--page-size N] [--filters <expr>] [--json]`

Browse the server marketplace. Without an ID, lists available devices. With an ID, shows full specs, pricing, and available OS images.

**Inventory uses a dedicated filter parser that only supports the `eq` operator.** Different fields AND together; repeating the same field OR-combines values.

**Filterable fields** (pass via `--filters "field:eq:value|..."`):

| Field                | Type | Operators | Allowed values                                                                                                                                                                                                                                                                      |
| -------------------- | ---- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`           | enum | `eq` only | `3070`, `3080`, `3090`, `4090`, `5090`, `a10`, `a40`, `a100`, `a4000`, `a4500`, `a5000`, `a6000`, `b200`, `b300`, `cpu`, `gb200`, `gb300`, `gh200`, `h100`, `h200`, `l40`, `l40s`, `mi100`, `mi200`, `mi250`, `mi300`, `mi300x`, `p100`, `rtx6000`, `t4`, `v100`, `virtual machine` |
| `status`             | enum | `eq` only | `on demand`, `reserve`, `preorder`                                                                                                                                                                                                                                                  |
| `interruptibleReady` | bool | `eq` only | `true`, `false`                                                                                                                                                                                                                                                                     |

The CLI does not expose `--sort` or `--search` for inventory — the endpoint only honors `--filters` and pagination.

**Default pageSize**: 12.

```bash
brokkr inventory --json                                              # List all available servers
brokkr inventory --page 2 --page-size 5 --json                       # Page through listings
brokkr inventory --filters "category:eq:h100" --json                 # Only H100 listings
brokkr inventory --filters "category:eq:h100|category:eq:h200"       # H100 OR H200 (same field = OR)
brokkr inventory --filters "status:eq:on demand" --json              # Only on-demand listings
brokkr inventory --filters "interruptibleReady:eq:true" --json       # Only interruptible-ready
brokkr inventory <id>                                                # Show specs and pricing
brokkr inventory <id> --json                                         # Full device details as JSON
```

**List JSON output:**

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "OOB IPMI-647",
      "location": "Arizona",
      "stockStatus": "on demand",
      "cpuModel": "Intel(R) Xeon(R) CPU E5-2620 v4 @ 2.10GHz",
      "gpuModel": null,
      "gpuCount": null,
      "memoryGb": 64,
      "storageGb": 1600,
      "pricePerHourCents": 10500,
      "isInterruptibleOnly": false
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 10, "totalPages": 1 }
}
```

**Detail JSON output:**

```json
{
  "id": "uuid",
  "name": "OOB IPMI-647",
  "location": "Arizona",
  "stockStatus": "on demand",
  "isInterruptibleOnly": false,
  "cpu": { "model": "...", "count": 2, "totalCores": 16, "totalThreads": 32 },
  "gpu": { "model": null, "count": null },
  "memory": { "totalGb": 64 },
  "storage": {
    "nvmeCount": null,
    "nvmeSizeGb": null,
    "ssdCount": 2,
    "ssdSizeGb": 1600,
    "hddCount": null,
    "hddSizeGb": null,
    "totalGb": 1600
  },
  "networking": { "ipv4": "", "ipv6": "...", "networkType": "Public", "vpcCapable": false },
  "pricing": {
    "onDemandPerHourCents": 10500,
    "onDemandPerWeekCents": 1764000,
    "onDemandPerMonthCents": 7812000,
    "interruptiblePerHourCents": 2500
  },
  "availableBaseLayers": [
    {
      "id": "layer-uuid",
      "slug": "ubuntu-plucky-vanilla",
      "name": "Ubuntu Plucky Vanilla",
      "family": "base",
      "version": "25.04"
    }
  ],
  "defaultDiskLayouts": [
    { "config": "lvm", "format": "ext4", "mountpoint": "/", "diskType": "ssd", "disks": ["0x3001438040175350"] }
  ],
  "availableAt": "2026-04-16T15:10:24.150Z"
}
```

Price fields (`*Cents`) are in cents — divide by 100 for dollars. Memory/storage fields (`*Gb`) are in gigabytes.

---

### `brokkr inventory:rent [id]`

Rent a server from the marketplace. Creates a new deployment for your organization. All options match the web checkout form.

**Interactive mode** (prompts for any missing values):

```bash
brokkr inventory:rent                   # pick server + configure interactively
brokkr inventory:rent <id>              # configure a specific server interactively
```

**One-shot mode** (all values via flags, `--force` skips confirmation):

```bash
brokkr inventory:rent <id> \
  --name "my-server" \
  --os ubuntu-plucky-vanilla \
  --ssh-keys "uuid1,uuid2" \
  --contract-type ON_DEMAND \
  --project-id <project-uuid> \
  --force \
  --json
```

**Flags:**

| Flag                      | Description                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`           | Deployment name                                                                                                                                                                     |
| `--os <slug>`             | Base layer slug from `inventory <id>` availableBaseLayers                                                                                                                           |
| `--ssh-keys <ids>`        | Comma-separated SSH key UUIDs                                                                                                                                                       |
| `--contract-type <type>`  | `ON_DEMAND` \| `INTERRUPTIBLE` \| `RESERVED_ROLLING` \| `RESERVED`                                                                                                                  |
| `--project-id <id>`       | Project UUID to assign the deployment to                                                                                                                                            |
| `--disk-layout <json>`    | JSON array of disk layout objects (defaults to device's recommended layout)                                                                                                         |
| `--cloud-init <yaml>`     | Cloud-init user data as YAML string                                                                                                                                                 |
| `--ipxe-url <url>`        | Custom iPXE boot URL (must be HTTPS)                                                                                                                                                |
| `--customizations <json>` | Layer customizations as JSON object (e.g. `{"gpuDriver":"nvidia-driver-580","miscSoftware":["docker"]}`). Optional. See `availableComponentLayersByBase` in `inventory <id> --json` |
| `--force`                 | Skip confirmation prompt                                                                                                                                                            |
| `--json`                  | Output `{ "success": true }` on success                                                                                                                                             |

**Contract types:**

- `ON_DEMAND` — billed hourly, cancel any time
- `INTERRUPTIBLE` — lower price, may be interrupted with notice
- `RESERVED_ROLLING` — auto-renewing reservation
- `RESERVED` — fixed-term reservation

**Disk layout JSON format** (use `inventory <id> --json` to get `defaultDiskLayouts`):

```json
[
  {
    "config": "lvm",
    "format": "ext4",
    "mountpoint": "/",
    "diskType": "ssd",
    "disks": ["0x3001438040175350", "0x3001438040175351"]
  }
]
```

**JSON output:**

```json
{ "success": true }
```

---

## MCP Tools (Inventory)

### `list_inventory`

List available servers with pagination. Optional `filters` for narrowing results.

**Parameters:**

```json
{ "page": 1, "pageSize": 20, "filters": "optional-encoded-filter" }
```

**Response:** same shape as `brokkr inventory --json` list output.

### `get_inventory_item`

Get full specs, pricing, available OS images, and disk layouts for a single device. Call this before `provision_inventory_device` to get the correct OS slug and disk layouts.

**Parameters:**

```json
{ "id": "device-uuid" }
```

**Response:** same shape as `brokkr inventory <id> --json` detail output.

### `provision_inventory_device`

Rent a device. **Workflow:** call `get_inventory_item` first to get `operatingSystem` slugs and `defaultDiskLayouts`. Get SSH key IDs from `list_ssh_keys` (your own keys) or `list_org_ssh_keys` (all org members' keys).

**Parameters:**

```json
{
  "id": "device-uuid",
  "contractType": "ON_DEMAND",
  "deploymentName": "my-server",
  "operatingSystem": "ubuntu-plucky-vanilla",
  "sshKeyIds": ["key-uuid"],
  "projectId": "project-uuid",
  "diskLayouts": [{ "config": "lvm", "format": "ext4", "mountpoint": "/", "diskType": "ssd", "disks": ["disk-wwn"] }],
  "cloudInit": null,
  "ipxeUrl": null,
  "customizations": { "gpuDriver": "nvidia-driver-580", "miscSoftware": ["docker"] }
}
```

`sshKeyIds` — array of SSH key UUIDs to install on the server. Use your own key IDs from `list_ssh_keys`, or any org member's key IDs from `brokkr org members`. `projectId` is optional. `customizations` is optional (null/omitted for an un-customized base) — OS layer selections keyed by layer slug, from the device's `availableComponentLayersByBase` in `get_inventory_item`.

**Response:**

```json
{ "success": true }
```

---

## Account Commands

Manage your own user profile and SSH keys. These are user-scoped, not organization-scoped. SSH keys added here are also visible in org-level SSH key listings and can be used for server provisioning.

### `brokkr account profile`

View your profile.

```bash
brokkr account profile              # human-readable
brokkr account profile --json       # JSON output
```

**JSON output:**

```json
{
  "id": "user-uuid",
  "email": "you@example.com",
  "name": "Augusto Bardini",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-06-01T00:00:00.000Z"
}
```

`createdAt` / `updatedAt` are ISO 8601 UTC strings.

### `brokkr account profile update`

Update your profile. Only the fields you provide are changed. Omitted flags are prompted interactively with the current value pre-filled. All three flags provided = no prompts (one-shot mode).

```bash
brokkr account profile update                                                # interactive: prompts for all three fields
brokkr account profile update --first-name Augusto                          # prompts for last name + email
brokkr account profile update --first-name A --last-name B --email a@b.com  # one-shot, no prompts
brokkr account profile update --first-name A --last-name B --email a@b.com --json
```

| Flag                  | Description                    |
| --------------------- | ------------------------------ |
| `--first-name <name>` | First name                     |
| `--last-name <name>`  | Last name                      |
| `--email <email>`     | Email address                  |
| `--json`              | Output updated profile as JSON |

**JSON output:** same shape as `account profile`.

### `brokkr account ssh-keys [id]`

List your SSH public keys, or show one by ID. Only `--page` and `--page-size` are accepted; the CLI does not expose `--sort`, `--search`, or `--filters`.

```bash
brokkr account ssh-keys              # list all
brokkr account ssh-keys --json       # JSON list
brokkr account ssh-keys --page 2 --page-size 10
brokkr account ssh-keys <id>         # show key detail
brokkr account ssh-keys <id> --json  # key detail as JSON
```

| Flag              | Description                           |
| ----------------- | ------------------------------------- |
| `--page <N>`      | Page number (default: 1)              |
| `--page-size <N>` | Items per page, max 100 (default: 20) |
| `--json`          | Output as JSON                        |

**JSON list output:**

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-...",
      "name": "My Laptop",
      "fingerprint": "SHA256:p27MbRitICmh1l4ayIpxvOPzwlH0Y9S8V6rDHENoa8Y=",
      "dateCreated": "2026-04-03T00:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
}
```

**JSON detail output:**

```json
{
  "id": "a1b2c3d4-e5f6-...",
  "name": "My Laptop",
  "fingerprint": "SHA256:p27MbRitICmh1l4ayIpxvOPzwlH0Y9S8V6rDHENoa8Y=",
  "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
  "userId": "user-uuid",
  "dateCreated": "2026-04-03T00:00:00.000Z",
  "dateDeleted": null
}
```

`dateCreated` / `dateDeleted` are ISO 8601 UTC strings. `dateDeleted` is `null` for active keys.

### `brokkr account ssh-keys add`

Register a new SSH public key. Omitted flags are prompted interactively.

```bash
brokkr account ssh-keys add                                           # interactive
brokkr account ssh-keys add --name "My Laptop" --key "ssh-ed25519 AAAA..."
brokkr account ssh-keys add --name "My Laptop" --key "ssh-ed25519 AAAA..." --json
```

| Flag            | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `--name <name>` | Display name for the key                                                     |
| `--key <key>`   | Full SSH public key in OpenSSH format (e.g. `ssh-ed25519 AAAA... user@host`) |
| `--json`        | Output created key as JSON                                                   |

**JSON output:** same shape as SSH key detail.

### `brokkr account ssh-keys delete <id>`

Soft-delete an SSH key. The key is removed from future provisioning operations.

```bash
brokkr account ssh-keys delete <id>              # prompts for confirmation (shows key name + fingerprint)
brokkr account ssh-keys delete <id> --force      # skip confirmation
brokkr account ssh-keys delete <id> --force --json
```

| Flag      | Description                |
| --------- | -------------------------- |
| `--force` | Skip confirmation prompt   |
| `--json`  | Output deleted key as JSON |

**JSON output:** same shape as SSH key detail (with `dateDeleted` set to deletion timestamp).

---

## MCP Tools (Account)

### `get_profile`

Get the current authenticated user's profile. No parameters.

**Response:**

```json
{
  "id": "user-uuid",
  "email": "you@example.com",
  "name": "Augusto Bardini",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-06-01T00:00:00.000Z"
}
```

### `update_profile`

Update profile fields. All parameters are optional — only provided fields are changed.

**Parameters:**

```json
{ "firstName": "Augusto", "lastName": "Bardini", "email": "you@example.com" }
```

**Response:** same shape as `get_profile`.

### `list_ssh_keys`

List SSH keys belonging to the current user.

**Parameters:**

```json
{ "page": 1, "pageSize": 20 }
```

**Response:**

```json
{
  "data": [
    {
      "id": "a1b2c3d4-e5f6-...",
      "name": "My Laptop",
      "fingerprint": "SHA256:p27MbRitICmh1l4ayIpxvOPzwlH0Y9S8V6rDHENoa8Y=",
      "dateCreated": "2026-04-03T00:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "pageSize": 20, "totalItems": 1, "totalPages": 1 }
}
```

### `get_ssh_key`

Get full details for a single SSH key including the public key string.

**Parameters:**

```json
{ "id": "a1b2c3d4-e5f6-..." }
```

**Response:**

```json
{
  "id": "a1b2c3d4-e5f6-...",
  "name": "My Laptop",
  "fingerprint": "SHA256:p27MbRitICmh1l4ayIpxvOPzwlH0Y9S8V6rDHENoa8Y=",
  "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
  "userId": "user-uuid",
  "dateCreated": "2026-04-03T00:00:00.000Z",
  "dateDeleted": null
}
```

### `create_ssh_key`

Register a new SSH public key for the current user. The key will be available for server provisioning.

**Parameters:**

```json
{ "name": "My Laptop", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@host" }
```

**Response:** same shape as `get_ssh_key`.

### `delete_ssh_key`

Soft-delete an SSH key. It will no longer appear in provisioning key selectors.

**Parameters:**

```json
{ "id": "a1b2c3d4-e5f6-..." }
```

**Response:** same shape as `get_ssh_key` (with `dateDeleted` set).

---

## Common Workflows

### Rent a server using your own SSH key (MCP)

```
1. create_ssh_key  { name: "My Key", key: "ssh-ed25519 AAAA..." }  → note the returned id
2. list_inventory  { page: 1, pageSize: 20 }                       → pick a device id
3. get_inventory_item { id: "device-uuid" }                        → get OS slug + diskLayouts
4. provision_inventory_device {
     id: "device-uuid",
     contractType: "ON_DEMAND",
     deploymentName: "my-server",
     operatingSystem: "ubuntu-plucky-vanilla",   ← from step 3
     sshKeyIds: ["key-uuid-from-step-1"],
     diskLayouts: [ ... ],                        ← defaultDiskLayouts from step 3
     cloudInit: null,
     ipxeUrl: null,
     customizations: null                         ← optional OS layer picks; null = un-customized base
   }
```

### Update your profile (MCP)

```
1. get_profile                                          → see current name/email
2. update_profile { firstName: "New", lastName: "Name" }
```
