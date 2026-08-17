# Manual testing — webvm-terminal

## Prerequisites

- Internet access from the browser (the terminal streams the CheerpX runtime from `cxrtnc.leaningtech.com` and the Debian disk image from `disks.webvm.io`).
- A Chromium-based browser or Firefox with `SharedArrayBuffer` support (any current release).
- The plugin enabled — it is on by default; make sure `WEBVM_TERMINAL_ENABLED` is not set to `false`.

## Launch

1. Start the stack (`pnpm dev` for api + web, or `task up` for the full devenv stack).
2. Open the app (`http://localhost:5173` under `pnpm dev`) and log in.
3. In the left sidebar icon rail, click the **Linux Terminal** icon — it opens the popup directly (single-leaf popup sections skip the section panel).
4. A standalone popup window (~1024×720) opens at `/webvm-terminal` and boots the VM. First boot streams the disk image and typically takes 1–2 minutes; later boots are faster (the overlay persists in IndexedDB).

## What to verify

- **Popup, not a tab**: the window opens as a separate browser window without the address-bar chrome of a normal tab.
- **Loading overlay**: staged progress (script → devices → VM) with no errors; the overlay gives way to a shell prompt and banner.
- **Plain Linux works**: `ls /`, `uname -a`, `python3 --version`.
- **Brokkr bridge**: run `brokkr --help`, then something session-backed like `brokkr servers list` — API calls run in the browser with the logged-in user's session (check the Network tab of the popup: requests go to the host's own `/api/v1/...`).
- **Re-click focuses the running window**: with the VM running, click the **Linux Terminal** rail icon again — the running window is asked to come to the front (BroadcastChannel focus protocol) and a toast notes it is already open; no new window flashes. If the browser declines the programmatic raise, find the window via the taskbar. The running VM must never reload.
- **Popup blocked path**: block popups for the site and click the entry — a toast reports the popup was blocked; nothing else breaks.
- **Isolation headers** (the thing that makes it all work):
  ```bash
  curl -sI http://localhost:5173/webvm-terminal | grep -i cross-origin
  # expect: Cross-Origin-Opener-Policy: same-origin
  #         Cross-Origin-Embedder-Policy: credentialless
  ```
  The main app (`/`) must NOT carry `Cross-Origin-Embedder-Policy` — that would break payment iframes.
- **Opt-out**: restart the API with `WEBVM_TERMINAL_ENABLED=false` — the sidebar entry disappears and `GET /api/v1/plugins/enabled` no longer lists `webvm-terminal`.

## Automated tests

```bash
pnpm --filter @hydrahost/plugin-webvm-terminal test
```

Covers the `brokkr` bridge's path normalization (including `/api/v1` escape attempts), request envelope, and output formatting.
