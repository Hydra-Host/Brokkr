from __future__ import annotations

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
POLYREPO_NIX = REPO_ROOT / "devenv" / "modules" / "polyrepo.nix"
DEVENV_NIX = REPO_ROOT / "devenv.nix"
TASKFILE = REPO_ROOT / "Taskfile.yml"

SETUP_TASKS = ("setup:preflight", "setup:doctor", "setup:onboard")


def _read(path: Path) -> str:
    if not path.exists():
        pytest.skip(f"{path.relative_to(REPO_ROOT)} not present")
    return path.read_text()


def test_polyrepo_module_declares_options_and_urls():
    nix = _read(POLYREPO_NIX)
    assert "options.polyrepo" in nix
    assert "hub = {" in nix or "hub =" in nix, "polyrepo.hub not declared"
    assert "spoke = {" not in nix and "spoke =" not in nix, (
        "polyrepo.spoke option must not exist post-monorepo-consolidation"
    )
    assert nix.count("path = lib.mkOption") >= 1, "hub needs a path option"
    assert nix.count("url = lib.mkOption") >= 1, "hub needs a clone-url option"


def test_setup_tasks_are_namespaced():
    nix = _read(POLYREPO_NIX)
    for task in SETUP_TASKS:
        assert f'"{task}"' in nix, f"{task} task missing from polyrepo.nix"
    assert '"preflight"' not in nix and '"doctor"' not in nix, (
        "onboarding tasks must stay namespaced (setup:*) — devenv rejects bare names at run time"
    )


def test_devenv_imports_module_and_derives_repo_paths():
    nix = _read(DEVENV_NIX)
    assert "./devenv/modules/polyrepo.nix" in nix, "devenv.nix must import the polyrepo module"
    assert "HUB_REPO_PATH = lib.mkOptionDefault (" in nix, "HUB_REPO_PATH must stay overridable"
    assert "expandHome config.polyrepo.hub.path" in nix, "HUB_REPO_PATH must derive from polyrepo.hub.path"
    assert 'config.polyrepo.hub.path == "" then repoRoot' in nix, "an unset hub path must fall back to this repo"
    assert "SPOKE_REPO_PATH" not in nix, "SPOKE_REPO_PATH must not be derived post-monorepo-consolidation"


def test_taskfile_wires_gate_and_verbs():
    tf = _read(TASKFILE)
    nix = _read(POLYREPO_NIX)
    assert "devenv tasks run setup:preflight" not in tf, (
        "the preflight gate must have exactly one call site (stack-up, after the slot claim)"
    )
    assert "devenv tasks run setup:onboard" in tf, "task setup verb missing"
    assert "- stack-doctor" in tf, "task doctor must invoke the stack-doctor script directly"
    assert "scripts.stack-doctor" in nix, "stack-doctor script must be declared in polyrepo.nix"


def test_taskfile_wires_stack_up():
    tf = _read(TASKFILE)
    nix = _read(DEVENV_NIX)
    assert "- cmd: stack-up" in tf, "task up must invoke the stack-up script directly"
    assert "scripts.stack-up" in nix, "stack-up script must be declared in devenv.nix"
    assert "devenv tasks run setup:preflight" in nix, "stack-up must run the preflight gate"


def test_stack_up_claims_slot_before_eval():
    nix = _read(DEVENV_NIX)
    assert "stack.slot.nix" in nix, "devenv.nix must conditionally import the claim pin"
    stack_up = nix[nix.index("scripts.stack-up") :]
    assert stack_up.index("stack-claim.sh") < stack_up.index('( cd "$DEVENV_ROOT" && devenv up -d )'), (
        "stack-up must claim the slot before devenv up -d evaluates"
    )
    assert stack_up.index("stack-claim.sh") < stack_up.index("devenv tasks run setup:preflight"), (
        "the preflight port scan must run after the claim or it scans slot 0's ports"
    )


def test_datastore_wipe_guard_is_single_sourced():
    nix = _read(DEVENV_NIX)
    assert "scripts.stack-await-down" in nix, "the datastore-wipe gate must be its own script"
    assert nix.count("stack-await-down") >= 2, "stack-reset must call the gate, not carry its own poll loop"
    assert "daemon_down" not in nix, "the daemon-down poll must live only in stack-await-down"


def test_taskfile_wires_sudo_teardown():
    tf = _read(TASKFILE)
    sudo_nix = _read(REPO_ROOT / "devenv" / "modules" / "sudo.nix")
    assert "- sudo-sim-teardown" in tf, "task sudo:teardown must invoke the sudo-sim-teardown script directly"
    assert "scripts.sudo-sim-teardown" in sudo_nix, "sudo-sim-teardown script must be declared in sudo.nix"
