"""Materialize compiled slate modules and assets without authored configuration."""

import shutil
import sys
import tarfile
import tempfile
from pathlib import Path


def regular_file(member, destination):
    if not (member.isfile() or member.isdir()):
        raise ValueError("Build artifacts must contain only regular files and directories")
    return tarfile.data_filter(member, destination)


def prepare(archive: Path, destination: Path):
    with tempfile.TemporaryDirectory() as staging:
        with tarfile.open(archive) as source:
            source.extractall(staging, filter=regular_file)

        server = Path(staging) / "build/server"
        # Require the framework's entrypoint before creating a deployable directory.
        (server / "index.js").stat()
        destination.mkdir()
        for module in server.rglob("*"):
            if module.is_file() and module.suffix in (".js", ".mjs"):
                target = destination / "server" / module.relative_to(server)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(module, target)
        shutil.copytree(Path(staging) / "build/client", destination / "client")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
