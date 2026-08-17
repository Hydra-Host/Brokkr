# Bridge CA directory

Drop PEM-encoded CA certificates (`*.crt` / `*.pem`) in this directory before
building `apps/bridge/Dockerfile` and the build threads them through every
trust surface the bridge ships:

| Consumer                        | What the build does with them                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPXE binaries (amd64/arm64/ISO) | Each file is passed to iPXE's `TRUST=` so chainloading over HTTPS validates your `:443` cert chain                                                                                                                                 |
| brokkr-live initrd              | Installed into the initrd trust store (`/usr/local/share/ca-certificates/`, applied by the `init-bottom/trust` boot script) and merged into `/etc/ssl/certs/brokkr-ca.crt`, the `--cacert` bundle the early-boot rootfs fetch uses |
| Bridge runtime image            | Installed into `/usr/local/share/ca-certificates/` + `update-ca-certificates`, so the bridge process and its subprocess tools (curl, etc.) trust your CA                                                                           |

The device-side agent needs no extra wiring: it reads the system bundle
(`tls.ca_bundle_path` in `agent.yaml`), which the initrd trust store feeds.

An empty directory builds fine: iPXE trusts only the upstream iPXE.org root
(so chainload over plain HTTP, or against a publicly-valid cert via the
`ca.ipxe.org` cross-sign), the initrd bundle is empty, and the runtime image
trusts only the Mozilla store.

Certificates are deployment identity, not source: nothing here is committed
(`*.crt`/`*.pem` are gitignored). Hosted CI populates this directory from the
internal CA image before building; self-hosters drop their own root CA here.
See "Bridge HTTPS" in `apps/bridge/README.md` for the end-to-end setup.
