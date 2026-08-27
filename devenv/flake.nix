{
  description = "brokk-local Nix python runtime — sushy-tools + sim engine deps";

  # Pinned to a nixpkgs-26.05 rev: the entire closure
  # (sushy-tools/cliff/flask/libvirt-python) is validated against it.
  # Issue .2 consumes the same overlay/env via devenv; this flake is the
  # standalone build + CI target until then.
  #
  # This rev MUST equal devenv.yaml's nixpkgs pin — they're independent locks
  # (`devenv update` moves only devenv.lock). To bump: edit BOTH this URL and
  # devenv.yaml to the same rev, then run `nix flake update ./devenv`. CI fails
  # fast on drift, and the toolchain image is content-addressed (tag = inputhash),
  # so the change rebuilds it automatically — no manual tag bump.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/c69ae8fb8faeb3472fd11234ba55a70ac3601f9b";
    flake-utils.url = "github:numtide/flake-utils";
    # same treefmt config as devenv (devenv/treefmt-module.nix), evaluated here so the
    # config-baked wrapper can be baked into the lean CI image — dev + CI run an identical set.
    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      treefmt-nix,
      ...
    }:
    flake-utils.lib.eachSystem
      [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ]
      (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
            # statix-overlay is needed here too: this pkgs builds the treefmt wrapper.
            overlays = [
              (import ./pkgs/python-overlay.nix)
              (import ./pkgs/statix-overlay.nix)
            ];
          };
          pythonEnv = import ./pkgs/python-env.nix {
            python3Packages = pkgs.python312Packages;
          };
          # node + pnpm shared with devenv.nix (languages.javascript) so dev and CI can't drift.
          jsTools = import ./pkgs/js-tools.nix { inherit pkgs; };

          # config-baked treefmt from the SAME module devenv uses (../devenv/treefmt-module.nix,
          # sibling of this flake) — bundles nixfmt/statix/deadnix/shfmt/shellcheck/taplo/ruff. The
          # project prettier it execs comes from node_modules (CI `pnpm install`s before check).
          treefmtWrapper = (treefmt-nix.lib.evalModule pkgs ./treefmt-module.nix).config.build.wrapper;

          # Minimal NSS so user/home lookups resolve in the bare image (python's pwd.getpwuid,
          # sim-priv.sh's `getent passwd`). Root's home is /root — writable and created below —
          # so it agrees with HOME=/root and the tests' Path.home(). dockerTools.fakeNss isn't
          # used: it pins root's home to a read-only /var/empty, which the sim-priv tests can't
          # write under (they operate on throwaway files beneath the caller's home).
          ciNssFiles = [
            (pkgs.writeTextDir "etc/passwd" ''
              root:x:0:0:root:/root:/bin/sh
              nobody:x:65534:65534:nobody:/var/empty:/bin/sh
            '')
            (pkgs.writeTextDir "etc/group" ''
              root:x:0:
              nobody:x:65534:
            '')
            (pkgs.writeTextDir "etc/nsswitch.conf" ''
              passwd: files
              group: files
              hosts: files dns
            '')
          ];

          # The glibc ELF interpreter (its real store path) + its FHS basename. Prebuilt,
          # non-nix binaries (e.g. prisma's downloaded schema-engine) hard-code an FHS
          # interpreter path (/lib64/ld-linux-*.so.*) that a bare dockerTools image lacks,
          # so the build job's `prisma migrate` spawns fail with ENOENT. extraCommands
          # symlinks this loader to the FHS path; LD_LIBRARY_PATH (below) supplies its libs.
          fhsLoader = pkgs.stdenv.cc.bintools.dynamicLinker;
          fhsLoaderName = builtins.baseNameOf fhsLoader;

          # Lean CI toolchain: the slice of the devenv closure that validation needs
          # (JS + Python + db/secrets CLIs), deliberately without the fleet runtime
          # (qemu/libvirt/nginx/thanos). Reusing this pin + pythonEnv is what makes the
          # CI image a structural product of the dev env — node/pnpm/python can't drift.
          ciToolchain = with pkgs; [
            jsTools.nodejs # node — shared with devenv.nix via js-tools.nix
            jsTools.pnpm # pnpm — shared with devenv.nix via js-tools.nix
            pythonEnv # python 3.12 + ruff-less patched sim runtime (vbmc/sushy/pyghmi)
            ruff # rust binary, top-level (not in python-env.nix)
            postgresql_16 # psql / pg_isready — match devenv postgres + the postgres:16 CI service
            vault-bin # deploy jobs resolve their own secrets (DB URL, tokens) from Vault at run time
            go-task # provides `task`
            treefmtWrapper # config-baked `treefmt` for `task check:format` (formatters bundled)
            # native build toolchain for node-gyp deps (e.g. node-pty)
            gcc
            binutils
            gnumake
            # base userland for CI shell scripts
            openssl
            cacert
            git
            bashInteractive
            coreutils
            gnused
            gnugrep
            findutils
            gnutar
            gzip
            which
            cpio # local-sim live_initrd packs brokkr-live.img via `cpio -o -H newc`
            getent # sim-priv.sh resolves the caller's home via `getent passwd` (split out of glibc.bin)
            procps # ps/kill/pkill/pgrep — sim-priv.sh resolves these at startup (test_sim_priv)
            # bats runs the container-safe devenv/tests tier (Test Devenv Shell). The nix/ and
            # checkout/ tiers are deliberately not runnable here — one needs a nix binary, the
            # other a full devenv eval — so the pre-push hook covers those instead.
            bats
            # gawk, because bats-helpers.bash's fake ps/pgrep/lsof — the whole process surface the
            # reap matchers read — are awk programs. Nothing else in this list ships an awk.
            gawk
            # jq, because devenv/tests/stack-reconcile.bats runs stack-reconcile.sh, which reads
            # every process-compose status through it.
            jq
            # flock alone, not util-linux: sim-priv.sh's bootptab lock needs it, and without it
            # test_sim_priv's lock case skips itself and the linux branch ships uncovered. The whole
            # package would put a third `kill` into the buildEnv beside coreutils' and procps'.
            (runCommand "flock-for-ci" { } "mkdir -p $out/bin && ln -s ${util-linux}/bin/flock $out/bin/flock")
            # script(1) alone, same reasoning as flock: devenv/tests/installer-output.bats allocates
            # a pty with it to assert the installer's colour output, and without it those cases fail
            # the container tier with exit 127 rather than skipping.
            (runCommand "script-for-ci" { }
              "mkdir -p $out/bin && ln -s ${util-linux}/bin/script $out/bin/script"
            )
          ];
        in
        {
          packages = {
            inherit pythonEnv;
            default = pythonEnv;
          }
          # Darwin-only: socket_vmnet isn't in the pinned nixpkgs; expose it so CI
          # can build/cache it. Guarded so the Linux systems in eachSystem don't
          # evaluate a Darwin-only derivation.
          // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
            socket_vmnet = pkgs.callPackage ./pkgs/socket_vmnet.nix { };
          }
          # Linux-only: dockerTools needs a Linux builder. CI builds this on the
          # x86_64-linux runner and pushes it as the toolchain image other jobs run in.
          // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
            # skopeo from this same pinned nixpkgs, so the CI push step is reproducible
            # and doesn't resolve an unpinned `nixpkgs#skopeo` over the flake registry.
            inherit (pkgs) skopeo;

            # yq (mikefarah) for the build job's nixpkgs-pin drift guard — parses
            # devenv.yaml's inputs.nixpkgs.url structurally (not positional grep, which
            # could pick up another input's url). Pinned here for the same reason as skopeo.
            inherit (pkgs) yq-go;

            ciImage = pkgs.dockerTools.buildLayeredImage {
              name = "ci-toolchain";
              tag = "latest";
              # this nixpkgs pin's buildLayeredImage takes `contents` (pre-copyToRoot);
              # wrap in buildEnv for a single merged tree (no /bin collisions).
              contents = [
                (pkgs.buildEnv {
                  name = "ci-toolchain-root";
                  paths = ciToolchain;
                  pathsToLink = [
                    "/bin"
                    "/lib"
                    "/etc"
                    "/share"
                  ];
                })
              ]
              # /etc/passwd + /etc/group + /etc/nsswitch.conf (root + nobody) so user lookups
              # work in this otherwise bare image — python's pwd.getpwuid and sim-priv.sh's
              # `getent passwd` home resolution both need the running uid to resolve.
              ++ ciNssFiles;
              # dockerTools images are bare: create a writable /tmp (pnpm/node/prisma
              # allocate temp files) and /usr/bin/env (npm .bin shims and node-gyp use
              # `#!/usr/bin/env node` shebangs — without it eslint/tsc/turbo/vitest and
              # native installs fail with "cannot execute: required file not found").
              extraCommands = ''
                mkdir -m 1777 tmp
                mkdir -p usr/bin lib64 lib
                ln -s ${pkgs.coreutils}/bin/env usr/bin/env
                # FHS ELF interpreter so prebuilt glibc binaries (prisma's downloaded
                # schema-engine) can exec. Both locations are written: x86_64's interpreter
                # path is /lib64/<name>, aarch64's is /lib/<name>; the unused one is harmless.
                ln -s ${fhsLoader} lib64/${fhsLoaderName}
                ln -s ${fhsLoader} lib/${fhsLoaderName}
                # root's home (/root, per ciNssFiles) must exist: sim-priv.sh resolves it via
                # `getent passwd` and `cd`s into it, and the tests write throwaway files under it.
                mkdir -p root
              '';
              config = {
                Cmd = [ "/bin/bash" ];
                Env = [
                  "PATH=/bin"
                  "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                  "NODE_OPTIONS=--max-old-space-size=4096"
                  "TMPDIR=/tmp"
                  "HOME=/root" # match fakeNss's root entry so Path.home()/tools agree on the home
                  "LANG=C.UTF-8"
                  # libs for the FHS interpreter above to resolve (libssl/libcrypto, libstdc++/
                  # libgcc_s, libz, glibc) — all from this same pin, so nix tools' own RUNPATH
                  # deps are unaffected. Lets prisma's prebuilt schema-engine run on the image.
                  "LD_LIBRARY_PATH=${
                    pkgs.lib.makeLibraryPath [
                      pkgs.openssl
                      pkgs.stdenv.cc.cc.lib
                      pkgs.zlib
                      pkgs.glibc
                    ]
                  }"
                ];
                # Stamp the CI-computed inputhash into the image so the build job can detect
                # pin/recipe drift by reading the served image's own label — no separate
                # `:inputhash-<h>` tag that can desync (partial push / registry GC). getEnv is
                # "" in pure eval (local builds), set only by the CI build (nix build --impure).
                Labels = {
                  "host.hydrahost.ci.inputhash" = builtins.getEnv "HH_CI_TOOLCHAIN_INPUTHASH";
                };
              };
            };
          };

          devShells.default = pkgs.mkShell {
            packages = [
              pythonEnv
              pkgs.ruff
            ];
          };
        }
      );
}
