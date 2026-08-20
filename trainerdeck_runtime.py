"""Authenticated loopback runtime for the in-process FLiNG bridge.

The bridge is loaded into the original trainer's CLR/AppDomain. It publishes
the managed FLiNG menu and invokes the trainer's native delegate directly for
both supported WPF and WinForms generations. This module deliberately does not
know about trainer hotkeys.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import json
import math
import os
import re
import shutil
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable


BRIDGE_PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1024 * 1024
MAX_OPTIONS = 256
MAX_OPTION_VALUE_CHARS = 200
COMMAND_TIMEOUT_SECONDS = 4.0
CLIENT_IDLE_TIMEOUT_SECONDS = 15.0
BRIDGE_MANIFEST_FILENAME = "trainerdeck-bridge.json"
BRIDGE_ASSET_FILENAMES = (
    "TrainerDeckBridgeLauncher.exe",
    "Mono.Cecil.dll",
)
OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES = (
    "TrainerDeckBridge.dll",
    "TrainerDeckBridge.Legacy.dll",
    "TrainerDeckBridgeLauncher.exe.config",
)
HEX_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")
CONTROLLABLE_KINDS = {
    "toggle",
    "toggle_with_input",
    "toggle_with_input_adjustment",
}
VALUE_CONTROLLABLE_KINDS = {
    "toggle_with_input",
    "toggle_with_input_adjustment",
    "action",
    "input",
}
OPTION_KINDS = CONTROLLABLE_KINDS | {
    "action",
    "input",
    "unknown",
}


class TrainerRuntimeError(RuntimeError):
    """A user-facing runtime/bridge failure."""


async def _read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    header = await reader.readexactly(4)
    (length,) = struct.unpack("<I", header)
    if length <= 0 or length > MAX_FRAME_BYTES:
        raise TrainerRuntimeError("bridge 消息大小无效")
    payload = await reader.readexactly(length)
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TrainerRuntimeError("bridge 消息不是有效的 UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise TrainerRuntimeError("bridge 消息必须是 JSON 对象")
    return value


async def _write_frame(
    writer: asyncio.StreamWriter,
    value: dict[str, Any],
    lock: asyncio.Lock | None = None,
) -> None:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise TrainerRuntimeError("bridge 消息超过大小上限")

    async def write() -> None:
        writer.write(struct.pack("<I", len(payload)))
        writer.write(payload)
        await writer.drain()

    if lock is None:
        await write()
    else:
        async with lock:
            await write()


def _safe_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.replace("\x00", "").strip()[:limit]


def _safe_capabilities(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in value[:64]:
        capability = _safe_text(raw, 80)
        if not capability or capability in seen:
            continue
        seen.add(capability)
        result.append(capability)
    return result


def _localized_text(value: Any, limit: int) -> dict[str, str]:
    if isinstance(value, str):
        text = _safe_text(value, limit)
        return {"en": text} if text else {}
    if not isinstance(value, dict):
        return {}
    result: dict[str, str] = {}
    aliases = {
        "zh_cn": ("zh_cn", "zhCN", "zh-CN", "zh"),
        "zh_tw": ("zh_tw", "zhTW", "zh-TW"),
        "en": ("en", "en_us", "en-US"),
    }
    for target, keys in aliases.items():
        for key in keys:
            text = _safe_text(value.get(key), limit)
            if text:
                result[target] = text
                break
    return result


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _sanitize_option(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    option_id = _safe_text(raw.get("id"), 128)
    if not option_id:
        return None
    kind = _safe_text(raw.get("kind"), 40)
    if kind not in OPTION_KINDS:
        kind = "unknown"
    active = raw.get("active")
    if not isinstance(active, bool):
        active = None
    tooltip_style = (
        "important"
        if raw.get("tooltip_style") == "important"
        else "normal"
    )
    value_type = _safe_text(raw.get("value_type"), 20)
    if value_type not in {"integer", "number", "text", "none"}:
        value_type = "none"
    value_apply_mode = _safe_text(raw.get("value_apply_mode"), 24)
    if value_apply_mode not in {"stage_then_toggle", "invoke", "none"}:
        value_apply_mode = "none"
    value_contract_matches = (
        kind in {"toggle_with_input", "toggle_with_input_adjustment"}
        and value_apply_mode == "stage_then_toggle"
    ) or (
        kind in {"action", "input"}
        and value_apply_mode == "invoke"
    )
    value_controllable = (
        bool(raw.get("value_controllable"))
        and kind in VALUE_CONTROLLABLE_KINDS
        and value_type != "none"
        and value_contract_matches
    )
    action_controllable = (
        bool(raw.get("action_controllable"))
        and kind == "action"
        and value_type == "none"
        and value_apply_mode == "none"
    )
    if value_controllable and action_controllable:
        # A control cannot be both a value-bearing input_set action and a pure
        # no-input action. Treat a contradictory bridge contract as unsupported.
        value_controllable = False
        action_controllable = False
    option: dict[str, Any] = {
        "id": option_id,
        "kind": kind,
        "labels": _localized_text(raw.get("labels") or raw.get("label"), 300),
        "tooltips": _localized_text(
            raw.get("tooltips") or raw.get("tooltip"),
            6000,
        ),
        "group": _localized_text(raw.get("group"), 300),
        "tooltip_style": tooltip_style,
        "active": active,
        "controllable": bool(raw.get("controllable"))
        and kind in CONTROLLABLE_KINDS,
        "pending": False,
        "desired": None,
        "error": "",
        "value_controllable": value_controllable,
        "value_pending": False,
        "desired_value": None,
        "value_error": "",
        "value_type": value_type,
        "value_apply_mode": value_apply_mode,
        "action_controllable": action_controllable,
        "action_pending": False,
        "action_error": "",
    }
    value = _safe_text(raw.get("value"), 200)
    if value:
        option["value"] = value
    for source, target in (
        ("minimum", "minimum"),
        ("maximum", "maximum"),
        ("step", "step"),
    ):
        number = _finite_number(raw.get(source))
        if number is not None:
            option[target] = number
    return option


class TrainerRuntimeManager:
    """Owns the loopback server and authoritative Decky-facing snapshots."""

    def __init__(
        self,
        runtime_dir: str | Path,
        bridge_assets_dir: str | Path,
    ) -> None:
        self.runtime_dir = Path(runtime_dir).resolve()
        self.bridge_assets_dir = Path(bridge_assets_dir).resolve()
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self._server: asyncio.AbstractServer | None = None
        self._host = "127.0.0.1"
        self._port = 0
        self._epoch = int(time.time() * 1000)
        self._revisions: dict[int, int] = {}
        self._revision_lock = threading.Lock()
        self._sessions: dict[int, dict[str, Any]] = {}
        self._prepared: dict[int, dict[str, Any]] = {}
        self._tokens: dict[int, str] = {}
        self._writers: dict[int, asyncio.StreamWriter] = {}
        self._write_locks: dict[int, asyncio.Lock] = {}
        self._inbound_writers: set[asyncio.StreamWriter] = set()
        self._handler_tasks: set[asyncio.Task[Any]] = set()
        self._pending_tasks: set[asyncio.Task[Any]] = set()
        self._prepare_lock = threading.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._lifecycle_generation = 0
        self._stopping = True
        self._installation_owners: dict[str, int] = {}
        self._owned_installations: dict[int, str] = {}
        self._on_change: (
            Callable[[dict[str, Any]], Awaitable[None] | None] | None
        ) = None

    @property
    def running(self) -> bool:
        return self._server is not None and not self._stopping

    @property
    def port(self) -> int:
        return self._port

    def _lifecycle_is_current(self, generation: int) -> bool:
        return self.running and generation == self._lifecycle_generation

    async def start(
        self,
        on_change: Callable[
            [dict[str, Any]],
            Awaitable[None] | None,
        ]
        | None = None,
    ) -> None:
        async with self._lifecycle_lock:
            if self.running:
                return
            self._on_change = on_change
            server = await asyncio.start_server(
                self._accept_client,
                self._host,
                0,
                limit=MAX_FRAME_BYTES + 4,
            )
            sockets = server.sockets or []
            if not sockets:
                server.close()
                await server.wait_closed()
                raise TrainerRuntimeError("无法启动修改器 bridge 端点")
            self._server = server
            self._port = int(sockets[0].getsockname()[1])
            self._lifecycle_generation += 1
            self._stopping = False

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            # Publish the closing generation before the first await. A prepare
            # already holding the file lock will observe the generation change;
            # queued prepares will fail their running check after acquiring it.
            self._stopping = True
            self._lifecycle_generation += 1
            server = self._server
            self._server = None
            if server is not None:
                server.close()
            for session in list(self._sessions.values()):
                for request_id in list(session["pending"]):
                    self._finish_pending(
                        session,
                        request_id,
                        "bridge 服务已停止，操作结果未知",
                    )
            await self._close_inbound_clients()
            if server is not None:
                await server.wait_closed()
            # Flush any accept callback that was already queued when close()
            # ran, then drain the synchronously registered writer/task too.
            await self._close_inbound_clients()
            self._writers.clear()
            self._write_locks.clear()
            self._handler_tasks.clear()
            self._inbound_writers.clear()
            for task in list(self._pending_tasks):
                task.cancel()
            if self._pending_tasks:
                await asyncio.gather(
                    *self._pending_tasks,
                    return_exceptions=True,
                )
            self._pending_tasks.clear()
            self._sessions.clear()
            # Never block the event-loop thread on an in-flight file prepare.
            # The worker takes the same lock and is the final writer before
            # stop returns.
            await asyncio.to_thread(self._finalize_stop)
            self._port = 0

    async def _close_inbound_clients(self) -> None:
        await asyncio.sleep(0)
        while (
            self._inbound_writers
            or self._writers
            or any(not task.done() for task in self._handler_tasks)
        ):
            inbound_writers = self._inbound_writers | set(
                self._writers.values()
            )
            handler_tasks = {
                task
                for task in self._handler_tasks
                if task is not asyncio.current_task() and not task.done()
            }
            for writer in inbound_writers:
                writer.close()
            for task in handler_tasks:
                task.cancel()
            if handler_tasks:
                await asyncio.gather(
                    *handler_tasks,
                    return_exceptions=True,
                )
            for writer in inbound_writers:
                try:
                    await writer.wait_closed()
                except (ConnectionError, OSError):
                    pass
            for app_id, registered_writer in list(self._writers.items()):
                if registered_writer in inbound_writers:
                    self._writers.pop(app_id, None)
                    self._write_locks.pop(app_id, None)
            self._handler_tasks.difference_update(handler_tasks)
            self._handler_tasks.difference_update(
                {task for task in self._handler_tasks if task.done()}
            )
            self._inbound_writers.difference_update(inbound_writers)
            await asyncio.sleep(0)

    def _accept_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Synchronously register an accepted socket before task scheduling."""
        accepted_generation = self._lifecycle_generation
        self._inbound_writers.add(writer)
        handler_task = asyncio.create_task(
            self._handle_client(
                reader,
                writer,
                accepted_generation,
            )
        )
        self._handler_tasks.add(handler_task)
        handler_task.add_done_callback(self._handler_tasks.discard)

    def _finalize_stop(self) -> None:
        with self._prepare_lock:
            # Outer manifests are intentionally left in place. Their tokens
            # become inert as soon as this state is cleared, and a later
            # prepare atomically replaces them. Avoiding path-based deletion
            # prevents clobbering a manifest published by another process.
            self._prepared.clear()
            self._tokens.clear()
            self._installation_owners.clear()
            self._owned_installations.clear()

    def _asset_error(self) -> str:
        missing = [
            name
            for name in BRIDGE_ASSET_FILENAMES
            if not (self.bridge_assets_dir / name).is_file()
            and not name.endswith(".config")
        ]
        if missing:
            return "bridge 构建产物缺失：" + "、".join(missing)
        return ""

    def record_prepare_failure(
        self,
        app_id: int,
        installation: dict[str, Any],
        error: Exception,
    ) -> dict[str, Any]:
        """Expose an automatic bridge-refresh failure in the app snapshot."""
        numeric_app_id = int(app_id)
        executable = str(installation.get("executable") or "")
        reason = f"同步组件刷新失败：{error}"
        self._tokens.pop(numeric_app_id, None)
        prepared = {
            "app_id": numeric_app_id,
            "supported": False,
            "status": "error",
            "reason": reason,
            "launch_executable": executable,
            "trainer_sha256": str(installation.get("sha256") or ""),
        }
        self._prepared[numeric_app_id] = prepared
        self._bump_revision(numeric_app_id)
        return copy.deepcopy(prepared)

    def prepare_bridge(
        self,
        app_id: int,
        installation: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("Steam AppID 无效") from error
        if numeric_app_id <= 0:
            raise TrainerRuntimeError("Steam AppID 无效")

        # prepare_bridge is called both from the event-loop startup path and
        # through asyncio.to_thread. Serialize the complete ownership and file
        # transaction so concurrent refreshes cannot share temporary paths or
        # publish a manifest for the wrong AppID.
        with self._prepare_lock:
            if not self.running:
                raise TrainerRuntimeError("bridge 后端尚未启动或正在停止")
            lifecycle_generation = self._lifecycle_generation
            return self._prepare_bridge_locked(
                numeric_app_id,
                installation,
                lifecycle_generation,
            )

    def _prepare_bridge_locked(
        self,
        numeric_app_id: int,
        installation: dict[str, Any],
        lifecycle_generation: int,
    ) -> dict[str, Any]:

        folder = Path(str(installation.get("folder") or "")).resolve()
        executable = Path(str(installation.get("executable") or "")).resolve()
        if not executable.is_file():
            raise TrainerRuntimeError("找不到已安装修改器 EXE")
        try:
            executable_relative = executable.relative_to(folder)
        except ValueError as error:
            raise TrainerRuntimeError("修改器 EXE 不在安装目录内") from error

        installation_key = self._installation_key(folder)
        owner_app_id = self._installation_owners.get(installation_key)
        if owner_app_id is not None and owner_app_id != numeric_app_id:
            raise TrainerRuntimeError(
                "这个修改器安装已由 Steam AppID "
                f"{owner_app_id} 使用，请先解除原绑定"
            )

        error = self._asset_error()
        if error:
            self._tokens.pop(numeric_app_id, None)
            prepared = {
                "app_id": numeric_app_id,
                "supported": False,
                "status": "unsupported",
                "reason": error,
                "launch_executable": str(executable),
                "trainer_sha256": str(installation.get("sha256") or ""),
            }
            self._prepared[numeric_app_id] = prepared
            self._bump_revision(numeric_app_id)
            return copy.deepcopy(prepared)

        folder.mkdir(parents=True, exist_ok=True)
        trainer_sha256 = self._sha256_file(executable)
        token = os.urandom(32).hex()
        manifest = {
            "protocol": BRIDGE_PROTOCOL_VERSION,
            "host": self._host,
            "port": self._port,
            "token": token,
            "app_id": numeric_app_id,
            "trainer_sha256": trainer_sha256,
            "trainer_relative": executable_relative.as_posix(),
            "generated_at": int(time.time()),
        }
        manifest_path = folder / BRIDGE_MANIFEST_FILENAME
        copied = self._deploy_bridge_files(
            folder,
            manifest_path,
            manifest,
        )
        if (
            not self.running
            or lifecycle_generation != self._lifecycle_generation
        ):
            raise TrainerRuntimeError("bridge 后端已停止，未提交准备结果")

        previous_installation_key = self._owned_installations.get(
            numeric_app_id
        )
        if (
            previous_installation_key
            and previous_installation_key != installation_key
            and self._installation_owners.get(previous_installation_key)
            == numeric_app_id
        ):
            self._installation_owners.pop(previous_installation_key, None)
        self._installation_owners[installation_key] = numeric_app_id
        self._owned_installations[numeric_app_id] = installation_key
        self._tokens[numeric_app_id] = token
        launcher = folder / "TrainerDeckBridgeLauncher.exe"
        prepared = {
            "app_id": numeric_app_id,
            "installation_id": str(installation.get("id") or ""),
            "supported": True,
            "status": "waiting",
            "reason": "",
            "launch_executable": str(launcher),
            "trainer_sha256": trainer_sha256,
            "manifest": str(manifest_path),
            "assets": copied,
        }
        self._prepared[numeric_app_id] = prepared
        self._bump_revision(numeric_app_id)
        return copy.deepcopy(prepared)

    @staticmethod
    def _installation_key(folder: Path) -> str:
        physical_folder = os.path.normcase(
            os.path.normpath(str(folder.resolve()))
        )
        return f"folder:{physical_folder}"

    def _deploy_bridge_files(
        self,
        folder: Path,
        manifest_path: Path,
        manifest: dict[str, Any],
    ) -> list[str]:
        """Stage and atomically publish Host, Cecil, and the launch manifest."""
        transaction_id = uuid.uuid4().hex
        replacements: list[dict[str, Any]] = []
        obsolete_moves: list[tuple[Path, Path]] = []
        copied: list[str] = []

        try:
            for name in BRIDGE_ASSET_FILENAMES:
                source = self.bridge_assets_dir / name
                if not source.is_file():
                    continue
                destination = folder / name
                staging = destination.with_name(
                    f".{destination.name}.{transaction_id}.stage"
                )
                backup = destination.with_name(
                    f".{destination.name}.{transaction_id}.backup"
                )
                replacement = {
                    "destination": destination,
                    "staging": staging,
                    "backup": backup,
                    "had_original": False,
                    "installed": False,
                    "rollback_failed": False,
                }
                replacements.append(replacement)
                shutil.copy2(source, staging)
                copied.append(name)

            manifest_staging = manifest_path.with_name(
                f".{manifest_path.name}.{transaction_id}.stage"
            )
            manifest_backup = manifest_path.with_name(
                f".{manifest_path.name}.{transaction_id}.backup"
            )
            manifest_replacement = {
                "destination": manifest_path,
                "staging": manifest_staging,
                "backup": manifest_backup,
                "had_original": False,
                "installed": False,
                "rollback_failed": False,
            }
            replacements.append(manifest_replacement)
            manifest_staging.write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.chmod(manifest_staging, 0o600)

            for replacement in replacements:
                destination = replacement["destination"]
                if destination.exists():
                    # Keep the current Host/manifest continuously visible.
                    # The one operation that changes the live path is the
                    # atomic stage-to-destination replacement below.
                    shutil.copy2(destination, replacement["backup"])
                    replacement["had_original"] = True
                os.replace(replacement["staging"], destination)
                replacement["installed"] = True

            # Retire the old external bridge only after the complete new Host
            # deployment is visible. Moving it aside keeps rollback possible.
            for name in OBSOLETE_MULTI_BRIDGE_ASSET_FILENAMES:
                obsolete = folder / name
                if not obsolete.exists():
                    continue
                backup = obsolete.with_name(
                    f".{obsolete.name}.{transaction_id}.obsolete"
                )
                os.replace(obsolete, backup)
                obsolete_moves.append((obsolete, backup))
        except (OSError, shutil.Error) as error:
            rollback_errors: list[str] = []
            for destination, backup in reversed(obsolete_moves):
                try:
                    os.replace(backup, destination)
                except OSError as rollback_error:
                    rollback_errors.append(str(rollback_error))
            for replacement in reversed(replacements):
                destination = replacement["destination"]
                try:
                    if replacement["installed"] and replacement["had_original"]:
                        os.replace(replacement["backup"], destination)
                    elif replacement["installed"]:
                        destination.unlink(missing_ok=True)
                except OSError as rollback_error:
                    replacement["rollback_failed"] = True
                    rollback_errors.append(str(rollback_error))
            for replacement in replacements:
                if replacement["rollback_failed"]:
                    continue
                try:
                    replacement["backup"].unlink(missing_ok=True)
                except OSError:
                    pass
            detail = ""
            if rollback_errors:
                detail = "；部分旧文件未能自动恢复"
            raise TrainerRuntimeError(
                f"无法安全更新修改器同步组件{detail}：{error}"
            ) from error
        finally:
            for replacement in replacements:
                try:
                    replacement["staging"].unlink(missing_ok=True)
                except OSError:
                    pass

        for replacement in replacements:
            try:
                replacement["backup"].unlink(missing_ok=True)
            except OSError:
                pass
        for _destination, backup in obsolete_moves:
            try:
                backup.unlink(missing_ok=True)
            except OSError:
                pass
        return copied

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()

    def _bump_revision(self, app_id: int) -> int:
        with self._revision_lock:
            revision = self._revisions.get(app_id, 0) + 1
            self._revisions[app_id] = revision
            return revision

    def _current_revision(self, app_id: int) -> int:
        with self._revision_lock:
            return self._revisions.get(app_id, 0)

    def get_snapshot(self, app_id: int) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
        except (TypeError, ValueError):
            numeric_app_id = 0
        session = self._sessions.get(numeric_app_id)
        if session is not None:
            return self._public_snapshot(session)
        prepared = self._prepared.get(numeric_app_id)
        status = str(prepared.get("status")) if prepared else "not_prepared"
        reason = str(prepared.get("reason") or "") if prepared else ""
        return {
            "app_id": numeric_app_id,
            "epoch": self._epoch,
            "status": status,
            "connected": False,
            "session_id": "",
            "revision": self._current_revision(numeric_app_id),
            "bridge_revision": 0,
            "game_available": None,
            "trainer_sha256": (
                str(prepared.get("trainer_sha256") or "")
                if prepared
                else ""
            ),
            "bridge_version": "",
            "capabilities": [],
            "ui_fingerprint": "",
            "options": [],
            "message": reason,
        }

    async def emit_snapshot(self, app_id: int) -> None:
        await self._emit(self.get_snapshot(app_id))

    async def invalidate_app(self, app_id: int) -> None:
        """Drop a live session after its launch manifest has been replaced."""
        numeric_app_id = int(app_id)
        writer = self._writers.pop(numeric_app_id, None)
        self._write_locks.pop(numeric_app_id, None)
        session = self._sessions.pop(numeric_app_id, None)
        if session is not None:
            for request_id in list(session["pending"]):
                self._finish_pending(
                    session,
                    request_id,
                    "同步组件已重新准备，旧修改器会话已失效",
                )
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
        self._bump_revision(numeric_app_id)

    async def revoke_app(self, app_id: int) -> None:
        """Revoke authentication while leaving an inert manifest in place."""
        numeric_app_id = int(app_id)
        with self._prepare_lock:
            self._prepared.pop(numeric_app_id, None)
            self._tokens.pop(numeric_app_id, None)
            installation_key = self._owned_installations.pop(
                numeric_app_id,
                None,
            )
            if (
                installation_key
                and self._installation_owners.get(installation_key)
                == numeric_app_id
            ):
                self._installation_owners.pop(installation_key, None)
        await self.invalidate_app(numeric_app_id)
        await self.emit_snapshot(numeric_app_id)

    def _public_snapshot(self, session: dict[str, Any]) -> dict[str, Any]:
        fields = (
            "app_id",
            "epoch",
            "status",
            "connected",
            "session_id",
            "revision",
            "bridge_revision",
            "game_available",
            "trainer_sha256",
            "bridge_version",
            "capabilities",
            "ui_fingerprint",
            "options",
            "message",
        )
        return {
            field: copy.deepcopy(session.get(field))
            for field in fields
        }

    async def _emit(self, snapshot: dict[str, Any]) -> None:
        if self._on_change is None:
            return
        result = self._on_change(copy.deepcopy(snapshot))
        if asyncio.iscoroutine(result):
            await result

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        accepted_generation: int,
    ) -> None:
        app_id = 0
        session_id = ""
        handler_task = asyncio.current_task()
        try:
            if not self._lifecycle_is_current(accepted_generation):
                raise TrainerRuntimeError("bridge 后端正在停止")
            peer = writer.get_extra_info("peername")
            if not peer or peer[0] not in {"127.0.0.1", "::1"}:
                raise TrainerRuntimeError("bridge 只接受本机连接")
            hello = await asyncio.wait_for(_read_frame(reader), timeout=5.0)
            if not self._lifecycle_is_current(accepted_generation):
                raise TrainerRuntimeError("bridge 后端已停止")
            app_id, session_id = self._validate_hello(hello)
            if not self._lifecycle_is_current(accepted_generation):
                raise TrainerRuntimeError("bridge 认证期间后端已停止")
            previous = self._writers.get(app_id)
            if previous is not None and previous is not writer:
                previous_session = self._sessions.get(app_id)
                if previous_session is not None:
                    for request_id in list(previous_session["pending"]):
                        self._finish_pending(
                            previous_session,
                            request_id,
                            "bridge 会话已替换，操作结果未知",
                        )
                previous.close()

            self._writers[app_id] = writer
            self._write_locks[app_id] = asyncio.Lock()
            session = {
                "app_id": app_id,
                "epoch": self._epoch,
                "status": "connected",
                "connected": True,
                "session_id": session_id,
                "revision": self._bump_revision(app_id),
                "bridge_revision": 0,
                "game_available": None,
                "trainer_sha256": str(hello.get("trainer_sha256") or ""),
                "bridge_version": _safe_text(hello.get("bridge_version"), 40),
                "capabilities": _safe_capabilities(hello.get("capabilities")),
                "ui_fingerprint": _safe_text(
                    hello.get("ui_fingerprint"),
                    128,
                ),
                "options": [],
                "message": "bridge 已连接，正在读取修改器菜单",
                "pending": {},
                "last_seen": time.monotonic(),
            }
            self._sessions[app_id] = session
            if not self._lifecycle_is_current(accepted_generation):
                self._writers.pop(app_id, None)
                self._write_locks.pop(app_id, None)
                self._sessions.pop(app_id, None)
                raise TrainerRuntimeError("bridge 注册期间后端已停止")
            await _write_frame(
                writer,
                {
                    "type": "hello_ack",
                    "protocol": BRIDGE_PROTOCOL_VERSION,
                    "session_id": session_id,
                },
                self._write_locks[app_id],
            )
            if (
                not self._lifecycle_is_current(accepted_generation)
                or self._writers.get(app_id) is not writer
                or self._sessions.get(app_id) is not session
            ):
                raise TrainerRuntimeError("bridge 注册后后端已停止")
            await self._emit(self._public_snapshot(session))
            if (
                not self._lifecycle_is_current(accepted_generation)
                or self._writers.get(app_id) is not writer
                or self._sessions.get(app_id) is not session
            ):
                raise TrainerRuntimeError("bridge 后端已停止")

            while True:
                message = await asyncio.wait_for(
                    _read_frame(reader),
                    timeout=CLIENT_IDLE_TIMEOUT_SECONDS,
                )
                if (
                    self._writers.get(app_id) is not writer
                    or self._sessions.get(app_id) is not session
                ):
                    break
                if message.get("session_id") != session_id:
                    raise TrainerRuntimeError("bridge 消息 session 不匹配")
                session["last_seen"] = time.monotonic()
                message_type = message.get("type")
                if message_type == "snapshot":
                    await self._apply_snapshot(session, message)
                elif message_type == "heartbeat":
                    await _write_frame(
                        writer,
                        {
                            "type": "heartbeat_ack",
                            "session_id": session_id,
                        },
                        self._write_locks[app_id],
                    )
                elif message_type == "command_error":
                    await self._apply_command_error(session, message)
                elif message_type == "command_accepted":
                    await self._mark_command_accepted(session, message)
                else:
                    raise TrainerRuntimeError("bridge 发送了未知消息")
        except (
            asyncio.IncompleteReadError,
            asyncio.TimeoutError,
            ConnectionError,
            OSError,
            TrainerRuntimeError,
        ) as error:
            if (
                self._lifecycle_is_current(accepted_generation)
                and app_id
                and self._writers.get(app_id) is writer
            ):
                await self._mark_disconnected(
                    app_id,
                    session_id,
                    str(error) or "bridge 连接已断开",
                )
        finally:
            if app_id and self._writers.get(app_id) is writer:
                self._writers.pop(app_id, None)
                self._write_locks.pop(app_id, None)
            self._inbound_writers.discard(writer)
            if handler_task is not None:
                self._handler_tasks.discard(handler_task)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    def _validate_hello(self, hello: dict[str, Any]) -> tuple[int, str]:
        if hello.get("type") != "hello":
            raise TrainerRuntimeError("bridge 未发送握手")
        try:
            protocol = int(hello.get("protocol"))
            app_id = int(hello.get("app_id"))
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("bridge 握手字段无效") from error
        if protocol != BRIDGE_PROTOCOL_VERSION:
            raise TrainerRuntimeError("bridge 协议版本不兼容")
        if app_id <= 0:
            raise TrainerRuntimeError("bridge AppID 无效")
        prepared = self._prepared.get(app_id)
        expected_token = self._tokens.get(app_id)
        if (
            prepared is None
            or not prepared.get("supported")
            or not expected_token
        ):
            raise TrainerRuntimeError("bridge AppID 尚未准备或绑定")
        token = str(hello.get("token") or "")
        if not hmac.compare_digest(token, expected_token):
            raise TrainerRuntimeError("bridge 鉴权失败")
        session_id = str(hello.get("session_id") or "")
        if not SESSION_ID_RE.fullmatch(session_id):
            raise TrainerRuntimeError("bridge session ID 无效")
        trainer_sha256 = str(hello.get("trainer_sha256") or "").casefold()
        if trainer_sha256 and not HEX_SHA256_RE.fullmatch(trainer_sha256):
            raise TrainerRuntimeError("bridge 修改器哈希无效")
        expected_hash = str(prepared.get("trainer_sha256") or "").casefold()
        if not expected_hash or trainer_sha256 != expected_hash:
            raise TrainerRuntimeError("bridge 修改器哈希与绑定记录不一致")
        return app_id, session_id

    @staticmethod
    def _value_matches(actual: Any, desired: str) -> bool:
        if isinstance(actual, str) and actual.strip() == desired:
            return True
        actual_number = _finite_number(actual)
        desired_number = _finite_number(desired)
        return (
            actual_number is not None
            and desired_number is not None
            and actual_number == desired_number
        )

    async def _apply_snapshot(
        self,
        session: dict[str, Any],
        message: dict[str, Any],
    ) -> None:
        if message.get("session_id") != session["session_id"]:
            raise TrainerRuntimeError("bridge snapshot session 不匹配")
        try:
            bridge_revision = int(message.get("revision"))
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("bridge snapshot revision 无效") from error
        if bridge_revision <= int(session.get("bridge_revision") or 0):
            return
        raw_options = message.get("options")
        if not isinstance(raw_options, list):
            raise TrainerRuntimeError("bridge 菜单格式无效")
        options: list[dict[str, Any]] = []
        seen: set[str] = set()
        for raw in raw_options[:MAX_OPTIONS]:
            option = _sanitize_option(raw)
            if option is None or option["id"] in seen:
                continue
            seen.add(option["id"])
            options.append(option)

        game_available = message.get("game_available")
        if not isinstance(game_available, bool):
            game_available = None
        if game_available is not True:
            for option in options:
                option["active"] = None

        pending: dict[str, dict[str, Any]] = session["pending"]
        by_option = {
            (item["option_id"], item.get("operation", "toggle")): (
                request_id,
                item,
            )
            for request_id, item in pending.items()
        }
        for option in options:
            toggle_entry = by_option.get((option["id"], "toggle"))
            if toggle_entry is not None:
                request_id, request = toggle_entry
                if option["active"] is request["desired"]:
                    self._finish_pending(session, request_id)
                else:
                    option["pending"] = True
                    option["desired"] = request["desired"]

            value_entry = by_option.get((option["id"], "value"))
            if value_entry is not None:
                request_id, request = value_entry
                if request.get("value_transaction"):
                    option["value_pending"] = True
                    option["desired_value"] = request["value"]
                else:
                    if (
                        option.get("value_type") == "text"
                        and option.get("value") == request["value"]
                    ) or (
                        option.get("value_type") != "text"
                        and self._value_matches(
                            option.get("value"),
                            request["value"],
                        )
                    ):
                        self._finish_pending(session, request_id)
                    else:
                        option["value_pending"] = True
                        option["desired_value"] = request["value"]

            action_entry = by_option.get((option["id"], "action"))
            if action_entry is not None:
                option["action_pending"] = True

        for (option_id, _), (request_id, _) in list(by_option.items()):
            if option_id not in seen:
                self._finish_pending(
                    session,
                    request_id,
                    "修改器菜单中已找不到这个项目",
                )

        session["bridge_revision"] = bridge_revision
        session["game_available"] = game_available
        session["options"] = options
        session["status"] = "connected"
        session["connected"] = True
        session["message"] = (
            ""
            if game_available is True
            else "修改器已连接，但尚未检测到游戏进程"
        )
        for request_id, request in list(session["pending"].items()):
            if (
                request.get("operation") == "value"
                and request.get("value_transaction")
            ):
                await self._advance_value_transaction(session, request_id)
        session["revision"] = self._bump_revision(int(session["app_id"]))
        await self._emit(self._public_snapshot(session))

    @staticmethod
    def _request_option(
        session: dict[str, Any],
        request: dict[str, Any],
    ) -> dict[str, Any] | None:
        return next(
            (
                option
                for option in session["options"]
                if option["id"] == request["option_id"]
            ),
            None,
        )

    def _arm_command_timeout(
        self,
        session: dict[str, Any],
        request: dict[str, Any],
    ) -> None:
        previous = request.get("timeout_task")
        if (
            isinstance(previous, asyncio.Task)
            and previous is not asyncio.current_task()
        ):
            previous.cancel()
        timeout_task = asyncio.create_task(
            self._command_timeout(
                int(session["app_id"]),
                str(session["session_id"]),
                str(request["request_id"]),
            )
        )
        request["timeout_task"] = timeout_task
        self._pending_tasks.add(timeout_task)
        timeout_task.add_done_callback(self._pending_tasks.discard)

    async def _send_value_transaction_command(
        self,
        session: dict[str, Any],
        request: dict[str, Any],
    ) -> None:
        app_id = int(session["app_id"])
        writer = self._writers.get(app_id)
        lock = self._write_locks.get(app_id)
        if writer is None or lock is None or not session.get("connected"):
            raise ConnectionError("bridge 连接已断开")

        phase = request.get("phase")
        if phase == "writing_value":
            request["value_receipt_confirmed"] = False
            request["value_snapshot_confirmed"] = False
            frame = {
                "type": "value_command",
                "session_id": session["session_id"],
                "request_id": request["request_id"],
                "option_id": request["option_id"],
                "value": request["value"],
                "expected_value": request["expected_value"],
                "expected_bridge_revision": session["bridge_revision"],
            }
        elif phase in {"turning_off", "turning_on"}:
            frame = {
                "type": "command",
                "session_id": session["session_id"],
                "request_id": request["request_id"],
                "option_id": request["option_id"],
                "desired": phase == "turning_on",
                "expected_bridge_revision": session["bridge_revision"],
            }
        else:
            raise TrainerRuntimeError("修改器数值事务状态无效")

        request["phase_sent_bridge_revision"] = int(
            session["bridge_revision"]
        )
        await _write_frame(writer, frame, lock)
        self._arm_command_timeout(session, request)

    async def _advance_value_transaction(
        self,
        session: dict[str, Any],
        request_id: str,
    ) -> bool:
        """Advance one value transaction; return True only when it finishes."""
        request = session["pending"].get(request_id)
        if request is None or not request.get("value_transaction"):
            return False
        option = self._request_option(session, request)
        if option is None:
            self._finish_pending(
                session,
                request_id,
                "修改器菜单中已找不到这个项目",
            )
            return True

        sent_revision = int(request.get("phase_sent_bridge_revision") or 0)
        if int(session.get("bridge_revision") or 0) <= sent_revision:
            return False

        phase = request.get("phase")
        if phase == "turning_off":
            if option.get("active") is False:
                request["phase"] = "writing_value"
                await self._send_value_transaction_command(session, request)
            return False

        if phase == "writing_value":
            if (
                option.get("value_type") == "text"
                and option.get("value") == request["value"]
            ) or (
                option.get("value_type") != "text"
                and self._value_matches(option.get("value"), request["value"])
            ):
                request["value_snapshot_confirmed"] = True
            if not (
                request.get("value_receipt_confirmed")
                and request.get("value_snapshot_confirmed")
            ):
                return False
            if request.get("apply_mode") == "invoke":
                self._finish_pending(session, request_id)
                return True
            request["phase"] = "turning_on"
            await self._send_value_transaction_command(session, request)
            return False

        if phase == "turning_on" and option.get("active") is True:
            self._finish_pending(session, request_id)
            return True
        return False

    @staticmethod
    def _value_receipt_is_valid(
        request: dict[str, Any],
        message: dict[str, Any],
    ) -> bool:
        status = _safe_text(message.get("status"), 40).casefold()
        operation = _safe_text(message.get("operation"), 40).casefold()
        invoked = message.get("invoked")
        if operation != "value":
            return False
        if request.get("apply_mode") == "invoke":
            return status == "applied" and invoked is True
        if request.get("apply_mode") == "stage_then_toggle":
            return (
                status == "staged" and invoked is False
            ) or (
                not status and invoked is False
            )
        return False

    async def _mark_command_accepted(
        self,
        session: dict[str, Any],
        message: dict[str, Any],
    ) -> None:
        request_id = _safe_text(message.get("request_id"), 128)
        request = session["pending"].get(request_id)
        if request is None:
            return
        if (
            request.get("operation") == "value"
            and request.get("value_transaction")
        ):
            if (
                request.get("phase") == "writing_value"
                and self._value_receipt_is_valid(request, message)
            ):
                request["accepted"] = True
                request["value_receipt_confirmed"] = True
                if await self._advance_value_transaction(session, request_id):
                    session["revision"] = self._bump_revision(
                        int(session["app_id"])
                    )
                    await self._emit(self._public_snapshot(session))
            return
        request["accepted"] = True
        status = _safe_text(message.get("status"), 40).casefold()
        legacy_action_applied = (
            _safe_text(message.get("operation"), 40).casefold() == "action"
            and message.get("invoked") is True
        )
        if (
            request.get("operation") == "action"
            and (status == "applied" or legacy_action_applied)
        ):
            self._finish_pending(session, request_id)
            session["revision"] = self._bump_revision(int(session["app_id"]))
            await self._emit(self._public_snapshot(session))

    async def _apply_command_error(
        self,
        session: dict[str, Any],
        message: dict[str, Any],
    ) -> None:
        request_id = _safe_text(message.get("request_id"), 128)
        reason = _safe_text(message.get("message"), 500)
        if request_id not in session["pending"]:
            return
        option_id = session["pending"][request_id]["option_id"]
        operation = session["pending"][request_id].get("operation", "toggle")
        self._finish_pending(
            session,
            request_id,
            reason or "修改器拒绝了操作",
        )
        for option in session["options"]:
            if option["id"] == option_id:
                error_field = {
                    "value": "value_error",
                    "action": "action_error",
                }.get(operation, "error")
                option[error_field] = reason or "修改器拒绝了操作"
                break
        session["revision"] = self._bump_revision(int(session["app_id"]))
        await self._emit(self._public_snapshot(session))

    async def _mark_disconnected(
        self,
        app_id: int,
        session_id: str,
        message: str,
    ) -> None:
        session = self._sessions.get(app_id)
        if session is None or session.get("session_id") != session_id:
            return
        for request_id in list(session["pending"]):
            self._finish_pending(
                session,
                request_id,
                "bridge 连接已断开，操作结果未知",
            )
        for option in session["options"]:
            option["active"] = None
            option["pending"] = False
            option["desired"] = None
            option["value_pending"] = False
            option["desired_value"] = None
            option["action_pending"] = False
        session["status"] = "disconnected"
        session["connected"] = False
        session["game_available"] = None
        session["message"] = _safe_text(message, 500) or "bridge 连接已断开"
        session["revision"] = self._bump_revision(app_id)
        await self._emit(self._public_snapshot(session))

    def _finish_pending(
        self,
        session: dict[str, Any],
        request_id: str,
        error: str = "",
    ) -> None:
        request = session["pending"].pop(request_id, None)
        if request is None:
            return
        task = request.get("timeout_task")
        if isinstance(task, asyncio.Task) and task is not asyncio.current_task():
            task.cancel()
        for option in session["options"]:
            if option["id"] == request["option_id"]:
                operation = request.get("operation", "toggle")
                if operation == "value":
                    option["value_pending"] = False
                    option["desired_value"] = None
                    option["value_error"] = error
                elif operation == "action":
                    option["action_pending"] = False
                    option["action_error"] = error
                else:
                    option["pending"] = False
                    option["desired"] = None
                    option["error"] = error
                break
        completion = request.get("completion")
        if isinstance(completion, asyncio.Future) and not completion.done():
            if error:
                completion.set_exception(TrainerRuntimeError(error))
                # The public coroutine normally awaits this future immediately,
                # but it may be cancelled while a frame or change event is in
                # flight. Mark the exception as observed without changing what
                # a later ``await completion`` raises.
                completion.exception()
            else:
                completion.set_result(None)

    async def set_option(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        desired: bool,
        expected_revision: int,
    ) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
            numeric_revision = int(expected_revision)
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("修改器面板请求无效") from error
        if not isinstance(desired, bool):
            raise TrainerRuntimeError("目标开关状态无效")
        session = self._sessions.get(numeric_app_id)
        if (
            session is None
            or not session.get("connected")
            or self._writers.get(numeric_app_id) is None
        ):
            raise TrainerRuntimeError("修改器 bridge 未连接")
        if session_id != session["session_id"]:
            raise TrainerRuntimeError("修改器会话已经变化，请刷新面板")
        if numeric_revision != int(session["revision"]):
            raise TrainerRuntimeError("修改器状态已经变化，请重试")
        if session.get("game_available") is not True:
            raise TrainerRuntimeError("修改器尚未检测到游戏进程")
        option_id = _safe_text(option_id, 128)
        option = next(
            (
                item
                for item in session["options"]
                if item["id"] == option_id
            ),
            None,
        )
        if option is None:
            raise TrainerRuntimeError("修改器菜单中没有这个项目")
        if not option.get("controllable") or not isinstance(
            option.get("active"),
            bool,
        ):
            raise TrainerRuntimeError("这个修改项尚不支持直接控制")
        if (
            option.get("pending")
            or option.get("value_pending")
            or option.get("action_pending")
        ):
            raise TrainerRuntimeError("这个修改项正在等待核心确认")
        if option["active"] is desired:
            return self._public_snapshot(session)

        request_id = uuid.uuid4().hex
        request: dict[str, Any] = {
            "request_id": request_id,
            "option_id": option_id,
            "operation": "toggle",
            "desired": desired,
            "accepted": False,
            "created_at": time.monotonic(),
            "completion": asyncio.get_running_loop().create_future(),
        }
        completion: asyncio.Future[None] = request["completion"]
        session["pending"][request_id] = request
        option["pending"] = True
        option["desired"] = desired
        option["error"] = ""
        session["revision"] = self._bump_revision(numeric_app_id)
        writer = self._writers[numeric_app_id]
        lock = self._write_locks[numeric_app_id]
        try:
            await _write_frame(
                writer,
                {
                    "type": "command",
                    "session_id": session_id,
                    "request_id": request_id,
                    "option_id": option_id,
                    "desired": desired,
                    "expected_bridge_revision": session["bridge_revision"],
                },
                lock,
            )
        except (ConnectionError, OSError) as error:
            self._finish_pending(
                session,
                request_id,
                "bridge 连接中断，操作未确认",
            )
            try:
                await completion
            except TrainerRuntimeError as completion_error:
                raise completion_error from error
            raise TrainerRuntimeError("bridge 连接中断") from error

        if request_id in session["pending"]:
            timeout_task = asyncio.create_task(
                self._command_timeout(numeric_app_id, session_id, request_id)
            )
            request["timeout_task"] = timeout_task
            self._pending_tasks.add(timeout_task)
            timeout_task.add_done_callback(self._pending_tasks.discard)
        await self._emit(self._public_snapshot(session))
        await completion
        return self._public_snapshot(session)

    async def set_option_value(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        value: str,
        expected_value: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
            numeric_revision = int(expected_revision)
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("修改器数值请求无效") from error
        if not isinstance(value, str) or not isinstance(expected_value, str):
            raise TrainerRuntimeError("修改器数值必须是文本格式")
        if (
            "\x00" in value
            or "\x00" in expected_value
            or len(value) > MAX_OPTION_VALUE_CHARS
            or len(expected_value) > MAX_OPTION_VALUE_CHARS
        ):
            raise TrainerRuntimeError("修改器数值过长或包含无效字符")
        desired_value = value.strip()
        if not desired_value:
            raise TrainerRuntimeError("修改器数值不能为空")

        session = self._sessions.get(numeric_app_id)
        if (
            session is None
            or not session.get("connected")
            or self._writers.get(numeric_app_id) is None
        ):
            raise TrainerRuntimeError("修改器 bridge 未连接")
        if session_id != session["session_id"]:
            raise TrainerRuntimeError("修改器会话已经变化，请刷新面板")
        if numeric_revision != int(session["revision"]):
            raise TrainerRuntimeError("修改器状态已经变化，请重试")
        if session.get("game_available") is not True:
            raise TrainerRuntimeError("修改器尚未检测到游戏进程")

        option_id = _safe_text(option_id, 128)
        option = next(
            (
                item
                for item in session["options"]
                if item["id"] == option_id
            ),
            None,
        )
        if option is None:
            raise TrainerRuntimeError("修改器菜单中没有这个项目")
        if not option.get("value_controllable"):
            raise TrainerRuntimeError("这个修改项尚不支持写入数值")
        if (
            option.get("value_pending")
            or option.get("pending")
            or option.get("action_pending")
        ):
            raise TrainerRuntimeError("这个修改项正在等待数值确认")

        value_type = option.get("value_type")
        desired_number: float | None = None
        if value_type in {"integer", "number"}:
            desired_number = _finite_number(desired_value)
            if desired_number is None:
                raise TrainerRuntimeError("修改器数值必须是有限数字")
            if value_type == "integer" and not desired_number.is_integer():
                raise TrainerRuntimeError("这个修改项只接受整数")
        elif value_type != "text":
            raise TrainerRuntimeError("这个修改项的数值类型未知")

        current_value = str(option.get("value") or "")
        if expected_value != current_value:
            raise TrainerRuntimeError("修改器数值已经变化，请重试")
        minimum = _finite_number(option.get("minimum"))
        maximum = _finite_number(option.get("maximum"))
        if (
            desired_number is not None
            and minimum is not None
            and desired_number < minimum
        ):
            raise TrainerRuntimeError(f"修改器数值不能小于 {minimum:g}")
        if (
            desired_number is not None
            and maximum is not None
            and desired_number > maximum
        ):
            raise TrainerRuntimeError(f"修改器数值不能大于 {maximum:g}")
        value_is_unchanged = (
            current_value == desired_value
            if value_type == "text"
            else self._value_matches(current_value, desired_value)
        )
        apply_mode = option.get("value_apply_mode")
        if apply_mode == "stage_then_toggle" and (
            not option.get("controllable")
            or not isinstance(option.get("active"), bool)
        ):
            raise TrainerRuntimeError("这个数值项的开关状态尚不可控")
        if (
            apply_mode == "stage_then_toggle"
            and value_is_unchanged
            and option.get("active") is True
        ):
            return self._public_snapshot(session)

        if apply_mode == "invoke":
            phase = "writing_value"
        elif value_is_unchanged:
            # A staged value only takes effect when its paired toggle is active.
            # Do not send a redundant value write, but still enable the option.
            phase = "turning_on"
        elif option.get("active") is True:
            phase = "turning_off"
        else:
            phase = "writing_value"

        request_id = uuid.uuid4().hex
        request: dict[str, Any] = {
            "request_id": request_id,
            "option_id": option_id,
            "operation": "value",
            "value": desired_value,
            "expected_value": current_value,
            "apply_mode": apply_mode,
            "phase": phase,
            "value_transaction": True,
            "value_receipt_confirmed": False,
            "value_snapshot_confirmed": False,
            "accepted": False,
            "created_at": time.monotonic(),
            "completion": asyncio.get_running_loop().create_future(),
        }
        completion: asyncio.Future[None] = request["completion"]
        session["pending"][request_id] = request
        option["value_pending"] = True
        option["desired_value"] = desired_value
        option["value_error"] = ""
        session["revision"] = self._bump_revision(numeric_app_id)
        try:
            await self._send_value_transaction_command(session, request)
        except (ConnectionError, OSError) as error:
            self._finish_pending(
                session,
                request_id,
                "bridge 连接中断，数值写入未确认",
            )
            try:
                await completion
            except TrainerRuntimeError as completion_error:
                raise completion_error from error
            raise TrainerRuntimeError("bridge 连接中断") from error

        await self._emit(self._public_snapshot(session))
        await completion
        return self._public_snapshot(session)

    async def invoke_option_action(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        try:
            numeric_app_id = int(app_id)
            numeric_revision = int(expected_revision)
        except (TypeError, ValueError) as error:
            raise TrainerRuntimeError("修改器执行请求无效") from error
        session = self._sessions.get(numeric_app_id)
        if (
            session is None
            or not session.get("connected")
            or self._writers.get(numeric_app_id) is None
        ):
            raise TrainerRuntimeError("修改器 bridge 未连接")
        if session_id != session["session_id"]:
            raise TrainerRuntimeError("修改器会话已经变化，请刷新面板")
        if numeric_revision != int(session["revision"]):
            raise TrainerRuntimeError("修改器状态已经变化，请重试")
        if session.get("game_available") is not True:
            raise TrainerRuntimeError("修改器尚未检测到游戏进程")

        option_id = _safe_text(option_id, 128)
        option = next(
            (
                item
                for item in session["options"]
                if item["id"] == option_id
            ),
            None,
        )
        if option is None:
            raise TrainerRuntimeError("修改器菜单中没有这个项目")
        if option.get("kind") != "action" or not option.get(
            "action_controllable"
        ):
            raise TrainerRuntimeError("这个修改项尚不支持直接执行")
        if (
            option.get("action_pending")
            or option.get("pending")
            or option.get("value_pending")
        ):
            raise TrainerRuntimeError("这个修改项正在等待执行确认")

        request_id = uuid.uuid4().hex
        request: dict[str, Any] = {
            "request_id": request_id,
            "option_id": option_id,
            "operation": "action",
            "accepted": False,
            "created_at": time.monotonic(),
            "completion": asyncio.get_running_loop().create_future(),
        }
        completion: asyncio.Future[None] = request["completion"]
        session["pending"][request_id] = request
        option["action_pending"] = True
        option["action_error"] = ""
        session["revision"] = self._bump_revision(numeric_app_id)
        writer = self._writers[numeric_app_id]
        lock = self._write_locks[numeric_app_id]
        try:
            await _write_frame(
                writer,
                {
                    "type": "action_command",
                    "session_id": session_id,
                    "request_id": request_id,
                    "option_id": option_id,
                    "expected_bridge_revision": session["bridge_revision"],
                },
                lock,
            )
        except (ConnectionError, OSError) as error:
            self._finish_pending(
                session,
                request_id,
                "bridge 连接中断，动作执行未确认",
            )
            try:
                await completion
            except TrainerRuntimeError as completion_error:
                raise completion_error from error
            raise TrainerRuntimeError("bridge 连接中断") from error

        if request_id in session["pending"]:
            timeout_task = asyncio.create_task(
                self._command_timeout(numeric_app_id, session_id, request_id)
            )
            request["timeout_task"] = timeout_task
            self._pending_tasks.add(timeout_task)
            timeout_task.add_done_callback(self._pending_tasks.discard)
        await self._emit(self._public_snapshot(session))
        await completion
        return self._public_snapshot(session)

    async def _command_timeout(
        self,
        app_id: int,
        session_id: str,
        request_id: str,
    ) -> None:
        await asyncio.sleep(COMMAND_TIMEOUT_SECONDS)
        session = self._sessions.get(app_id)
        if (
            session is None
            or session.get("session_id") != session_id
            or request_id not in session["pending"]
        ):
            return
        option_id = session["pending"][request_id]["option_id"]
        operation = session["pending"][request_id].get("operation", "toggle")
        timeout_message = (
            "修改器未在超时内确认动作执行结果"
            if operation == "action"
            else "修改器核心未在超时内确认状态"
        )
        self._finish_pending(
            session,
            request_id,
            timeout_message,
        )
        for option in session["options"]:
            if option["id"] == option_id:
                error_field = {
                    "value": "value_error",
                    "action": "action_error",
                }.get(operation, "error")
                option[error_field] = timeout_message
                break
        session["revision"] = self._bump_revision(app_id)
        await self._emit(self._public_snapshot(session))
