"""c5一回運用のprivate契約。実hostへ接続しない純粋な判定だけ。"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


class ContractError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


FIXED_ACTIONS = (
    "pull", "asset_compose", "asset_updater", "quiet1",
    "cursor_config_images", "cursor_config_yaml", "cursor_volume_inspect",
    "cursor_run", "quiet2", "up",
)


_LAUNCH = re.compile(
    r"cd /home/kite/BellTeam && setsid nohup env "
    r"BELLTEAM_SERVER_IMAGE=(?P<image>[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}) "
    r"BELLTEAM_DEPLOY_QUIET_EXCEPT=(?P<quiet>[a-zA-Z0-9_-]+) "
    r"sh scripts/deploy-image\.sh > "
    r"(?P<log>runtime/backups/deploy-[0-9]{8}T[0-9]{6}\.log) "
    r"2>&1 < /dev/null &"
)


@dataclass(frozen=True)
class Launch:
    image: str
    quiet_except: str
    log: str


def parse_launch(command: str) -> Launch | None:
    if "deploy-image.sh" not in command and "setsid nohup" not in command:
        return None
    match = _LAUNCH.fullmatch(command)
    if not match:
        raise ContractError("C5_LAUNCH_SHAPE_MISMATCH")
    return Launch(match["image"], match["quiet"], match["log"])


def _time(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        raise ContractError("C5_TIME_INVALID") from None
    if result.tzinfo is None:
        raise ContractError("C5_TIME_INVALID")
    return result.astimezone(timezone.utc)


def load_plan(path: Path, expected_sha256: str) -> dict:
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ContractError("C5_PLAN_SHA_MISMATCH")
    try:
        plan = json.loads(content)
    except ValueError:
        raise ContractError("C5_PLAN_INVALID") from None
    if plan.get("schema") != "bellteam.c5.private-plan.v1":
        raise ContractError("C5_PLAN_SCHEMA_INVALID")
    for key in ("mode", "epoch", "run", "image", "source_sha", "host_repo_sha",
                "quiet_except", "window_start", "window_end", "observer_deadline",
                "gate_command", "launcher_path",
                "docker_frontend_dir", "state_dir", "phase_seconds", "asset_shas",
                "decision_seconds", "rollback_seconds", "script_shas",
                "lab_repo", "lab_child", "lab_docker", "lab_tmp_dir",
                "host_plan_path", "actions", "cursor_volume", "helper_caps",
                "cursor_caps_overlay", "cursor_caps_overlay_sha",
                "cursor_service_name", "cursor_network_mode"):
        if key not in plan:
            raise ContractError(f"C5_PLAN_MISSING_{key.upper()}")
    if plan["mode"] != "lab":
        raise ContractError("C5_PRODUCTION_NOT_ACCEPTED")
    if plan["run"] != plan["epoch"]:
        raise ContractError("C5_RUN_EPOCH_MISMATCH")
    if plan["actions"] != list(FIXED_ACTIONS):
        raise ContractError("C5_ACTION_PLAN_MISMATCH")
    for value in (plan["decision_seconds"], plan["rollback_seconds"],
                  *plan["phase_seconds"].values()):
        if type(value) is not int or value <= 0:
            raise ContractError("C5_PLAN_BUDGET_INVALID")
    if (set(plan["asset_shas"]) != {"compose.cursor-update.yaml",
                                   "scripts/update-cursor.sh"}
        or any(not re.fullmatch(r"[a-f0-9]{64}", value)
               for value in plan["asset_shas"].values())):
        raise ContractError("C5_PLAN_ASSET_SHA_INVALID")
    caps = plan["helper_caps"]
    if caps != {"nano_cpus": 1_000_000_000, "memory_bytes": 2_147_483_648,
                "memory_swap_bytes": 2_147_483_648, "pids_limit": 512}:
        raise ContractError("C5_HELPER_CAPS_INVALID")
    if not re.fullmatch(r"[a-f0-9]{64}", plan["cursor_caps_overlay_sha"]):
        raise ContractError("C5_OVERLAY_SHA_INVALID")
    if (Path(plan["lab_repo"]).resolve() == Path("/home/kite/BellTeam")
        or Path(plan["lab_child"]).name != "fake-deploy.sh"
        or Path(plan["lab_docker"]).name != "fake-docker"
        or Path(plan["gate_command"]).name != "fake-gate"):
        raise ContractError("C5_LAB_BINDING_INVALID")
    if not Path(plan["lab_tmp_dir"]).resolve().is_relative_to(
        Path(plan["lab_repo"]).resolve()
    ):
        raise ContractError("C5_LAB_TMP_INVALID")
    if not re.fullmatch(r"[a-f0-9]{64}", plan["source_sha"]):
        raise ContractError("C5_SOURCE_SHA_INVALID")
    if not re.fullmatch(r"[a-f0-9]{40}", plan["host_repo_sha"]):
        raise ContractError("C5_HOST_SHA_INVALID")
    if _time(plan["window_end"]) <= _time(plan["window_start"]):
        raise ContractError("C5_WINDOW_INVALID")
    return plan


def assert_launch_matches(plan: dict, launch: Launch) -> None:
    if (launch.image, launch.quiet_except) != (
        plan["image"], plan["quiet_except"]
    ):
        raise ContractError("C5_LAUNCH_PLAN_MISMATCH")


def _age(later: datetime, earlier: datetime, maximum: float, code: str) -> None:
    seconds = (later - earlier).total_seconds()
    if seconds < 0 or seconds > maximum:
        raise ContractError(code)


def _finite_number(value: object, integer: bool = False) -> int | float:
    if type(value) not in ((int,) if integer else (int, float)):
        raise ContractError("C5_GATE_NUMBER_INVALID")
    try:
        if not math.isfinite(value):
            raise ContractError("C5_GATE_NUMBER_INVALID")
    except OverflowError:
        raise ContractError("C5_GATE_NUMBER_INVALID") from None
    return value


def assert_fresh_gate(receipt: dict, plan: dict, plan_sha: str,
                      ordinal: int, state: dict, checked_at: datetime) -> None:
    if type(receipt.get("schemaVersion")) is not int or receipt["schemaVersion"] != 1:
        raise ContractError("C5_GATE_SCHEMA_INVALID")
    if (receipt.get("run") != plan["run"]
        or receipt.get("image") != plan["image"]
        or receipt.get("planSha256") != plan_sha
        or type(receipt.get("phaseOrdinal")) is not int
        or receipt["phaseOrdinal"] != ordinal):
        raise ContractError("C5_GATE_IDENTITY_MISMATCH")
    if (state.get("run") != plan["run"] or state.get("image") != plan["image"]
        or state.get("planSha256") != plan_sha
        or state.get("phaseOrdinal") != ordinal
        or state.get("phaseStatus") != "awaitingGate"):
        raise ContractError("C5_GATE_STATE_MISMATCH")
    if (type(receipt.get("ready")) is not bool or receipt["ready"] is not True
        or type(receipt.get("allowNextPhase")) is not bool
        or receipt["allowNextPhase"] is not True
        or receipt.get("reasons") != []):
        raise ContractError("C5_GATE_NOT_READY")
    now = checked_at.astimezone(timezone.utc)
    observed = _time(receipt.get("observedAt"))
    observer_deadline = _time(receipt.get("observerDeadline"))
    if observer_deadline != _time(plan["observer_deadline"]):
        raise ContractError("C5_GATE_DEADLINE_MISMATCH")
    _age(now, observed, 3, "C5_GATE_STALE")
    if (now >= observer_deadline or now >= _time(plan["window_end"])
        or observed >= observer_deadline):
        raise ContractError("C5_GATE_DEADLINE_EXPIRED")
    for deadline in ("phaseDeadline", "overallDeadline"):
        value = state.get(deadline)
        if value is not None and now >= _time(value):
            raise ContractError("C5_GATE_DEADLINE_EXPIRED")
    transition = _time(state["updatedAt"])
    if transition > observed:
        raise ContractError("C5_GATE_STATE_TIME_INVALID")
    frames = receipt.get("frames")
    if not isinstance(frames, list) or len(frames) != 4:
        raise ContractError("C5_GATE_FRAMES_MISSING")
    last_sample = None
    last_sequence = None
    last_swap = None
    last_oom = None
    for index, frame in enumerate(frames):
        try:
            sequence = frame["frameSeq"]
            if type(sequence) is not int or sequence < 0 or (
                last_sequence is not None and sequence != last_sequence + 1
            ):
                raise ContractError("C5_GATE_FRAME_SEQUENCE")
            sample_at = _time(frame["sampleAt"])
            frame_checked = _time(frame["checkedAt"])
            state_at = _time(frame["stateObservedAt"])
            metrics_at = _time(frame["metricsAt"])
            environment_at = _time(frame["environmentAt"])
            _age(frame_checked, sample_at, 2.5, "C5_GATE_SAMPLE_STALE")
            if frame_checked > now:
                raise ContractError("C5_GATE_FUTURE")
            _age(frame_checked, state_at, 2.5, "C5_GATE_STATE_STALE")
            _age(frame_checked, metrics_at, 7.5, "C5_GATE_METRICS_STALE")
            _age(frame_checked, environment_at, 35, "C5_GATE_ENV_STALE")
            if sample_at <= transition or (last_sample is not None and
                not 0 < (sample_at - last_sample).total_seconds() <= 2.5):
                raise ContractError("C5_GATE_INTERVAL_ORDER")
            if frame["intervalComplete"] is not (index != 0):
                raise ContractError("C5_GATE_INTERVAL_INCOMPLETE")
            if (frame["runnerPid"] != state["hostRunnerPid"]
                or frame["runnerStartTicks"] != state["hostRunnerStartTicks"]):
                raise ContractError("C5_GATE_RUNNER_MISMATCH")
            if (frame["statePhaseOrdinal"] != ordinal
                or frame["statePhaseStatus"] != "awaitingGate"):
                raise ContractError("C5_GATE_FRAME_STATE_MISMATCH")
            names = ("memAvailableGiB", "dockerFreeGiB", "dockerFreeLossGiB",
                     "tctlC", "memoryPsiFullAvg10Percent", "swapInOutKiBPerSec",
                     "oomDelta")
            values = {name: _finite_number(frame[name]) for name in names}
            swap = _finite_number(frame["swapCounterKiB"], integer=True)
            oom = _finite_number(frame["oomCounter"], integer=True)
            if (swap < 0 or oom < 0
                or last_swap is not None and swap < last_swap
                or last_oom is not None and oom < last_oom):
                raise ContractError("C5_GATE_COUNTER_REVERSED")
            if index and (values["memAvailableGiB"] < 14
                or values["dockerFreeGiB"] < 150
                or values["dockerFreeLossGiB"] > 20
                or values["tctlC"] >= 95
                or values["memoryPsiFullAvg10Percent"] >= 1
                or values["swapInOutKiBPerSec"] >= 32768
                or values["oomDelta"] != 0):
                raise ContractError("C5_GATE_FALSE")
        except (KeyError, TypeError):
            raise ContractError("C5_GATE_FRAME_INVALID") from None
        last_sequence, last_sample, last_swap, last_oom = sequence, sample_at, swap, oom
    if last_sample != observed:
        raise ContractError("C5_GATE_OBSERVED_MISMATCH")


def assert_phase_budget(plan: dict, phase: str, now: datetime) -> None:
    try:
        seconds = plan["phase_seconds"][phase]
        reserve = plan["decision_seconds"] + plan["rollback_seconds"]
    except (KeyError, TypeError):
        raise ContractError("C5_PHASE_BUDGET_MISSING") from None
    if not isinstance(seconds, int) or seconds <= 0:
        raise ContractError("C5_PHASE_BUDGET_INVALID")
    if not (_time(plan["window_start"]) <= now < _time(plan["window_end"])):
        raise ContractError("C5_OUTSIDE_WINDOW")
    if (_time(plan["window_end"]) - now).total_seconds() < seconds + reserve:
        raise ContractError("C5_WINDOW_BUDGET_EXHAUSTED")
