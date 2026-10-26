"""Docker inspectの意味的投影。fake CIDやlab実行には依存しない。"""

import json

from c5_contract import ContractError


def validate_helper_inspect(item: dict, plan: dict, cid: str, name: str,
                            ordinal: int, expected_status: str,
                            kind: str, asset_path: str | None = None) -> None:
    try:
        config = item["Config"]
        host = item["HostConfig"]
        state = item["State"]
        labels = config["Labels"]
        caps = plan["helper_caps"]
        if (item["Id"] != cid or item["Name"] != "/" + name
            or config["Image"] != plan["image"]
            or labels["c5.run"] != plan["run"]
            or labels["c5.ordinal"] != str(ordinal)
            or state["Status"] != expected_status):
            raise ContractError("C5_HELPER_IDENTITY_MISMATCH")
        for key, expected in (
            ("NanoCpus", caps["nano_cpus"]),
            ("Memory", caps["memory_bytes"]),
            ("MemorySwap", caps["memory_swap_bytes"]),
            ("PidsLimit", caps["pids_limit"]),
        ):
            if type(host[key]) is not int or host[key] != expected:
                raise ContractError("C5_HELPER_HOSTCONFIG_MISMATCH")
        if host["ReadonlyRootfs"] is not True:
            raise ContractError("C5_HELPER_HOSTCONFIG_MISMATCH")
        mounts = item["Mounts"]
        if kind == "asset":
            if (asset_path is None or mounts != []
                or host["NetworkMode"] != "none"
                or config["Entrypoint"] != ["/bin/cat"]
                or config["Cmd"] != [asset_path]):
                raise ContractError("C5_HELPER_ASSET_IDENTITY_MISMATCH")
        elif kind == "cursor":
            if not isinstance(mounts, list) or len(mounts) != 1:
                raise ContractError("C5_HELPER_CURSOR_MOUNT_MISMATCH")
            mount = mounts[0]
            if (mount["Type"] != "volume"
                or mount["Name"] != plan["cursor_volume"]
                or mount["Destination"] != "/home/bell/.local"
                or mount["RW"] is not True):
                raise ContractError("C5_HELPER_CURSOR_MOUNT_MISMATCH")
            if (host["NetworkMode"] != plan["cursor_network_mode"]
                or host["CapDrop"] != ["ALL"]
                or host["SecurityOpt"] != ["no-new-privileges:true"]
                or host["Init"] is not True
                or host["Tmpfs"] != {
                    "/tmp": "exec,size=512m",
                    "/home/bell": "uid=1000,gid=1000,mode=0700,size=64m",
                }
                or config["User"] != "1000:1000"
                or config["Entrypoint"] != ["/usr/local/bin/bellteam-update-cursor"]
                or config["Cmd"] != []):
                raise ContractError("C5_HELPER_CURSOR_IDENTITY_MISMATCH")
        else:
            raise ContractError("C5_HELPER_KIND_INVALID")
    except (KeyError, IndexError, TypeError):
        raise ContractError("C5_HELPER_INSPECT_INCOMPLETE") from None


def validate_inspect_json(raw: bytes, plan: dict, cid: str, name: str,
                          ordinal: int, expected_status: str,
                          kind: str, asset_path: str | None = None) -> dict:
    """実docker inspectの保存原bytesもCI原本も同じ入口で検査する。"""
    try:
        items = json.loads(raw)
        if not isinstance(items, list) or len(items) != 1:
            raise ValueError
    except (ValueError, TypeError):
        raise ContractError("C5_HELPER_INSPECT_INVALID") from None
    item = items[0]
    validate_helper_inspect(item, plan, cid, name, ordinal,
                            expected_status, kind, asset_path)
    return item
