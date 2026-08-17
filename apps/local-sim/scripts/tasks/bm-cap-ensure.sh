#!/usr/bin/env bash
set -euo pipefail

[ -n "${DEVENV_STATE:-}" ] || {
  echo "bm-cap-ensure: DEVENV_STATE is unset" >&2
  exit 1
}
[ -n "${LOCAL_SIM_PRIV_BIN:-}" ] || {
  echo "bm-cap-ensure: LOCAL_SIM_PRIV_BIN is unset — run 'task sudo:setup'" >&2
  exit 1
}
[ -x "${LOCAL_SIM_PRIV_BIN}" ] || {
  echo "bm-cap-ensure: LOCAL_SIM_PRIV_BIN not executable ('$LOCAL_SIM_PRIV_BIN') — it can drift from the sudoers pin after 'devenv update'; run 'task sudo:setup'" >&2
  exit 1
}

bm_dir="$DEVENV_STATE/baremetal"
setpriv_dest="$bm_dir/setpriv"
node_wrapper="$bm_dir/node"
mkdir -p "$bm_dir"

setpriv_src="$(readlink -f "$(command -v setpriv)" 2>/dev/null || true)"
[ -x "$setpriv_src" ] || setpriv_src=/usr/bin/setpriv
[ -x "$setpriv_src" ] || {
  echo "bm-cap-ensure: no executable setpriv found (tried PATH + /usr/bin/setpriv)" >&2
  exit 1
}

setpriv_caps="$(getcap "$setpriv_dest" 2>/dev/null || true)"
if cmp -s "$setpriv_src" "$setpriv_dest" &&
  [[ $setpriv_caps == *cap_net_bind_service* && $setpriv_caps == *cap_net_raw* ]]; then
  echo "bm-cap-ensure: setpriv copy up to date at $setpriv_dest — skipping copy+setcap"
else
  echo "bm-cap-ensure: copying + capping setpriv ($setpriv_src → $setpriv_dest)"
  sudo -n "$LOCAL_SIM_PRIV_BIN" cap-net-bind "$setpriv_src" "$setpriv_dest"
fi

tmp="$(mktemp "$bm_dir/.node.XXXXXX")"
cat >"$tmp" <<'WRAPPER'
#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/setpriv" --inh-caps +net_bind_service,+net_raw --ambient-caps +net_bind_service,+net_raw -- node "$@"
WRAPPER
chmod 0755 "$tmp"
mv -f "$tmp" "$node_wrapper"
echo "bm-cap-ensure: wrote ambient-cap wrapper $node_wrapper"

exit 0
