"""同じoperator sourceが使うlab/productionの固定配置。"""

from dataclasses import dataclass
from pathlib import Path

from c5_contract import ContractError


@dataclass(frozen=True)
class Runtime:
    repo: Path
    child: Path
    docker: Path
    temporary: Path
    observer: Path


def runtime(plan: dict) -> Runtime:
    mode = plan["mode"]
    if mode == "lab":
        repo = Path(plan["lab_repo"])
        child = Path(plan["lab_child"])
        docker = Path(plan["lab_docker"])
        temporary = Path(plan["lab_tmp_dir"])
        observer = Path(plan["lab_observer"])
        if (repo == Path("/home/kite/BellTeam")
            or child.name != "fake-deploy.sh"
            or docker.name != "fake-docker"
            or observer.name != "fakehost-emma-observer.py"
            or not temporary.resolve().is_relative_to(repo.resolve())):
            raise ContractError("C5_LAB_BINDING_INVALID")
        return Runtime(repo, child, docker, temporary, observer)
    if mode == "production":
        directory = Path(plan["state_dir"])
        repo = Path("/home/kite/BellTeam")
        return Runtime(repo, repo / "scripts/deploy-image.sh",
                       Path("/usr/bin/docker"), directory / "tmp",
                       Path(plan["observer_source_dir"]) / "c5_observer.py")
    raise ContractError("C5_MODE_INVALID")


def readonly_docker(plan: dict) -> Path:
    if plan["mode"] == "readonly_survey":
        return Path("/usr/bin/docker")
    return runtime(plan).docker
