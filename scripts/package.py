"""Create an install-ready Decky plugin archive."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VERSION = PACKAGE["version"]
OUTPUT = ROOT / "release" / f"TrainerDeck-{VERSION}.zip"
PREFIX = Path("TrainerDeck")
BRIDGE_DIRECTORY = Path("bin/bridge")
BRIDGE_FILES = (
    "TrainerDeckBridgeLauncher.exe",
    "TrainerDeckBridge.dll",
    "Mono.Cecil.dll",
    "THIRD_PARTY_NOTICES.txt",
    "trainerdeck-bridge.example.json",
)
ROOT_FILES = [
    Path("dist/index.js"),
    Path("main.py"),
    Path("package.json"),
    Path("plugin.json"),
    Path("README.md"),
    Path("LICENSE"),
    Path("docs/ARCHITECTURE.md"),
    Path("docs/FLING_BIDIRECTIONAL_SYNC.md"),
]
PYTHON_MODULES = [
    Path("trainerdeck_core.py"),
    Path("trainerdeck_runtime.py"),
]


def _archive_entries() -> list[tuple[Path, Path]]:
    entries = [(relative, relative) for relative in ROOT_FILES]
    entries.extend(
        (
            BRIDGE_DIRECTORY / filename,
            BRIDGE_DIRECTORY / filename,
        )
        for filename in BRIDGE_FILES
    )
    entries.extend(
        (relative, Path("py_modules") / relative.name)
        for relative in PYTHON_MODULES
    )
    return entries


def validate_archive(archive_path: Path) -> None:
    """Require an exact, current-release-only Decky archive."""
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
    manifests = [
        name
        for name in names
        if name.endswith("/plugin.json") and name.count("/") == 1
    ]
    expected = {
        (PREFIX / destination).as_posix()
        for _, destination in _archive_entries()
    }
    actual = set(names)
    missing = sorted(expected.difference(actual))
    extra = sorted(actual.difference(expected))
    if manifests != ["TrainerDeck/plugin.json"] or missing or extra:
        details = []
        if manifests != ["TrainerDeck/plugin.json"]:
            details.append(f"top-level manifests: {manifests!r}")
        if missing:
            details.append("missing: " + ", ".join(missing))
        if extra:
            details.append("unexpected: " + ", ".join(extra))
        raise SystemExit("Invalid Decky archive: " + "; ".join(details))


def main() -> None:
    archive_entries = _archive_entries()
    missing = [
        str(source)
        for source, _ in archive_entries
        if not (ROOT / source).is_file()
    ]
    if missing:
        raise SystemExit(
            "Missing package files: " + ", ".join(sorted(set(missing)))
        )

    actual_bridge = {
        path.name
        for path in (ROOT / BRIDGE_DIRECTORY).iterdir()
        if path.is_file() and path.suffix.casefold() not in {".pdb", ".xml"}
    }
    expected_bridge = set(BRIDGE_FILES)
    stale = sorted(actual_bridge.difference(expected_bridge))
    if stale:
        raise SystemExit(
            "Stale bridge files must be removed before packaging: "
            + ", ".join(stale)
        )
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        OUTPUT,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for source, destination in archive_entries:
            archive.write(
                ROOT / source,
                (PREFIX / destination).as_posix(),
            )
    validate_archive(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    main()
