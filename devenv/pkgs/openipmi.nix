{
  lib,
  stdenv,
  fetchFromGitHub,
  autoreconfHook,
  pkg-config,
  openssl,
  popt,
  ncurses,
}:
stdenv.mkDerivation (_finalAttrs: {
  pname = "openipmi";
  version = "2.0-lanserv-20024d5";

  src = fetchFromGitHub {
    owner = "wrouesnel";
    repo = "openipmi";
    rev = "20024d5c42ae2153c4dde6496a066c3b66b2ff76";
    hash = "sha256-aOezdtuay5In+DwnESXqDWve6y2jTXX3D+v1YjEBHIg=";
  };

  patches = [ ../patches/openipmi-2.0-macos-build.patch ];

  nativeBuildInputs = [
    autoreconfHook
    pkg-config
  ];
  buildInputs = [
    openssl
    popt
    ncurses
  ];

  configureFlags = [
    "--without-perl"
    "--without-python"
    "--without-tcl"
    "--without-glib"
  ];

  buildPhase = ''
    runHook preBuild
    for d in include utils lib unix lanserv; do
      make -C "$d" -j"$NIX_BUILD_CORES"
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    for d in include utils lib unix lanserv; do
      make -C "$d" install
    done
    runHook postInstall
  '';

  env.CFLAGS = "-O2 -std=gnu17 -Wno-error=implicit-function-declaration -Wno-error=implicit-int";

  meta = {
    description = "OpenIPMI lanserv ipmi_sim BMC simulator (wrouesnel fork, macOS-patched)";
    homepage = "https://github.com/wrouesnel/openipmi";
    license = lib.licenses.lgpl21Plus;
    platforms = lib.platforms.unix;
    mainProgram = "ipmi_sim";
  };
})
