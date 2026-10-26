"""Root側stateの単独writer。Emma read_state向け0600 atomic replace。"""

import json
import os
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path

from c5_contract import ContractError


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_state(path: Path, state: dict) -> None:
    state["updatedAt"] = utc_now()
    raw = json.dumps(state, sort_keys=True, separators=(",", ":"),
                     allow_nan=False).encode()
    if len(raw) > 65536:
        raise ContractError("C5_STATE_TOO_LARGE")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / (path.name + "." + secrets.token_hex(8) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_state_identity(path: Path) -> tuple[dict, tuple]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(65537)
        after = os.fstat(stream.fileno())
    linked = os.lstat(path)
    keys = ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink",
            "st_size", "st_mtime_ns", "st_ctime_ns")
    identity = tuple(getattr(before, key) for key in keys)
    if (len(raw) > 65536 or not stat.S_ISREG(before.st_mode)
        or stat.S_IMODE(before.st_mode) != 0o600
        or before.st_uid != os.getuid() or before.st_nlink != 1
        or identity != tuple(getattr(after, key) for key in keys)
        or identity != tuple(getattr(linked, key) for key in keys)):
        raise ContractError("C5_STATE_FILE_IDENTITY")
    try:
        value = json.loads(raw)
    except ValueError:
        raise ContractError("C5_STATE_JSON_INVALID") from None
    if not isinstance(value, dict):
        raise ContractError("C5_STATE_JSON_INVALID")
    return value, identity


def phase_event(state: dict, status: str) -> None:
    state.setdefault("phaseEvents", []).append({
        "phaseOrdinal": state["phaseOrdinal"], "phase": state["phase"],
        "status": status, "at": utc_now(),
    })


def command_started(state: dict, pid: int, ticks: int,
                    phase_deadline: str, overall_deadline: str) -> None:
    if type(pid) is not int or pid <= 0 or type(ticks) is not int or ticks <= 0:
        raise ContractError("C5_COMMAND_IDENTITY_INVALID")
    state["phaseDeadline"] = phase_deadline
    state["overallDeadline"] = overall_deadline
    state.setdefault("commands", []).append({
        "phaseOrdinal": state["phaseOrdinal"], "pid": pid,
        "startTicks": ticks, "startedAt": utc_now(), "endedAt": None,
    })
    state["phaseStatus"] = "running"
    phase_event(state, "running")


def command_terminal(state: dict, pid: int, terminal: dict) -> None:
    if (not isinstance(terminal, dict)
        or set(terminal) != {"kind", "status"}
        or terminal["kind"] not in ("exit", "signal")
        or type(terminal["status"]) is not int
        or terminal["status"] < 0):
        raise ContractError("C5_COMMAND_TERMINAL_INVALID")
    matches = [row for row in state["commands"]
               if row["phaseOrdinal"] == state["phaseOrdinal"]
               and row["pid"] == pid and row["endedAt"] is None]
    if len(matches) != 1:
        raise ContractError("C5_COMMAND_END_UNMATCHED")
    matches[0]["endedAt"] = utc_now()
    matches[0]["terminal"] = terminal
    status = ("prepared" if terminal == {"kind": "exit", "status": 0}
              else "held" if terminal["kind"] == "exit" else "unknown")
    state["phaseStatus"] = status
    phase_event(state, status)


def container_record(state: dict, name: str, cid: str,
                     running: bool, removed: bool) -> None:
    if type(running) is not bool or type(removed) is not bool:
        raise ContractError("C5_CONTAINER_STATE_INVALID")
    rows = state.setdefault("containers", [])
    match = next((row for row in rows if row["id"] == cid), None)
    if match is None:
        match = {"name": name, "id": cid, "running": running, "removed": removed}
        rows.append(match)
    else:
        if match["name"] != name:
            raise ContractError("C5_CONTAINER_IDENTITY_MISMATCH")
        match.update(running=running, removed=removed)
    if len(rows) > 8:
        raise ContractError("C5_CONTAINER_LIMIT")
