from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pc_config import normalize_str

_TASKS = "/nix/store/0123456789abcdef0123456789abcdef-rust_devenv-tasks-2.2.2/bin/devenv-tasks"
_BASH = "#!/nix/store/0123456789abcdef0123456789abcdef-bash-interactive-5.3p9/bin/bash"


def test_erases_the_devenv_cli_version_so_the_snapshot_is_not_host_specific():
    assert normalize_str(_TASKS) == "/nix/store/$HASH-rust_devenv-tasks-$DEVENV_TASKS/bin/devenv-tasks"


def test_erases_any_devenv_cli_version_not_just_the_one_installed_here():
    for version in ("2.1.3", "2.2.2", "3.0", "10.11.12"):
        one = _TASKS.replace("2.2.2", version)
        assert normalize_str(one) == "/nix/store/$HASH-rust_devenv-tasks-$DEVENV_TASKS/bin/devenv-tasks"


def test_keeps_the_bash_version_because_the_nixpkgs_pin_owns_it():
    assert "bash-interactive-5.3p9" in normalize_str(_BASH)


def test_still_erases_the_store_hash():
    assert "0123456789abcdef" not in normalize_str(_BASH)


def test_still_erases_the_repo_path_and_home():
    from pc_config import REPO_ROOT

    assert normalize_str(f"{REPO_ROOT}/apps") == "$REPO/apps"
    assert normalize_str(f"{Path.home()}/.ssh") == "$HOME/.ssh"
