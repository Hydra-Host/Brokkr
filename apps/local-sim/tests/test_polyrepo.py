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
    assert "stack-up || rc=$?" in tf, "task up must invoke the stack-up script directly"
    assert "scripts.stack-up" in nix, "stack-up script must be declared in devenv.nix"
    assert "devenv tasks run setup:preflight" in nix, "stack-up must run the preflight gate"


def test_task_up_stops_at_the_relogin_checkpoint_without_failing():
    tf = _read(TASKFILE)
    block = tf[tf.index("stack-up || rc=$?") :]
    assert block.index('"$rc" = 78') < block.index("✓ Stack reconciled."), (
        "the re-login checkpoint must stop before the ready banner"
    )
    assert 'exit "$rc"' in block, "a real bring-up failure must still propagate"


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


def test_stack_up_checks_host_access_before_the_claim():
    nix = _read(DEVENV_NIX)
    stack_up = nix[nix.index("scripts.stack-up") :]
    assert "host-access-check.sh" in stack_up, "stack-up must run the host-access check"
    assert stack_up.index("host-access-check.sh") < stack_up.index("stack-claim.sh"), (
        "a refused bring-up must not claim a slot it will never use"
    )


def test_doctor_report_delegates_to_the_host_access_check():
    nix = _read(POLYREPO_NIX)
    assert "dockerCheck" not in nix and "groupCheck" not in nix, (
        "the two Nix-string checks are retired — host-access-check.sh is the single authority"
    )
    assert "host-access-check.sh" in nix, "task doctor must call the host-access check"
    assert "--report" in nix, "the doctor needs the report exit codes, not the bring-up gate behaviour"


def test_doctor_passes_the_relogin_checkpoint_code_through():
    nix = _read(POLYREPO_NIX)
    assert "|| hostrc=$?" in nix, "a bare call aborts the whole verdict under the task runner's errexit"
    assert "78) stale=1 ;;" in nix, "the doctor must recognise the host check's re-login code"
    assert "exit 78" in nix, "the checkpoint code must reach setup:onboard's caller"
    verdict = nix[nix.index("case $hostrc in") :]
    assert verdict.index('[ "$fail" != 0 ]') < verdict.index('[ "$stale" != 0 ]'), (
        "a real blocker must outrank the re-login checkpoint"
    )


def test_devenv_ships_buildx_and_keeps_the_qemu_pins_overridable():
    nix = _read(DEVENV_NIX)
    assert "pkgs.docker-buildx" in nix, "the buildx plugin must be on the Linux devenv profile"
    for var in ("LOCAL_QEMU_EMULATOR", "LOCAL_EDK2_CODE_PATH", "LOCAL_EDK2_VARS_TEMPLATE_PATH"):
        assert f"{var} = lib.mkOptionDefault" in nix, f"{var} must stay .env-overridable"


def test_group_probe_stays_in_parity_with_the_installer():
    installer = _read(REPO_ROOT / "install.sh")
    check = _read(REPO_ROOT / "devenv" / "scripts" / "host-access-check.sh")
    for form in ('id -nG "$', "id -nG "):
        assert form in installer, f"install.sh lost the {form!r} form of the two-way group probe"
        assert form in check, f"host-access-check.sh lost the {form!r} form of the two-way group probe"


def test_taskfile_wires_sudo_teardown():
    tf = _read(TASKFILE)
    sudo_nix = _read(REPO_ROOT / "devenv" / "modules" / "sudo.nix")
    assert "- sudo-sim-teardown" in tf, "task sudo:teardown must invoke the sudo-sim-teardown script directly"
    assert "scripts.sudo-sim-teardown" in sudo_nix, "sudo-sim-teardown script must be declared in sudo.nix"
