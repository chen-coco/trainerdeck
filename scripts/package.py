"""Create an install-ready Decky plugin archive."""

from __future__ import annotations

import json
import struct
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
VERSION = PACKAGE["version"]
OUTPUT = ROOT / "release" / f"TrainerDeck-{VERSION}.zip"
PREFIX = Path("TrainerDeck")
BRIDGE_DIRECTORY = Path("bin/bridge")
BRIDGE_HOST_FILE = "TrainerDeckBridgeLauncher.exe"
BRIDGE_FILES = (
    BRIDGE_HOST_FILE,
    "Mono.Cecil.dll",
    "THIRD_PARTY_NOTICES.txt",
    "trainerdeck-bridge.example.json",
)
BRIDGE_EMBEDDED_RESOURCES = (
    ("TrainerDeckBridge.Clr2.dll", "TrainerDeckBridge.Clr2.dll", 2),
    ("TrainerDeckBridge.Clr4.dll", "TrainerDeckBridge.Clr4.dll", 4),
)
BRIDGE_BUILD_ONLY_FILES = tuple(
    filename for _, filename, _ in BRIDGE_EMBEDDED_RESOURCES
)

_CODED_INDEXES = {
    "ResolutionScope": ((0, 26, 35, 1), 2),
    "TypeDefOrRef": ((2, 1, 27), 2),
    "MemberRefParent": ((2, 1, 26, 6, 27), 3),
    "HasConstant": ((4, 8, 23), 2),
    "HasCustomAttribute": (
        (6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27,
         32, 35, 38, 39, 40, 42, 44, 43),
        5,
    ),
    "CustomAttributeType": ((6, 10), 3),
    "HasFieldMarshal": ((4, 8), 1),
    "HasDeclSecurity": ((2, 6, 32), 2),
    "HasSemantics": ((20, 23), 1),
    "MethodDefOrRef": ((6, 10), 1),
    "MemberForwarded": ((4, 6), 1),
    "Implementation": ((38, 35, 39), 2),
    "TypeOrMethodDef": ((2, 6), 1),
}

_TABLE_SCHEMAS = {
    0: ("u2", "str", "guid", "guid", "guid"),
    1: (("coded", "ResolutionScope"), "str", "str"),
    2: (
        "u4", "str", "str", ("coded", "TypeDefOrRef"),
        ("table", 4), ("table", 6),
    ),
    3: (("table", 4),),
    4: ("u2", "str", "blob"),
    5: (("table", 6),),
    6: ("u4", "u2", "u2", "str", "blob", ("table", 8)),
    7: (("table", 8),),
    8: ("u2", "u2", "str"),
    9: (("table", 2), ("coded", "TypeDefOrRef")),
    10: (("coded", "MemberRefParent"), "str", "blob"),
    11: ("u1", "u1", ("coded", "HasConstant"), "blob"),
    12: (
        ("coded", "HasCustomAttribute"),
        ("coded", "CustomAttributeType"),
        "blob",
    ),
    13: (("coded", "HasFieldMarshal"), "blob"),
    14: ("u2", ("coded", "HasDeclSecurity"), "blob"),
    15: ("u2", "u4", ("table", 2)),
    16: ("u4", ("table", 4)),
    17: ("blob",),
    18: (("table", 2), ("table", 20)),
    19: (("table", 20),),
    20: ("u2", "str", ("coded", "TypeDefOrRef")),
    21: (("table", 2), ("table", 23)),
    22: (("table", 23),),
    23: ("u2", "str", "blob"),
    24: ("u2", ("table", 6), ("coded", "HasSemantics")),
    25: (
        ("table", 2),
        ("coded", "MethodDefOrRef"),
        ("coded", "MethodDefOrRef"),
    ),
    26: ("str",),
    27: ("blob",),
    28: (
        "u2", ("coded", "MemberForwarded"), "str", ("table", 26),
    ),
    29: ("u4", ("table", 4)),
    30: ("u4", "u4"),
    31: ("u4",),
    32: (
        "u4", "u2", "u2", "u2", "u2", "u4", "blob", "str", "str",
    ),
    33: ("u4",),
    34: ("u4", "u4", "u4"),
    35: (
        "u2", "u2", "u2", "u2", "u4", "blob", "str", "str", "blob",
    ),
    36: ("u4", ("table", 35)),
    37: ("u4", "u4", "u4", ("table", 35)),
    38: ("u4", "str", "blob"),
    39: ("u4", "u4", "str", "str", ("coded", "Implementation")),
    40: ("u4", "u4", "str", ("coded", "Implementation")),
    41: (("table", 2), ("table", 2)),
    42: ("u2", "u2", ("coded", "TypeOrMethodDef"), "str"),
    43: (("coded", "MethodDefOrRef"), "blob"),
    44: (("table", 42), ("coded", "TypeDefOrRef")),
}
ROOT_FILES = [
    Path("dist/index.js"),
    Path("main.py"),
    Path("package.json"),
    Path("plugin.json"),
    Path("README.md"),
    Path("README_EN.md"),
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


class _ManagedImageError(ValueError):
    """Raised when a PE/CLI image is malformed or unsupported."""


class _ManagedImage:
    """Minimal checked PE/CLI metadata reader for release validation."""

    def __init__(self, image: bytes, label: str):
        self.image = image
        self.label = label
        self._sections: list[tuple[int, int, int, int]] = []
        self.row_counts: dict[int, int] = {}
        self.table_offsets: dict[int, int] = {}
        self.table_row_sizes: dict[int, int] = {}
        self._parse_pe()
        self._parse_metadata()

    def _error(self, message: str) -> _ManagedImageError:
        return _ManagedImageError(f"{self.label}: {message}")

    def _require(self, offset: int, size: int, description: str) -> None:
        if offset < 0 or size < 0 or offset + size > len(self.image):
            raise self._error(f"truncated {description}")

    def _unpack(self, format_string: str, offset: int, description: str):
        size = struct.calcsize(format_string)
        self._require(offset, size, description)
        return struct.unpack_from(format_string, self.image, offset)

    def _u8(self, offset: int, description: str) -> int:
        return self._unpack("<B", offset, description)[0]

    def _u16(self, offset: int, description: str) -> int:
        return self._unpack("<H", offset, description)[0]

    def _u32(self, offset: int, description: str) -> int:
        return self._unpack("<I", offset, description)[0]

    def _u64(self, offset: int, description: str) -> int:
        return self._unpack("<Q", offset, description)[0]

    def _read_index(self, offset: int, size: int, description: str) -> int:
        if size == 2:
            return self._u16(offset, description)
        if size == 4:
            return self._u32(offset, description)
        raise self._error(f"invalid {description} size {size}")

    def _parse_pe(self) -> None:
        if self.image[:2] != b"MZ":
            raise self._error("missing DOS signature")
        pe_offset = self._u32(0x3C, "DOS header")
        self._require(pe_offset, 24, "PE header")
        if self.image[pe_offset:pe_offset + 4] != b"PE\0\0":
            raise self._error("missing PE signature")

        section_count = self._u16(pe_offset + 6, "COFF section count")
        optional_size = self._u16(
            pe_offset + 20,
            "COFF optional-header size",
        )
        optional_offset = pe_offset + 24
        self._require(optional_offset, optional_size, "PE optional header")
        magic = self._u16(optional_offset, "PE optional-header magic")
        if magic == 0x10B:
            directory_count_offset = optional_offset + 92
            directories_offset = optional_offset + 96
        elif magic == 0x20B:
            directory_count_offset = optional_offset + 108
            directories_offset = optional_offset + 112
        else:
            raise self._error(f"unsupported PE optional-header magic {magic:#x}")

        directory_count = self._u32(
            directory_count_offset,
            "PE data-directory count",
        )
        if directory_count <= 14:
            raise self._error("missing CLI data directory")
        cli_directory = directories_offset + 14 * 8
        if cli_directory + 8 > optional_offset + optional_size:
            raise self._error("CLI data directory is outside optional header")
        cli_rva = self._u32(cli_directory, "CLI header RVA")
        cli_size = self._u32(cli_directory + 4, "CLI header size")
        if not cli_rva or cli_size < 32:
            raise self._error("missing or truncated CLI header")

        section_offset = optional_offset + optional_size
        for index in range(section_count):
            row = section_offset + index * 40
            self._require(row, 40, "PE section header")
            virtual_size = self._u32(row + 8, "section virtual size")
            virtual_address = self._u32(row + 12, "section RVA")
            raw_size = self._u32(row + 16, "section raw size")
            raw_offset = self._u32(row + 20, "section raw offset")
            self._sections.append(
                (virtual_address, virtual_size, raw_offset, raw_size)
            )

        cli_offset = self._rva_to_offset(cli_rva, 32, "CLI header")
        metadata_rva = self._u32(cli_offset + 8, "CLI metadata RVA")
        self.metadata_size = self._u32(
            cli_offset + 12,
            "CLI metadata size",
        )
        self.metadata_offset = self._rva_to_offset(
            metadata_rva,
            self.metadata_size,
            "CLI metadata",
        )
        resources_rva = self._u32(cli_offset + 24, "CLI resources RVA")
        self.resources_size = self._u32(
            cli_offset + 28,
            "CLI resources size",
        )
        if resources_rva:
            self.resources_offset: int | None = self._rva_to_offset(
                resources_rva,
                self.resources_size,
                "CLI resources",
            )
        else:
            self.resources_offset = None

    def _rva_to_offset(
        self,
        rva: int,
        size: int,
        description: str,
    ) -> int:
        for virtual_address, virtual_size, raw_offset, raw_size in self._sections:
            extent = max(virtual_size, raw_size)
            if virtual_address <= rva and rva + size <= virtual_address + extent:
                delta = rva - virtual_address
                if delta + size > raw_size:
                    break
                offset = raw_offset + delta
                self._require(offset, size, description)
                return offset
        raise self._error(f"{description} RVA is not backed by file data")

    def _parse_metadata(self) -> None:
        root = self.metadata_offset
        metadata_end = root + self.metadata_size
        if self._u32(root, "metadata signature") != 0x424A5342:
            raise self._error("missing CLI metadata signature")
        version_length = self._u32(root + 12, "metadata version length")
        if root + 16 + version_length > metadata_end:
            raise self._error("metadata version exceeds metadata root")
        self._require(root + 16, version_length, "metadata version")
        version_bytes = self.image[root + 16:root + 16 + version_length]
        try:
            self.runtime_version = version_bytes.split(b"\0", 1)[0].decode(
                "utf-8"
            )
        except UnicodeDecodeError as error:
            raise self._error("metadata version is not UTF-8") from error

        stream_header = root + ((16 + version_length + 3) & ~3)
        if stream_header + 4 > metadata_end:
            raise self._error("metadata stream header exceeds metadata root")
        self._require(stream_header, 4, "metadata stream header")
        stream_count = self._u16(
            stream_header + 2,
            "metadata stream count",
        )
        cursor = stream_header + 4
        streams: dict[str, tuple[int, int]] = {}
        for _ in range(stream_count):
            self._require(cursor, 9, "metadata stream entry")
            stream_offset = self._u32(cursor, "metadata stream offset")
            stream_size = self._u32(cursor + 4, "metadata stream size")
            name_start = cursor + 8
            name_end = self.image.find(
                b"\0",
                name_start,
                min(name_start + 32, metadata_end),
            )
            if name_end < 0:
                raise self._error("unterminated metadata stream name")
            try:
                name = self.image[name_start:name_end].decode("ascii")
            except UnicodeDecodeError as error:
                raise self._error("non-ASCII metadata stream name") from error
            if name in streams:
                raise self._error(f"duplicate metadata stream {name!r}")
            absolute_offset = root + stream_offset
            if absolute_offset < root or absolute_offset + stream_size > metadata_end:
                raise self._error(f"metadata stream {name!r} is out of bounds")
            streams[name] = (absolute_offset, stream_size)
            cursor = root + ((name_end + 1 - root + 3) & ~3)

        tables = streams.get("#~") or streams.get("#-")
        strings = streams.get("#Strings")
        if tables is None or strings is None:
            raise self._error("missing CLI tables or #Strings stream")
        self.strings_offset, self.strings_size = strings
        self._parse_tables(*tables)

    def _parse_tables(self, offset: int, size: int) -> None:
        table_end = offset + size
        if size < 24:
            raise self._error("truncated CLI tables stream header")
        self._require(offset, 24, "CLI tables stream header")
        heap_sizes = self._u8(offset + 6, "CLI heap-size flags")
        self.string_index_size = 4 if heap_sizes & 0x01 else 2
        self.guid_index_size = 4 if heap_sizes & 0x02 else 2
        self.blob_index_size = 4 if heap_sizes & 0x04 else 2
        valid = self._u64(offset + 8, "CLI valid-table mask")
        cursor = offset + 24
        for table in range(64):
            if valid & (1 << table):
                if cursor + 4 > table_end:
                    raise self._error("CLI table row counts exceed stream")
                self.row_counts[table] = self._u32(
                    cursor,
                    f"CLI table {table} row count",
                )
                cursor += 4
        if cursor > table_end:
            raise self._error("CLI table row counts exceed stream")

        for table in range(41):
            rows = self.row_counts.get(table, 0)
            if not rows:
                continue
            row_size = self._table_row_size(table)
            byte_count = row_size * rows
            if cursor + byte_count > table_end:
                raise self._error(f"CLI table {table} exceeds stream")
            self.table_offsets[table] = cursor
            self.table_row_sizes[table] = row_size
            cursor += byte_count

    def _table_row_size(self, table: int) -> int:
        schema = _TABLE_SCHEMAS.get(table)
        if schema is None:
            raise self._error(f"unsupported CLI metadata table {table}")
        size = 0
        for field in schema:
            if field == "u1":
                size += 1
            elif field == "u2":
                size += 2
            elif field == "u4":
                size += 4
            elif field == "str":
                size += self.string_index_size
            elif field == "guid":
                size += self.guid_index_size
            elif field == "blob":
                size += self.blob_index_size
            elif isinstance(field, tuple) and field[0] == "table":
                size += 2 if self.row_counts.get(field[1], 0) < 0x10000 else 4
            elif isinstance(field, tuple) and field[0] == "coded":
                tables, tag_bits = _CODED_INDEXES[field[1]]
                largest = max(self.row_counts.get(item, 0) for item in tables)
                size += 2 if largest < (1 << (16 - tag_bits)) else 4
            else:
                raise self._error(f"unsupported field in CLI table {table}")
        return size

    def _coded_index_size(self, name: str) -> int:
        tables, tag_bits = _CODED_INDEXES[name]
        largest = max(self.row_counts.get(table, 0) for table in tables)
        return 2 if largest < (1 << (16 - tag_bits)) else 4

    def _row_offset(self, table: int, row: int) -> int:
        count = self.row_counts.get(table, 0)
        if row < 0 or row >= count or table not in self.table_offsets:
            raise self._error(f"invalid CLI table {table} row {row + 1}")
        return self.table_offsets[table] + self.table_row_sizes[table] * row

    def _string(self, index: int) -> str:
        if index == 0:
            return ""
        if index < 0 or index >= self.strings_size:
            raise self._error("#Strings index is out of bounds")
        start = self.strings_offset + index
        end_limit = self.strings_offset + self.strings_size
        end = self.image.find(b"\0", start, end_limit)
        if end < 0:
            raise self._error("unterminated #Strings value")
        try:
            return self.image[start:end].decode("utf-8")
        except UnicodeDecodeError as error:
            raise self._error("invalid UTF-8 in #Strings") from error

    def manifest_resources(self) -> dict[str, bytes | None]:
        resources: dict[str, bytes | None] = {}
        implementation_size = self._coded_index_size("Implementation")
        for row_number in range(self.row_counts.get(40, 0)):
            row = self._row_offset(40, row_number)
            resource_offset = self._u32(row, "ManifestResource offset")
            name_index = self._read_index(
                row + 8,
                self.string_index_size,
                "ManifestResource name",
            )
            implementation = self._read_index(
                row + 8 + self.string_index_size,
                implementation_size,
                "ManifestResource implementation",
            )
            name = self._string(name_index)
            if name in resources:
                raise self._error(f"duplicate ManifestResource {name!r}")
            if implementation:
                resources[name] = None
                continue
            if self.resources_offset is None:
                raise self._error(
                    f"embedded ManifestResource {name!r} has no resource directory"
                )
            if resource_offset + 4 > self.resources_size:
                raise self._error(f"ManifestResource {name!r} is out of bounds")
            entry = self.resources_offset + resource_offset
            payload_size = self._u32(entry, "ManifestResource payload length")
            if resource_offset + 4 + payload_size > self.resources_size:
                raise self._error(
                    f"ManifestResource {name!r} payload is out of bounds"
                )
            resources[name] = self.image[entry + 4:entry + 4 + payload_size]
        return resources

    def runtime_contract(self) -> tuple[str, int]:
        if self.row_counts.get(32, 0) != 1:
            raise self._error("expected exactly one Assembly metadata row")
        mscorlib_majors = []
        for row_number in range(self.row_counts.get(35, 0)):
            row = self._row_offset(35, row_number)
            major = self._u16(row, "AssemblyRef major version")
            name_index = self._read_index(
                row + 12 + self.blob_index_size,
                self.string_index_size,
                "AssemblyRef name",
            )
            if self._string(name_index) == "mscorlib":
                mscorlib_majors.append(major)
        if len(mscorlib_majors) != 1:
            raise self._error(
                "expected exactly one mscorlib AssemblyRef, found "
                + str(len(mscorlib_majors))
            )
        return self.runtime_version, mscorlib_majors[0]


def _read_manifest_resources(image: bytes, label: str) -> dict[str, bytes | None]:
    return _ManagedImage(image, label).manifest_resources()


def _read_managed_runtime_contract(image: bytes, label: str) -> tuple[str, int]:
    return _ManagedImage(image, label).runtime_contract()


def _runtime_family(runtime_version: str) -> int | None:
    normalized = runtime_version.casefold()
    if normalized.startswith("v2."):
        return 2
    if normalized.startswith("v4."):
        return 4
    return None


def _validate_embedded_bridge_payloads(
    bridge_directory: Path | None = None,
) -> None:
    """Require both runtime payloads to be embedded verbatim in the host."""
    directory = (
        ROOT / BRIDGE_DIRECTORY
        if bridge_directory is None
        else bridge_directory
    )
    host_path = directory / BRIDGE_HOST_FILE
    payload_paths = [
        (logical_name, directory / filename, expected_family)
        for logical_name, filename, expected_family
        in BRIDGE_EMBEDDED_RESOURCES
    ]
    missing = [
        path.name
        for path in [host_path, *(path for _, path, _ in payload_paths)]
        if not path.is_file()
    ]
    if missing:
        raise SystemExit(
            "Missing bridge build inputs: "
            + ", ".join(sorted(set(missing)))
        )
    try:
        resources = _read_manifest_resources(
            host_path.read_bytes(),
            host_path.name,
        )
    except _ManagedImageError as error:
        raise SystemExit(f"Invalid bridge host: {error}") from error

    errors = []
    for logical_name, payload_path, expected_family in payload_paths:
        payload_bytes = payload_path.read_bytes()
        if not payload_bytes:
            errors.append(f"empty payload {payload_path.name}")
        if logical_name not in resources:
            errors.append(f"missing resource name {logical_name}")
        elif resources[logical_name] is None:
            errors.append(f"resource is not embedded {logical_name}")
        elif payload_bytes and resources[logical_name] != payload_bytes:
            errors.append(f"payload mismatch {payload_path.name}")
        try:
            runtime_version, mscorlib_major = _read_managed_runtime_contract(
                payload_bytes,
                payload_path.name,
            )
        except _ManagedImageError as error:
            errors.append(f"invalid managed payload {error}")
            continue
        actual_family = _runtime_family(runtime_version)
        if (
            actual_family != expected_family
            or mscorlib_major != expected_family
        ):
            errors.append(
                f"runtime family mismatch {payload_path.name}: "
                f"metadata={runtime_version!r}, mscorlib={mscorlib_major}; "
                f"expected clr{expected_family}"
            )

    if errors:
        raise SystemExit(
            "Invalid embedded bridge payloads in "
            + BRIDGE_HOST_FILE
            + ": "
            + "; ".join(errors)
        )


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
    _validate_embedded_bridge_payloads()
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
    allowed_bridge = set(BRIDGE_FILES).union(BRIDGE_BUILD_ONLY_FILES)
    stale = sorted(actual_bridge.difference(allowed_bridge))
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
