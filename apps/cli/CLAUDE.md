# Brokkr CLI — Rules & Conventions

## LLM Usage

For complete CLI command reference (invocation syntax, all flags, JSON output schemas, common workflows), see [`LLM_CLI_REFERENCE.md`](LLM_CLI_REFERENCE.md) in this directory.

## Hard Rules

These rules must always be followed when adding or modifying CLI features. No exceptions.

1. **Follow existing project standards.** New code must match the conventions, file organization, and patterns already established in the CLI. Look at existing implementations as the reference — do not invent new patterns.

2. **Follow existing UI patterns.** Tables, detail views, spinners, success/error messages, and all other output must match the visual style and structure of what's already built. Do not introduce new UI paradigms.

3. **Data display commands always have two versions.** Every command that shows data must work in both: (a) **TUI mode** — a screen in the interactive TUI for navigation and visualization, and (b) **one-shot CLI mode** — with `--json`, `--page`, `--page-size`, `--sort`, `--search`, and any applicable `--filter` flags. Add search and filter options wherever they make sense for the data.

4. **Input commands always have two versions.** Every command that accepts user input must work in both: (a) **interactive mode** — using `@clack/prompts` to prompt for any values not provided, and (b) **one-shot mode** — with all values passed as arguments and `--flags` so the command can be scripted without any prompts.

## Rules

1. **No dim/gray text styling.** Never use `dimColor` (Ink prop), `chalk.gray()`, `chalk.dim()`, or any dim/muted ANSI styling. These render as dark background shading on the target terminal. Use plain `<Text>`, foreground colors (`cyan`, `green`, `red`, `yellow`), or `bold` for visual hierarchy instead.

2. **No background colors on text.** Never use `chalk.bg*()` methods, Ink's `backgroundColor`, or `inverse` styling. No ANSI background escape sequences of any kind. All text styling must be foreground-only.

3. **Two rendering modes: TUI (navigation/visualization only) and CLI (commands).** The TUI (`brokkr` with no args) uses Ink's `render()` for a persistent interactive session — it is strictly for **navigation and data visualization** (lists, detail views). It must never contain user input prompts, forms, or mutation actions. All write operations (create, update, delete) belong in CLI commands. CLI commands use `renderOnce()` (which calls `renderToString()`) for static one-shot output. Never mix these — a CLI command must never call `render()`, and TUI screens must never call `renderOnce()`.

4. **Lazy-load React/Ink.** The entry point (`src/index.ts`) dynamically imports TUI code only when no CLI arguments are provided. CLI commands must never statically import from `ink` or `react` at the top of non-TSX files. This keeps `brokkr login`, `brokkr env use`, etc. fast.

5. **Column definitions belong in `src/core/dcim/columns.ts`.** Table columns and detail field definitions are declared once in the shared columns module and reused by both TUI screens and CLI commands. Do not duplicate column definitions inline in screen or command files.

6. **Data fetchers are pure functions that take `CliApiClient`.** All API calls live in `src/core/dcim/*.ts` as plain async functions that accept a `CliApiClient` and query params. They must not access config/store directly — the caller provides the authenticated client.

7. **`fail()` exits the process.** The `fail()` function in `src/ui/format.ts` calls `process.exit(1)`. It is typed as `never`. Use it only for terminal errors in CLI commands. In TUI screens, set error state instead — never call `process.exit()` from a React component.

8. **Config and session files are per-environment.** Session is stored as `session-{env}.json`, org as `org-{env}.json` in `~/.config/brokkr/`. When adding new persisted state, follow this pattern — scope it to the active environment.

9. **Auth uses direct fetch, not ts-rest.** Authentication endpoints (`sign-in`, `two-factor`, `get-session`, `organization/*`) use raw `fetch()` with manual cookie handling because the auth flow needs to run before a ts-rest client can be constructed. Do not try to move auth to ts-rest.

10. **Use `@clack/prompts` for interactive prompts in CLI commands.** All user input (text, select, confirm) uses `@clack/prompts`. Always check for cancel (`p.isCancel()`). Commands that accept user input must support two modes: **interactive** (prompts for missing values via `@clack/prompts`) and **one-shot** (all values passed as arguments/flags, e.g. `--role admin`). This lets users run commands interactively or script them. Never use `@clack/prompts` inside TUI screens — and never add input prompts to the TUI at all (see rule #3).

11. **Pagination is built in.** CLI commands get `--page`, `--page-size`, and `--json` flags via `paginationOptions()`. TUI screens use `usePaginatedAsync()` hook. Both share `PaginationMeta` types from `src/ui/table.ts`. New list endpoints must support pagination from day one.

12. **Navigation in TUI is stack-based.** The router (`src/tui/router.tsx`) uses a stack of `Route` objects. Push to navigate forward, pop to go back. Screen names are kebab-case strings. Every screen that navigates must accept and call `onBack` / use `pop()`.

13. **Every CLI command must support `--json` output.** All list and detail commands must accept a `--json` flag that outputs raw JSON via `renderJson()`. This enables scripting and piping. The JSON output must include the full API response (data + meta for lists).

14. **`withSpinner()` for CLI async operations.** All CLI commands that make API calls must wrap them in `withSpinner()` from `src/ui/table.ts`. It shows an `ora` spinner, handles errors, and exits on failure. Do not use bare `ora` directly.

15. **Use box-drawing characters for table borders.** Tables use Unicode box-drawing (`┌┬┐ ├┼┤ └┴┘ │ ─`), not ASCII (`+`, `-`, `|`). The `table-renderer.ts` module builds these strings. Do not use `cli-table3` or other table libraries — use the built-in renderer.

16. **Selected rows use cyan foreground + bold + `▸` marker.** The visual language for selection in NavTable is: cyan text color, bold weight, and `▸` prefix. Unselected rows get no color and a space prefix. Do not change this pattern or introduce other selection indicators.

17. **`q` always quits, `esc`/`backspace` always goes back.** Every TUI screen must handle `q` → `process.exit(0)` and `esc`/`backspace` → `onBack?.()` or `pop()`. This is a universal keyboard contract. Do not override these keys for other actions.

18. **Error display in TUI uses `<Text color="red">`.** When a TUI screen encounters an error, render it as `<Text color="red">{error}</Text>` inside a padded `<Box>`. Do not use `chalk` inside React components — use Ink's `color` prop.

19. **`chalk` is for CLI output, Ink `<Text>` props are for TUI.** In `src/commands/` and `src/ui/`, use `chalk` for coloring. In `src/tui/`, use Ink's `<Text color="..." bold>` props. Never import `chalk` inside a TUI component. Never use Ink's `<Text>` in a non-React context.

20. **Naming conventions.** Files: kebab-case. React components: PascalCase with `Screen` suffix for screens. Types: PascalCase with `ListItem`/`Detail`/`Meta` suffix. Screen route names: kebab-case strings. Constants: `UPPER_SNAKE_CASE`. Register functions: `registerXxxCommands(program)`.

21. **Keep filter/sort/search docs in sync with pagination configs.** The CLI docs are the public contract — backend pagination configs (`apps/api/src/**/*.pagination.ts`) and the inventory custom parser (`apps/api/src/inventory/inventory.service.ts`) are not a discovery mechanism for end users. When you add, remove, or rename a field in `searchableFields`, `sortableFields`, or `advancedFilterFields`, you must also update (a) the corresponding `.addHelpText('after', ...)` block in the CLI command file and (b) the matching command section in `apps/cli/LLM_CLI_REFERENCE.md`. Same rule applies for changes to `packages/api-client/src/schemas/pagination.ts` or the inventory filter enum values.
