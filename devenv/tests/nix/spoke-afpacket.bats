setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  MODULE=devenv/modules/spoke.nix
  ADDON_FNS=$(sed -n '/^        afpacket_stamp() {/,/^        }$/p; /^        ensure_afpacket_addon() {/,/^        }$/p' "$MODULE")
  export MODULE ADDON_FNS
  REPO="$BATS_TEST_TMPDIR/repo"
  ADDON="$REPO/apps/bridge/native/afpacket"
  mkdir -p "$ADDON/src"
  printf 'int afpacket;\n' >"$ADDON/src/afpacket.c"
  printf '{}\n' >"$ADDON/binding.gyp"
  touch -t 202001010000 "$ADDON/src/afpacket.c" "$ADDON/binding.gyp"
  SRC_MTIME=$(stat -c %Y "$ADDON/src/afpacket.c" 2>/dev/null || stat -f %m "$ADDON/src/afpacket.c")
  export CALLS="$BATS_TEST_TMPDIR/calls"
  mock_bin node 'echo 137'
  mock_bin uname 'echo x86_64'
  mock_bin pnpm 'echo "$PWD $*" >>"$CALLS"
mkdir -p build/Release
: >build/Release/afpacket.node'
}

built() {
  mkdir -p "$ADDON/build/Release"
  : >"$ADDON/build/Release/afpacket.node"
  [ $# -eq 0 ] || printf '%s\n' "$1" >"$ADDON/build/.stamp"
}

ensure() {
  run bash -c 'set -euo pipefail; cd "$1"; eval "$ADDON_FNS"; ensure_afpacket_addon' _ "$REPO"
}

rebuilt() {
  [ -f "$CALLS" ] && grep -q "/afpacket exec node-gyp rebuild" "$CALLS"
}

@test "the extracted functions are the ones the spoke:init task runs, free of nix escapes" {
  [[ "$ADDON_FNS" == *'afpacket_stamp() {'* ]]
  [[ "$ADDON_FNS" == *'ensure_afpacket_addon() {'* ]]
  [[ "$ADDON_FNS" != *"''"* ]]
  [[ "$ADDON_FNS" != *'${'* ]]
  run grep -c '^        ensure_afpacket_addon$' "$MODULE"
  [ "$output" = 1 ]
}

@test "a missing build compiles the addon from its directory and stamps abi, arch and source mtime" {
  ensure
  [ "$status" -eq 0 ]
  rebuilt
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$SRC_MTIME" ]
}

@test "a build whose stamp matches the host is left alone" {
  built "137-x86_64-$SRC_MTIME"
  ensure
  [ "$status" -eq 0 ]
  [ ! -f "$CALLS" ]
  [ -z "$output" ]
}

@test "a wrong-arch stamp triggers the rebuild and names the arch" {
  built "137-arm64-$SRC_MTIME"
  ensure
  [ "$status" -eq 0 ]
  rebuilt
  [[ "$output" == *"arch"* ]]
  [[ "$output" == *"arm64"* ]]
  [[ "$output" == *"x86_64"* ]]
  [[ "$output" != *"abi"* ]]
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$SRC_MTIME" ]
}

@test "a stale node abi is named" {
  built "127-x86_64-$SRC_MTIME"
  ensure
  rebuilt
  [[ "$output" == *"abi"* ]]
  [[ "$output" == *"127"* ]]
  [[ "$output" != *"arch"* ]]
}

@test "an edited source is named" {
  built "137-x86_64-$((SRC_MTIME - 60))"
  ensure
  rebuilt
  [[ "$output" == *"source"* ]]
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$SRC_MTIME" ]
}

@test "an edited binding.gyp moves the source stamp and is named" {
  built "137-x86_64-$SRC_MTIME"
  touch -t 202506010000 "$ADDON/binding.gyp"
  GYP_MTIME=$(stat -c %Y "$ADDON/binding.gyp" 2>/dev/null || stat -f %m "$ADDON/binding.gyp")
  ensure
  rebuilt
  [[ "$output" == *"source"* ]]
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$GYP_MTIME" ]
}

@test "a new header under src moves the source stamp" {
  built "137-x86_64-$SRC_MTIME"
  printf '#define AFPACKET 1\n' >"$ADDON/src/afpacket.h"
  touch -t 202506010000 "$ADDON/src/afpacket.h"
  HDR_MTIME=$(stat -c %Y "$ADDON/src/afpacket.h" 2>/dev/null || stat -f %m "$ADDON/src/afpacket.h")
  ensure
  rebuilt
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$HDR_MTIME" ]
}

@test "a build with no stamp is rebuilt and stamped" {
  built
  ensure
  rebuilt
  [[ "$output" == *"stamp"* ]]
  [ "$(cat "$ADDON/build/.stamp")" = "137-x86_64-$SRC_MTIME" ]
}

@test "a failed build warns, leaves no stamp and does not fail the task" {
  mock_bin pnpm 'exit 1'
  built "137-arm64-$SRC_MTIME"
  ensure
  [ "$status" -eq 0 ]
  [[ "$output" == *"WARN"* ]]
  [ ! -f "$ADDON/build/.stamp" ]
}
