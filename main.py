from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

PLUGIN_ROOT = Path(__file__).resolve().parent
PY_MODULES = PLUGIN_ROOT / "py_modules"
if PY_MODULES.is_dir() and str(PY_MODULES) not in sys.path:
    sys.path.insert(0, str(PY_MODULES))

try:
    import decky
except ImportError:  # Older Decky Loader releases exposed only this alias.
    import decky_plugin as decky

from trainerdeck_core import TrainerDeckCore

if TYPE_CHECKING:
    from trainerdeck_runtime import TrainerRuntimeManager


class Plugin:
    def __init__(self):
        self.user_home = Path(
            getattr(decky, "DECKY_USER_HOME", "")
            or os.environ.get("DECKY_USER_HOME")
            or os.environ.get("HOME")
            or "/home/deck"
        )
        decky_home = Path(
            getattr(decky, "DECKY_HOME", "")
            or os.environ.get("DECKY_HOME")
            or self.user_home / "homebrew"
        )
        plugin_directory = os.environ.get("DECKY_PLUGIN_NAME") or "TrainerDeck"
        self.settings_dir = Path(
            getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", "")
            or os.environ.get("DECKY_PLUGIN_SETTINGS_DIR")
            or decky_home / "settings" / plugin_directory
        )
        self.runtime_dir = Path(
            getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", "")
            or os.environ.get("DECKY_PLUGIN_RUNTIME_DIR")
            or decky_home / "data" / plugin_directory
        )
        self.user_name = (
            getattr(decky, "DECKY_USER", "")
            or os.environ.get("DECKY_USER")
            or os.environ.get("USER")
            or self.user_home.name
            or "deck"
        )
        # Decky instantiates Plugin before it creates the callable socket. Keep
        # construction free of filesystem I/O so a stale root-owned directory
        # cannot make every frontend call remain pending until it times out.
        self.core: TrainerDeckCore | None = None
        self.runtime: TrainerRuntimeManager | None = None
        self.core_start_error = ""
        self.runtime_started = False
        self.runtime_start_error = ""

    def _ensure_core(self) -> TrainerDeckCore:
        if self.core is not None:
            return self.core
        try:
            self.core = TrainerDeckCore(
                settings_dir=self.settings_dir,
                runtime_dir=self.runtime_dir,
                user_home=self.user_home,
                user_name=self.user_name,
            )
            self.core_start_error = ""
            return self.core
        except Exception as error:
            self.core_start_error = str(error)
            raise RuntimeError(
                f"TrainerDeck 存储初始化失败：{error}"
            ) from error

    def _ensure_runtime(self) -> TrainerRuntimeManager:
        if self.runtime is not None:
            return self.runtime
        try:
            # Decky's backend is a frozen PyInstaller executable. Import the
            # optional bridge only after the callable socket exists so a
            # missing frozen stdlib module cannot disable settings/downloads.
            from trainerdeck_runtime import TrainerRuntimeManager

            self.runtime = TrainerRuntimeManager(
                runtime_dir=self.runtime_dir / "bridge",
                bridge_assets_dir=PLUGIN_ROOT / "bin" / "bridge",
            )
            self.runtime_start_error = ""
            return self.runtime
        except Exception as error:
            self.runtime_start_error = str(error)
            raise RuntimeError(
                f"TrainerDeck 同步组件初始化失败：{error}"
            ) from error

    def _require_runtime(self) -> TrainerRuntimeManager:
        if self.runtime is None or not self.runtime_started:
            detail = self.runtime_start_error or "同步组件尚未启动"
            raise RuntimeError(f"TrainerDeck 修改器面板不可用：{detail}")
        return self.runtime

    async def _main(self):
        core = None
        try:
            core = self._ensure_core()
        except Exception:
            decky.logger.exception(
                "TrainerDeck storage failed; callable socket remains available"
            )
        try:
            runtime = self._ensure_runtime()
            await runtime.start(self._emit_runtime_snapshot)
            self.runtime_started = True
            for app_id, installation in (
                core.list_bindings().items() if core is not None else []
            ):
                try:
                    runtime.prepare_bridge(app_id, installation)
                except Exception as error:
                    runtime.record_prepare_failure(
                        app_id,
                        installation,
                        error,
                    )
                    decky.logger.warning(
                        "Unable to refresh trainer bridge for app %s: %s",
                        app_id,
                        error,
                    )
            decky.logger.info("TrainerDeck backend started")
        except Exception as error:
            self.runtime_start_error = str(error)
            decky.logger.exception(
                "TrainerDeck direct-sync runtime failed; settings and search remain available"
            )

    async def _unload(self):
        if self.runtime_started and self.runtime is not None:
            await self.runtime.stop()
        decky.logger.info("TrainerDeck backend stopped")

    async def _uninstall(self):
        # Installed trainers are user data and are intentionally preserved.
        decky.logger.info("TrainerDeck uninstalled; downloaded trainers were preserved")

    async def backend_status(self) -> dict[str, Any]:
        if self.core is None:
            try:
                self._ensure_core()
            except Exception:
                # Health calls must report startup errors instead of turning
                # them into another unresolved/failed frontend operation.
                pass
        return {
            "ok": self.core is not None,
            "version": "0.6.9",
            "python_version": sys.version.split()[0],
            "core_ready": self.core is not None,
            "core_error": self.core_start_error,
            "runtime_ready": self.runtime_started,
            "runtime_error": self.runtime_start_error,
            "settings_dir": str(self.settings_dir),
            "runtime_dir": str(self.runtime_dir),
        }

    async def get_settings(self):
        return self._ensure_core().get_settings()

    async def save_settings(self, settings: dict):
        return self._ensure_core().save_settings(settings)

    async def search_trainers(self, query: str):
        core = self._ensure_core()
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(core.search_trainers, query),
                timeout=15,
            )
        except asyncio.TimeoutError:
            return {
                "items": [],
                "warnings": ["FLiNG 搜索超时，请检查网络后重试"],
            }

    async def download_trainer(self, entry: dict):
        core = self._ensure_core()
        return await asyncio.to_thread(core.download_trainer, entry)

    async def list_installed(self):
        core = self._ensure_core()
        return await asyncio.to_thread(core.list_installed)

    async def get_binding(self, app_id: int):
        return self._ensure_core().get_binding(app_id)

    async def list_bindings(self):
        return self._ensure_core().list_binding_records()

    async def bind_trainer(
        self,
        app_id: int,
        installation_id: str,
        managed_launch_executable: str = "",
        original_launch_options: str | None = None,
        applied_launch_options: str = "",
        display_name: str = "",
        target_type: str = "",
        shortcut_exe: str = "",
        launch_options_field: str = "",
    ):
        return self._ensure_core().bind_trainer(
            app_id,
            installation_id,
            managed_launch_executable,
            original_launch_options,
            applied_launch_options,
            display_name,
            target_type,
            shortcut_exe,
            launch_options_field,
        )

    async def unbind_trainer(
        self,
        app_id: int,
        launch_options_restored: bool = False,
    ):
        removed = self._ensure_core().unbind_trainer(
            app_id,
            launch_options_restored,
        )
        if self.runtime_started and self.runtime is not None:
            await self.runtime.revoke_app(app_id)
        return removed

    async def prepare_trainer_bridge(self, app_id: int, installation_id: str):
        core = self._ensure_core()
        runtime = self._require_runtime()
        installation = core.get_installation(installation_id)
        prepared = await asyncio.to_thread(
            runtime.prepare_bridge,
            app_id,
            installation,
        )
        await runtime.invalidate_app(app_id)
        await runtime.emit_snapshot(app_id)
        return prepared

    async def get_trainer_runtime(self, app_id: int):
        return self._require_runtime().get_snapshot(app_id)

    async def set_trainer_option(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        desired: bool,
        expected_revision: int,
    ):
        return await self._require_runtime().set_option(
            app_id,
            session_id,
            option_id,
            desired,
            expected_revision,
        )

    async def set_trainer_option_value(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        value: str,
        expected_value: str,
        expected_revision: int,
    ):
        return await self._require_runtime().set_option_value(
            app_id,
            session_id,
            option_id,
            value,
            expected_value,
            expected_revision,
        )

    async def invoke_trainer_option(
        self,
        app_id: int,
        session_id: str,
        option_id: str,
        expected_revision: int,
    ):
        return await self._require_runtime().invoke_option_action(
            app_id,
            session_id,
            option_id,
            expected_revision,
        )

    async def _emit_runtime_snapshot(self, snapshot: dict):
        try:
            await decky.emit("trainer_runtime_changed", snapshot)
        except Exception as error:
            # The CEF websocket may be absent while the game/plugin UI is closed.
            # Runtime snapshots remain cached and are fetched on the next mount.
            decky.logger.debug("Runtime event was not delivered: %s", error)
