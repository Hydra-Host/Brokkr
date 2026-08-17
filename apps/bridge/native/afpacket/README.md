# Raw Ethernet Frame Addon

N-API addon for raw Ethernet frame send/receive, with two platform backends behind
one API:

- **Linux** — `AF_PACKET SOCK_RAW` socket bound to an interface.
- **macOS** — BSD `/dev/bpf` device bound to an interface.

Both deliver full Ethernet frames from offset 0, so the JS-supplied classic-BPF
filter (ethernet-relative offsets) is byte-identical across platforms. On any other
OS the `binding.gyp` emits a no-op `type: none` target (nothing to build).

## Building

The addon is compiled automatically in two places, so no manual step is normally needed:

- **Docker image** — the `afpacket-build` stage in `apps/bridge/Dockerfile` runs
  `node-gyp rebuild`, and the release stage copies the result to
  `/app/native/afpacket/build/Release/afpacket.node`.
- **Local devenv** — the sim spoke build (`devenv/modules/spoke.nix`) compiles it when
  the `.node` is absent.

To build it by hand on a Linux or macOS host — no `npm install` is needed, since it is
pure C using `<node_api.h>` from Node's own headers (no `node-addon-api` dependency).
Prerequisites: a C compiler (gcc or clang), make, and Python 3.

```bash
cd apps/bridge/native/afpacket
npx node-gyp rebuild
```

The compiled `.node` lands at `build/Release/afpacket.node`.

## Runtime behavior

The bridge loads this addon lazily via `require()` inside a try/catch. If it is
absent (unsupported OS, not compiled) or `create()` fails (no capability — see
below), the bridge falls back to dgram-only DHCP transport — no crash, no degraded
startup.

## What it does

- Opens the platform raw socket bound to a named interface
- Attaches a classic BPF filter (passed from JS) to match broadcast DHCP only
- Spawns a receive thread that delivers frames to JS via `napi_threadsafe_function`
- Exposes `send(ifindex, dstMac, frame)` for raw frame transmission (unicast replies);
  the frame carries a complete L2 header (dst MAC included), so `ifindex`/`dstMac`
  are used only by Linux's `sockaddr_ll` — macOS sets `BIOCSHDRCMPLT` and writes the
  frame verbatim

## Capabilities

Opening the raw socket needs elevated access:

- **Linux** — `CAP_NET_RAW` (or root) for `AF_PACKET`.
- **macOS** — read/write access to `/dev/bpf*` (root, or membership in the
  `access_bpf` group, e.g. via Wireshark's ChmodBPF). Without it, `create()` throws
  `EACCES` and the bridge falls back to dgram.
