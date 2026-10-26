"""私有labの製品境界。dataは照合だけ行い、Docker結果不明は未解決のまま残す。"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import stat

from c5_contract import ContractError
from c5_preserve_data import capture


INSPECT_TEMPLATE = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},'
    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"configHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},'
    '"status":{{json .State.Status}},'
    '"health":{{json .State.Health.Status}},'
    '"startedAt":{{json .State.StartedAt}},'
    '"restartCount":{{json .RestartCount}}}'
)
INSPECT = ["inspect", "--type", "container", "--format",
           INSPECT_TEMPLATE, "bellteam"]
CONFIG_HASH = ["compose", "config", "--hash", "bellteam"]
UP = ["compose", "up", "-d", "--no-build", "--pull", "never"]


def _stamp():
    return datetime.now(timezone.utc).isoformat()


def _save_once(path: Path, value: dict) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     allow_nan=False).encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ContractError("C5_PRODUCT_RECEIPT_EXISTS") from None
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(raw).hexdigest()


def _load_receipt(path: Path) -> dict:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            raw = stream.read(1024 * 1024 + 1)
            after = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_uid != os.getuid() or before.st_nlink != 1
            or len(raw) > 1024 * 1024
            or tuple(getattr(before, key) for key in
                     ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"))
                != tuple(getattr(after, key) for key in
                         ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"))):
            raise ValueError
        return json.loads(raw)
    except (OSError, ValueError, TypeError):
        raise ContractError("C5_PRODUCT_RECEIPT_INVALID") from None


def _container(raw: bytes) -> dict:
    try:
        item = json.loads(raw)
        if (type(item) is not dict
            or set(item) != {"id", "name", "imageId", "imageRef",
                             "project", "service", "configHash", "status",
                             "health", "startedAt", "restartCount"}):
            raise ValueError
        if (item["name"] != "/bellteam"
            or item["project"] != "bellteam"
            or item["service"] != "bellteam"
            or not re.fullmatch(r"[a-f0-9]{64}", item["id"])
            or not re.fullmatch(r"[a-f0-9]{64}", item["configHash"])
            or type(item["restartCount"]) is not int
            or item["restartCount"] < 0
            or not isinstance(item["startedAt"], str)
            or not item["startedAt"]):
            raise ValueError
        return {key: item[key] for key in
                ("id", "imageRef", "imageId", "status", "health",
                 "startedAt", "restartCount", "configHash")}
    except (ValueError, KeyError, TypeError, IndexError):
        raise ContractError("C5_PRODUCT_INSPECT_INVALID") from None


def _file_sha(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ContractError("C5_CURSOR_CODE_POINT_MISSING")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _data(plan: dict, before: dict | None = None) -> dict:
    try:
        result = capture(plan["product_hooks"]["data_root"], before)
    except (OSError, ValueError, KeyError, TypeError):
        raise ContractError("C5_DATA_BASELINE_UNAVAILABLE") from None
    required = plan["product_hooks"]["required_history"]
    if any(name not in result["history"] for name in required):
        raise ContractError("C5_DATA_BASELINE_INCOMPLETE")
    return result


def capture_pre_up(plan: dict, state_dir: Path, readonly) -> tuple[dict, str]:
    """quiet②後に一回だけ採る。readonlyは固定argv→bytesの境界。"""
    hooks = plan["product_hooks"]
    if _file_sha(Path(__file__).with_name("c5_preserve_data.py")) != hooks["preserve_source_sha"]:
        raise ContractError("C5_PRESERVE_SOURCE_MISMATCH")
    old = _container(readonly(INSPECT))
    if (old["id"] != hooks["before_container_id"]
        or old["imageRef"] != hooks["before_image_ref"]
        or old["imageId"] != hooks["before_image_id"]
        or old["startedAt"] != hooks["before_started_at"]
        or old["restartCount"] != hooks["before_restart_count"]
        or old["status"] != "running" or old["health"] != "healthy"):
        raise ContractError("C5_PRODUCT_BEFORE_MISMATCH")
    config_hash = readonly(CONFIG_HASH).decode().strip()
    if (len(config_hash.split()) != 2 or config_hash.split()[0] != "bellteam"
        or not re.fullmatch(r"[a-f0-9]{64}", config_hash.split()[1])):
        raise ContractError("C5_PRODUCT_CONFIG_HASH_INVALID")
    backup = Path(hooks["cursor_code_path"])
    if _file_sha(backup) != hooks["cursor_code_sha"]:
        raise ContractError("C5_CURSOR_CODE_POINT_MISMATCH")
    record = {"schema": "bellteam.c5.pre-up.v1", "run": plan["run"],
              "at": _stamp(), "before": old,
              "targetConfigHash": config_hash.split()[1],
              "cursorCodeSha256": hooks["cursor_code_sha"],
              "data": _data(plan)}
    digest = _save_once(state_dir / (plan["epoch"] + ".pre-up.json"), record)
    return record, digest


def capture_post_up(plan: dict, state_dir: Path, before: dict, readonly) -> tuple[dict, str]:
    """一回upの結果を読取記録する。dataの差は返し、復元しない。"""
    hooks = plan["product_hooks"]
    current = _container(readonly(INSPECT))
    if (current["id"] == before["before"]["id"]
        or current["imageRef"] != plan["image"]
        or current["imageId"] != hooks["target_image_id"]
        or current["status"] != "running"):
        raise ContractError("C5_PRODUCT_AFTER_MISMATCH")
    record = {"schema": "bellteam.c5.post-up.v1", "run": plan["run"],
              "at": _stamp(), "current": current,
              "data": _data(plan, before["data"])}
    digest = _save_once(state_dir / (plan["epoch"] + ".post-up.json"), record)
    return record, digest


def inspect_unknown_up(plan: dict, state_dir: Path, readonly) -> tuple[dict, str]:
    """up clientが不明でも一度だけread-only。結果を成功/失敗へ補完しない。"""
    record = {"schema": "bellteam.c5.up-unknown.v1", "run": plan["run"],
              "at": _stamp(), "outcome": "unresolved"}
    try:
        record["observed"] = _container(readonly(INSPECT))
    except (ContractError, OSError):
        record["observation"] = "unavailable"
    digest = _save_once(state_dir / (plan["epoch"] + ".up-unknown.json"), record)
    return record, digest


def rollback_once(plan: dict, state_dir: Path, before: dict, post: dict,
                  decision: dict, permission_check, readonly,
                  up_previous) -> tuple[dict, str]:
    """別許可の一回code/image戻し。callerが許可原本を検証してから呼ぶ。"""
    hooks = plan["product_hooks"]
    if ((state_dir / (plan["epoch"] + ".up-unknown.json")).exists()
        or _load_receipt(state_dir / (plan["epoch"] + ".pre-up.json")) != before
        or _load_receipt(state_dir / (plan["epoch"] + ".post-up.json")) != post):
        raise ContractError("C5_ROLLBACK_EVIDENCE_MISMATCH")
    if (decision != {"kind": "authorized_code_image_return",
                     "run": plan["run"],
                     "currentContainerId": post["current"]["id"],
                     "previousImageRef": hooks["before_image_ref"],
                     "permissionId": decision.get("permissionId")}
        or type(decision.get("permissionId")) is not str
        or not decision["permissionId"]):
        raise ContractError("C5_ROLLBACK_DECISION_INVALID")
    permission = permission_check(decision)
    if permission != {"permissionId": decision["permissionId"],
                      "run": plan["run"], "scope": "bellteam_container_restart",
                      "authorized": True}:
        raise ContractError("C5_ROLLBACK_PERMISSION_UNVERIFIED")
    now = datetime.now(timezone.utc)
    window_end = datetime.fromisoformat(plan["window_end"].replace("Z", "+00:00"))
    if (window_end - now).total_seconds() < plan["rollback_seconds"]:
        raise ContractError("C5_ROLLBACK_BUDGET_EXHAUSTED")
    current = _container(readonly(INSPECT))
    if (any(current[key] != post["current"][key] for key in
            ("id", "imageRef", "imageId", "configHash",
             "startedAt", "restartCount"))
        or current["imageRef"] != plan["image"]
        or current["status"] != "running"):
        raise ContractError("C5_ROLLBACK_LIVE_IDENTITY_MISMATCH")
    claim = state_dir / (plan["epoch"] + ".rollback.claim")
    _save_once(claim, {"run": plan["run"], "permissionId": decision["permissionId"],
                       "oldImage": hooks["before_image_ref"], "at": _stamp()})
    # この一回だけ元imageへ戻す。DB/HOME/会話やCursor volumeは触らない。
    try:
        up_previous(hooks["before_image_ref"], UP)
    except (ContractError, OSError):
        record = {"schema": "bellteam.c5.rollback-unknown.v1",
                  "run": plan["run"], "at": _stamp(),
                  "outcome": "unresolved", "permissionId": decision["permissionId"]}
        try:
            record["observed"] = _container(readonly(INSPECT))
        except (ContractError, OSError):
            record["observation"] = "unavailable"
        _save_once(state_dir / (plan["epoch"] + ".rollback-unknown.json"), record)
        raise ContractError("C5_ROLLBACK_OUTCOME_UNKNOWN") from None
    restored = _container(readonly(INSPECT))
    if (restored["id"] == current["id"]
        or restored["imageRef"] != hooks["before_image_ref"]
        or restored["imageId"] != hooks["before_image_id"]
        or restored["status"] != "running"):
        raise ContractError("C5_ROLLBACK_RESULT_UNKNOWN")
    record = {"schema": "bellteam.c5.rollback.v1", "run": plan["run"],
              "at": _stamp(), "permissionId": decision["permissionId"],
              "before": before["before"], "from": current, "restored": restored,
              "data": _data(plan, before["data"])}
    digest = _save_once(state_dir / (plan["epoch"] + ".rollback.json"), record)
    return record, digest
