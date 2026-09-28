"""Exercise the Decky RPC entry points through real storage and bridge runtime.

Only the remote payload fetch is replaced. The downloaded ZIP, generated
metadata, preparation, binding records, safety checks and deletion are real.
Windows does not expose Linux /proc, so these tests do not certify Steam Deck
process discovery; test_library.py separately exercises that scanner's inputs.
"""

import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from trainerdeck_core import METADATA_FILENAME, TrainerDeckError
from trainerdeck_runtime import BRIDGE_ASSET_FILENAMES, TrainerRuntimeManager


ROOT = Path(__file__).resolve().parents[1]


class LibraryRpcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.assets = self.root / "bridge-assets"
        self.assets.mkdir()
        for filename in BRIDGE_ASSET_FILENAMES:
            (self.assets / filename).write_bytes(b"MZ-test-bridge-asset")
        self.archive = self.root / "download-payload.zip"
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("Game Trainer.exe", b"MZ" + b"\0" * 64)
            archive.writestr("readme.txt", "RPC integration fixture")
        self.archive_hash = hashlib.sha256(self.archive.read_bytes()).hexdigest()

        fake_decky = types.ModuleType("decky")
        fake_decky.DECKY_USER_HOME = str(self.home)
        fake_decky.DECKY_PLUGIN_SETTINGS_DIR = str(self.root / "settings")
        fake_decky.DECKY_PLUGIN_RUNTIME_DIR = str(self.root / "runtime")
        fake_decky.DECKY_USER = "deck"
        fake_decky.logger = mock.Mock()
        fake_decky.emit = mock.AsyncMock()
        with mock.patch.dict(sys.modules, {"decky": fake_decky}):
            spec = importlib.util.spec_from_file_location(
                "trainerdeck_library_rpc_integration", ROOT / "main.py",
            )
            if spec is None or spec.loader is None:
                raise AssertionError("The Decky backend entry point is unavailable")
            self.main = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.main)
        self.plugin = self.make_plugin()
        await self.plugin._main()
        self.assertTrue(self.plugin.runtime_started)

    async def asyncTearDown(self):
        await self.plugin._unload()
        self.temporary.cleanup()

    def make_plugin(self):
        plugin = self.main.Plugin()
        # The actual manager uses temporary bridge fixtures rather than touching
        # packaged assets. No runtime methods or deletion guards are mocked.
        plugin.runtime = TrainerRuntimeManager(
            runtime_dir=self.root / "runtime" / "bridge",
            bridge_assets_dir=self.assets,
        )
        return plugin

    async def download(self, version="v1"):
        def fetch_payload(url, destination, max_bytes, official_only):
            self.assertEqual(url, "https://example.test/trainer.zip")
            self.assertGreater(max_bytes, self.archive.stat().st_size)
            self.assertFalse(official_only)
            shutil.copyfile(self.archive, destination)
            return "Game.Trainer.zip", "application/zip", self.archive_hash

        with mock.patch.object(
            self.plugin._ensure_core(), "_download_to_file", side_effect=fetch_payload,
        ) as fetch:
            installed = await self.plugin.download_trainer({
                "provider": "external",
                "game_name": "RPC Example Game",
                "title": "RPC Example Game Trainer",
                "version": version,
                "download_url": "https://example.test/trainer.zip",
            })
        fetch.assert_called_once()
        self.assertRegex(installed["id"], r"^[0-9a-f]{24}$")
        metadata = json.loads(
            (Path(installed["folder"]) / METADATA_FILENAME).read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["id"], installed["id"])
        self.assertEqual(metadata["schema_version"], 3)
        self.assertEqual(metadata["sha256"], self.archive_hash)
        self.assertTrue(Path(installed["executable"]).is_file())
        return installed

    async def prepare_and_bind(self, installed):
        prepared = await self.plugin.prepare_trainer_bridge(
            1234, installed["id"], installed["folder"],
        )
        self.assertTrue(prepared["supported"])
        self.assertTrue(Path(prepared["launch_executable"]).is_file())
        return await self.plugin.bind_trainer(
            1234,
            installed["id"],
            managed_launch_executable=prepared["launch_executable"],
            original_launch_options="MANGOHUD=1 %command%",
            applied_launch_options=f'PROTON_REMOTE_DEBUG_CMD="{prepared["launch_executable"]}" %command%',
            display_name="RPC Example Game",
            target_type="steam",
            launch_options_field="app",
            installation_folder=installed["folder"],
        )

    async def test_downloaded_unbound_version_is_really_deleted(self):
        installed = await self.download()
        other = await self.download("v2")
        self.assertEqual(len(await self.plugin.list_installed()), 2)

        deleted = await self.plugin.delete_installation(installed["id"], installed["folder"])

        self.assertIs(deleted, True)
        self.assertFalse(Path(installed["folder"]).exists())
        remaining = await self.plugin.list_installed()
        self.assertEqual([record["id"] for record in remaining], [other["id"]])
        self.assertTrue(Path(other["executable"]).is_file())

    async def test_prepared_bound_then_recovered_installation_deletes_without_reload(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        original_runtime = self.plugin.runtime

        with self.assertRaisesRegex(TrainerDeckError, "绑定"):
            await self.plugin.delete_installation(installed["id"], installed["folder"])
        self.assertTrue(Path(installed["executable"]).is_file())
        self.assertEqual(len(await self.plugin.list_installed()), 1)

        self.assertTrue(await self.plugin.unbind_trainer(1234, True))
        self.assertTrue(await self.plugin.delete_installation(installed["id"], installed["folder"]))
        self.assertIs(self.plugin.runtime, original_runtime)
        self.assertFalse(Path(installed["folder"]).exists())
        self.assertEqual(await self.plugin.list_installed(), [])
        bindings = await self.plugin.list_bindings()
        self.assertFalse(bindings[0]["active"])
        self.assertTrue(bindings[0]["launch_options_restored"])

        await self.plugin._unload()
        self.plugin = self.make_plugin()
        await self.plugin._main()
        self.assertTrue(self.plugin.runtime_started)
        self.assertEqual(await self.plugin.list_installed(), [])
        self.assertIsNone(await self.plugin.get_binding(1234))

    async def test_unrestored_launch_options_remain_protected_until_recovery(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        self.assertTrue(await self.plugin.unbind_trainer(1234, False))

        with self.assertRaisesRegex(TrainerDeckError, "恢复启动项"):
            await self.plugin.delete_installation(installed["id"], installed["folder"])
        self.assertTrue(Path(installed["folder"]).is_dir())

        # The binding is already inactive; this call still records recovery.
        self.assertFalse(await self.plugin.unbind_trainer(1234, True))
        self.assertTrue(await self.plugin.delete_installation(installed["id"], installed["folder"]))
        self.assertEqual(await self.plugin.list_installed(), [])

    async def test_backend_validation_errors_propagate_and_preserve_the_directory(self):
        installed = await self.download()
        metadata_path = Path(installed["folder"]) / METADATA_FILENAME
        before = metadata_path.read_bytes()

        with self.assertRaisesRegex(TrainerDeckError, "不一致"):
            await self.plugin.delete_installation("f" * 24, installed["folder"])
        with self.assertRaisesRegex(TrainerDeckError, "具体修改器版本"):
            await self.plugin.delete_installation(installed["id"], str(self.home))

        self.assertEqual(metadata_path.read_bytes(), before)
        self.assertTrue(Path(installed["executable"]).is_file())
        self.assertEqual(len(await self.plugin.list_installed()), 1)
        # A rejected request must not leave either operation lock stuck.
        self.assertTrue(await self.plugin.delete_installation(installed["id"], installed["folder"]))


if __name__ == "__main__":
    unittest.main()
