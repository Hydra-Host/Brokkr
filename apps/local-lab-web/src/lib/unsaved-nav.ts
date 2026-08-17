const withoutTrailingSlash = (pathname: string): string =>
  pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

/** The router blocker also fires on a re-click of the current route, which unmounts nothing — only a real pathname change loses unsaved edits. */
export function blocksUnsavedNav(dirty: boolean, currentPathname: string, nextPathname: string): boolean {
  return dirty && withoutTrailingSlash(currentPathname) !== withoutTrailingSlash(nextPathname);
}

/** The first response must land even mid-edit — a form editable before it arrives would otherwise keep its component defaults forever; only later refetches yield to unsaved edits. */
export function shouldHydrateForm(hydratedOnce: boolean, dirty: boolean): boolean {
  return !hydratedOnce || !dirty;
}

/** A form that never hydrated holds component defaults, not the saved config, so saving it would write those defaults over the real one. */
export function canSaveForm(hydratedOnce: boolean, dirty: boolean, saving: boolean): boolean {
  return hydratedOnce && dirty && !saving;
}
