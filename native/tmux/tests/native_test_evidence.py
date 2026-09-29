"""Copy sanitizer diagnostics only from the current fixture's private directory."""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys


def _private_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise ValueError("Sanitizer evidence directory must be private and owned")
    return fd


def export_sanitizer_evidence(root, strict=False):
    """Preserve a failing test's exception if diagnostic export itself fails."""
    destination = os.environ.get("TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR")
    if not destination:
        return
    failing = sys.exc_info()[0] is not None
    try:
        _export(root, destination)
    except Exception:
        if strict or not failing:
            raise
        print("Sanitizer diagnostic export failed; original failure preserved", file=sys.stderr)


def _export(root, destination):
    if not os.path.isabs(root) or not os.path.isabs(destination):
        raise ValueError("Absolute sanitizer evidence paths required")
    source_fd = _private_directory(root)
    destination_fd = None
    try:
        destination_fd = _private_directory(destination)
        # No global temporary-directory scan: root belongs to this exact fixture.
        names = sorted(name for name in os.listdir(source_fd) if name.startswith(("asan", "ubsan")))
        if not names:
            return
        if len(names) > 32:
            raise ValueError("Too many sanitizer logs")
        folder = pathlib.Path(root).name
        if not re.fullmatch(r"tmux-ide-[A-Za-z0-9_-]{1,100}", folder):
            raise ValueError("Unexpected fixture identity")
        os.mkdir(folder, mode=0o700, dir_fd=destination_fd)
        target_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination_fd)
        try:
            records = []
            total = 0
            for name in names:
                if not re.fullmatch(r"(?:asan|ubsan)(?:\.[0-9]+)?", name):
                    raise ValueError("Unexpected sanitizer filename")
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                        raise ValueError("Unsafe sanitizer log")
                    if info.st_size > 4 * 1024 * 1024:
                        raise ValueError("Sanitizer log exceeds bound")
                    with os.fdopen(fd, "rb", closefd=False) as stream:
                        data = stream.read(4 * 1024 * 1024 + 1)
                    total += len(data)
                    if len(data) != info.st_size or total > 32 * 1024 * 1024:
                        raise ValueError("Sanitizer logs changed or exceed bound")
                finally:
                    os.close(fd)
                out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_fd)
                with os.fdopen(out, "wb") as stream:
                    stream.write(data)
                records.append({"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            out = os.open("manifest.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=target_fd)
            with os.fdopen(out, "w") as stream:
                json.dump({"fixture": folder, "files": records}, stream)
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
