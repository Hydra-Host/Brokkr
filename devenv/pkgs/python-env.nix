# The single python environment whose bin/ holds python + sushy-emulator +
# pytest. This is the canonical Nix runtime, reused by both devenv.nix
# (`languages.python`) and flake.nix — one source of truth.
#
# pyproject.toml is the human-readable dep manifest (and the committed uv.lock
# drives an optional, non-Nix `uv sync` venv for IDE/dev convenience — not the
# supported runtime). The deps below mirror that manifest; the one intentional
# deviation is libvirt-python (see ps.libvirt note).
#
# Note: ruff is a Rust binary in nixpkgs (pkgs.ruff), not a python package, so it
# is provided as a top-level package by the flake/devenv, not here.
{ python3Packages }:
python3Packages.python.withPackages (ps: [
  # project runtime deps (mirror pyproject.toml [project].dependencies)
  ps.pydantic
  ps.pydantic-settings
  ps.pyyaml
  ps.jinja2
  ps.click
  ps.rich
  ps.psycopg
  ps.redis
  ps.termcolor
  ps.libvirt
  # test deps (pyproject [dependency-groups].dev, minus ruff)
  ps.pytest
  ps.pytest-cov
  ps.allure-pytest
  ps.sushy-tools
  ps.setuptools
])
