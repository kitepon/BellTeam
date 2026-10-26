"""補助containerの人工create→inspect→start→exit→rm境界。実Docker不可。"""

import hashlib
import json
import os
import re
import stat
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from c5_contract import ContractError
from c5_client_wait import (drain_and_reap_unknown,
                            publish_terminal_then_reap, terminated_unreaped)
from c5_inspect_contract import validate_inspect_json
from c5_runtime import runtime
from c5_state import (command_started, container_record,
                      phase_event, write_state as _state)


def _start_ticks(pid: int) -> int | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(fields[19])
    except FileNotFoundError:
        if Path("/proc").is_dir():
            raise ContractError("C5_CLIENT_START_TICKS_UNAVAILABLE") from None
        return time.monotonic_ns()  # Mac人工labのみ。


def helper_environment(plan: dict, state_path: Path, ordinal: int) -> dict[str, str]:
    if plan["mode"] == "production":
        docker_config = Path(plan["state_dir"]) / "empty-docker-config"
        docker_config.mkdir(mode=0o700, exist_ok=True)
        config_stat = docker_config.stat()
        if (docker_config.is_symlink() or config_stat.st_uid != os.getuid()
            or stat.S_IMODE(config_stat.st_mode) != 0o700
            or list(docker_config.iterdir())):
            raise ContractError("C5_HELPER_DOCKER_CONFIG_UNSAFE")
        env = {"PATH": "/usr/bin:/bin", "HOME": "/home/kite",
               "LANG": "C.UTF-8", "DOCKER_CONFIG": str(docker_config)}
        for key in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME",
                    "BELLTEAM_SERVER_IMAGE", "BELLTEAM_CURSOR_UPDATE_IMAGE",
                    "BELLTEAM_CURSOR_VOLUME", "BELLTEAM_INTERNAL_PROFILE_FILE"):
            if key in os.environ:
                env[key] = os.environ[key]
    else:
        env = dict(os.environ)
    env.update({"C5_EPOCH": plan["epoch"], "C5_ORDINAL": str(ordinal),
                "C5_STATE_PATH": str(state_path)})
    return env


def _run(plan: dict, state: dict, state_path: Path, argv: list[str],
         deadline: datetime, ordinal: int) -> bytes:
    remaining = (deadline - datetime.now(timezone.utc)).total_seconds()
    if remaining <= 0:
        raise ContractError("C5_HELPER_OUTCOME_UNKNOWN")
    env = helper_environment(plan, state_path, ordinal)
    child = subprocess.Popen([str(runtime(plan).docker), *argv],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        ticks = _start_ticks(child.pid)
    except ContractError:
        state.update({"helperClientPid": child.pid,
                      "phaseStatus": "unknown", "latch": True})
        _state(state_path, state)
        drain_and_reap_unknown(child)
        raise
    state.update({"helperClientPid": child.pid,
                  "helperClientStartTicks": ticks,
                  "helperCommand": argv})
    command_started(state, child.pid, ticks, deadline.isoformat(), plan["window_end"])
    _state(state_path, state)
    try:
        output, error, terminal = terminated_unreaped(
            child, time.monotonic() + remaining)
    except ContractError as failure:
        state.update({"phaseStatus": "unknown", "latch": True,
                      "phase_outcome": failure.code})
        phase_event(state, "unknown")
        _state(state_path, state)
        drain_and_reap_unknown(child)
        raise ContractError("C5_HELPER_OUTCOME_UNKNOWN") from None
    publish_terminal_then_reap(child, state, state_path, terminal, _state)
    if terminal["kind"] == "signal":
        raise ContractError("C5_HELPER_OUTCOME_UNKNOWN")
    if terminal["status"] != 0:
        raise ContractError("C5_HELPER_COMMAND_FAILED")
    state["helperClientPid"] = None
    _state(state_path, state)
    return output


def _inspect(plan: dict, state: dict, state_path: Path, cid: str,
             deadline: datetime, ordinal: int, name: str,
             expected_status: str, kind: str,
             asset_path: str | None = None) -> dict:
    raw = _run(plan, state, state_path, ["inspect", cid], deadline, ordinal)
    return validate_inspect_json(raw, plan, cid, name, ordinal,
                                 expected_status, kind, asset_path)


def _cid(raw: bytes) -> str:
    value = raw.decode().strip()
    if not (re.fullmatch(r"[a-f0-9]{64}", value)
            or re.fullmatch(r"labcid-[a-zA-Z0-9_-]+", value)):
        raise ContractError("C5_HELPER_CID_INVALID")
    return value


def cursor_create_argv(files: list[str]) -> list[str]:
    # compose createには--no-depsが無い。元updaterのcompose run側は変えない。
    return [*files, "create", "cursor-update"]


def run_helper(plan: dict, action: str, argv: list[str],
               state: dict, state_path: Path, budget_seconds: int) -> tuple[bytes, bytes]:
    if plan["mode"] == "production":
        from c5_preflight import host_static_preflight
        host_static_preflight(plan)
    else:
        runtime(plan)
    ordinal = state["phaseOrdinal"]
    deadline = datetime.now(timezone.utc) + timedelta(seconds=budget_seconds)
    if action.startswith("asset_"):
        path = argv[-1]
        name = f"c5-{plan['epoch']}-{ordinal}-asset"
        create = ["create", "--name", name,
                  "--label", f"c5.run={plan['run']}",
                  "--label", f"c5.ordinal={ordinal}",
                  "--cpus", "1", "--memory", "2g", "--memory-swap", "2g",
                  "--pids-limit", "512", "--pull", "never",
                  "--network", "none", "--read-only",
                  "--entrypoint", "/bin/cat", plan["image"], path]
        cid = _cid(_run(plan, state, state_path, create, deadline, ordinal))
        state.update({"helperCid": cid, "helperName": name, "helperStatus": "created"})
        container_record(state, name, cid, False, False)
        _state(state_path, state)
    elif action == "cursor_run":
        original = argv[2]
        overlay = Path(plan["cursor_caps_overlay"])
        if (hashlib.sha256(overlay.read_bytes()).hexdigest()
            != plan["cursor_caps_overlay_sha"]):
            raise ContractError("C5_OVERLAY_SHA_MISMATCH")
        files = ["compose", "-f", original, "-f", str(overlay)]
        _run(plan, state, state_path, cursor_create_argv(files),
             deadline, ordinal)
        cid = _cid(_run(plan, state, state_path,
                        [*files, "ps", "-q", "cursor-update"], deadline, ordinal))
        name = plan["cursor_service_name"]
        state.update({"helperCid": cid, "helperName": name, "helperStatus": "created"})
        container_record(state, name, cid, False, False)
        _state(state_path, state)
    else:
        raise ContractError("C5_HELPER_ACTION_INVALID")
    kind = "asset" if action.startswith("asset_") else "cursor"
    asset_path = argv[-1] if kind == "asset" else None
    _inspect(plan, state, state_path, cid, deadline, ordinal, name,
             "created", kind, asset_path)
    output = _run(plan, state, state_path, ["start", "-a", cid], deadline, ordinal)
    state["helperStatus"] = "started"
    _state(state_path, state)
    finished = _inspect(plan, state, state_path, cid, deadline, ordinal, name,
                        "exited", kind, asset_path)
    if finished["State"]["ExitCode"] != 0:
        raise ContractError("C5_HELPER_EXIT_FAILED")
    state["helperStatus"] = "exited"
    _state(state_path, state)
    _run(plan, state, state_path, ["rm", cid], deadline, ordinal)
    state["helperStatus"] = "removed"
    container_record(state, name, cid, False, True)
    _state(state_path, state)
    return output, b""
