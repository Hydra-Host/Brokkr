# Changelog

All notable changes to `@hydrahost/plugin-sdk` are documented here. This package
follows semver: the extension surface (slots, manifests, helpers) only gains
additive changes in a minor release; existing slots are never removed or renamed
in a minor.

## Unreleased

### Added

- `inventory-device-provision` extension slot — primary CTA on the authenticated
  inventory device provision page. Host registers contributions only when the
  `managed-edition` plugin is enabled (public BOSS keeps the default Provision
  submit). Slot props include server-derived `knownAccount` and `hasActiveInvite`.

### Changed

- `provision.authorize` now runs **before** reservation/deployment create, so
  `payload.deploymentId` is always `''` at gate time. Handlers that previously
  looked up the deployment must use `deviceId` / `organizationId` instead — the
  real deployment ID is not available until after authorization. A new
  `manualBilling: boolean` field is required on the same payload.

## 0.2.0

### Added

- `PluginRateLimit` / `PluginRateLimitGuard` and the host-provided `PLUGIN_RATE_LIMITER` for atomic, plugin-scoped Redis limits.
- `PublicRoute` from `@hydrahost/plugin-sdk/nest` for controllers that intentionally bypass host authentication.
- `PluginOperatorGuard` and `PLUGIN_OPERATOR_ADMIN_ORG` from `@hydrahost/plugin-sdk/nest` for operator HTTP handlers.
- `SidebarNavContribution.popup?: boolean` — when set, the host opens the entry's
  `to` target in a popup window and never re-navigates a window that is still
  open, so its document state is preserved across clicks. Backward compatible:
  existing contributions omit it and behave exactly as before.

### Changed

- Invalid or colliding public frontend routes now disable only the affected plugins; unaffected plugins continue loading.

## 0.1.0

- Initial plugin SDK: `definePlugin` / `defineFrontendPlugin`, plugin manifests,
  UI extension slots, route metadata, plugin DB/config-token helpers.
