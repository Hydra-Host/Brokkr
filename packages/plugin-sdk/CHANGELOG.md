# Changelog

All notable changes to `@hydrahost/plugin-sdk` are documented here. This package
follows semver: the extension surface (slots, manifests, helpers) only gains
additive changes in a minor release; existing slots are never removed or renamed
in a minor.

## 0.2.0

### Added

- `SidebarNavContribution.popup?: boolean` — when set, the host opens the entry's
  `to` target in a popup window and never re-navigates a window that is still
  open, so its document state is preserved across clicks. Backward compatible:
  existing contributions omit it and behave exactly as before.

## 0.1.0

- Initial plugin SDK: `definePlugin` / `defineFrontendPlugin`, plugin manifests,
  UI extension slots, route metadata, plugin DB/config-token helpers.
