import importlib.util
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


class DeckyBackendStartupTests(unittest.TestCase):
    @staticmethod
    def _load_main(module_name, environment, fake_decky):
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch.dict(sys.modules, {"decky": fake_decky}),
        ):
            spec = importlib.util.spec_from_file_location(
                module_name,
                ROOT / "main.py",
            )
            if spec is None or spec.loader is None:
                raise AssertionError("main.py could not be loaded")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module

    def test_startup_bridge_refresh_failure_is_exposed_to_snapshot(self):
        logger = types.SimpleNamespace(
            warning=mock.Mock(),
            info=mock.Mock(),
            exception=mock.Mock(),
        )
        fake_decky = types.ModuleType("decky")
        fake_decky.logger = logger
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                "HOME": str(Path(temporary) / "deck"),
                "USER": "deck",
                "DECKY_PLUGIN_NAME": "TrainerDeck",
            }
            module = self._load_main(
                "trainerdeck_decky_main_refresh_failure_test",
                environment,
                fake_decky,
            )
            installation = {
                "id": "installed",
                "executable": "/trainer/Game Trainer.exe",
                "sha256": "a" * 64,
            }

            class FakeCore:
                def list_bindings(self):
                    return {1234: installation}

            class FakeRuntime:
                def __init__(self):
                    self.failure = None

                async def start(self, _on_change):
                    return None

                def prepare_bridge(self, _app_id, _installation):
                    raise PermissionError("destination is read-only")

                def record_prepare_failure(self, app_id, current, error):
                    self.failure = (app_id, current, error)

            plugin = module.Plugin()
            runtime = FakeRuntime()
            with (
                mock.patch.object(plugin, "_ensure_core", return_value=FakeCore()),
                mock.patch.object(plugin, "_ensure_runtime", return_value=runtime),
            ):
                asyncio.run(plugin._main())

            self.assertTrue(plugin.runtime_started)
            self.assertIsNotNone(runtime.failure)
            self.assertEqual(runtime.failure[0], 1234)
            self.assertIs(runtime.failure[1], installation)
            self.assertIsInstance(runtime.failure[2], PermissionError)
            logger.warning.assert_called_once()

    def test_optional_runtime_import_cannot_disable_core_backend(self):
        fake_decky = types.ModuleType("decky")
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                "HOME": str(Path(temporary) / "deck"),
                "USER": "deck",
                "DECKY_PLUGIN_NAME": "TrainerDeck",
            }
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.dict(
                    sys.modules,
                    {"decky": fake_decky, "trainerdeck_runtime": None},
                ),
            ):
                spec = importlib.util.spec_from_file_location(
                    "trainerdeck_decky_main_runtime_import_test",
                    ROOT / "main.py",
                )
                self.assertIsNotNone(spec)
                self.assertIsNotNone(spec.loader)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                plugin = module.Plugin()

                self.assertIsNone(plugin.runtime)
                self.assertEqual(
                    plugin._ensure_core().get_settings()["trainer_root"],
                    str(Path(temporary) / "deck" / "Downloads" / "trainer"),
                )
                with self.assertRaisesRegex(RuntimeError, "同步组件初始化失败"):
                    plugin._ensure_runtime()

    def test_core_initializes_on_first_use_and_old_constants_are_optional(self):
        fake_decky = types.ModuleType("decky")
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "deck"
            environment = {
                "HOME": str(home),
                "USER": "deck",
                "DECKY_PLUGIN_NAME": "TrainerDeck",
            }
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.dict(sys.modules, {"decky": fake_decky}),
            ):
                spec = importlib.util.spec_from_file_location(
                    "trainerdeck_decky_main_test",
                    ROOT / "main.py",
                )
                self.assertIsNotNone(spec)
                self.assertIsNotNone(spec.loader)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                plugin = module.Plugin()

            self.assertIsNone(plugin.core)
            settings = plugin._ensure_core().get_settings()
            self.assertEqual(
                settings["trainer_root"],
                str(home / "Downloads" / "trainer"),
            )
            self.assertEqual(
                plugin.core.settings_dir,
                (home / "homebrew" / "settings" / "TrainerDeck").resolve(),
            )
            self.assertFalse(plugin.runtime_started)

    def test_constructor_survives_storage_initialization_failure(self):
        fake_decky = types.ModuleType("decky")
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                "HOME": str(Path(temporary) / "deck"),
                "USER": "deck",
                "DECKY_PLUGIN_NAME": "TrainerDeck",
            }
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.dict(sys.modules, {"decky": fake_decky}),
            ):
                spec = importlib.util.spec_from_file_location(
                    "trainerdeck_decky_main_failure_test",
                    ROOT / "main.py",
                )
                self.assertIsNotNone(spec)
                self.assertIsNotNone(spec.loader)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                with mock.patch.object(
                    module,
                    "TrainerDeckCore",
                    side_effect=PermissionError("permission denied"),
                ):
                    plugin = module.Plugin()
                    self.assertIsNone(plugin.core)
                    with self.assertRaisesRegex(RuntimeError, "存储初始化失败"):
                        plugin._ensure_core()
                    status = asyncio.run(plugin.backend_status())
                    self.assertFalse(status["ok"])
                    self.assertIn("permission denied", status["core_error"])


if __name__ == "__main__":
    unittest.main()
