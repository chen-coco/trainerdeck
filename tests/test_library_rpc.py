"""Exercise the Decky RPC entry points through real storage and bridge runtime.

Only the remote payload fetch is replaced. The downloaded ZIP, generated
metadata, preparation, binding records, safety checks and deletion are real.
Windows does not expose Linux /proc, so these tests do not certify Steam Deck
process discovery; test_library.py separately exercises that scanner's inputs.
"""

import asyncio
import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import threading
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from trainerdeck_core import METADATA_FILENAME, TrainerDeckError
from trainerdeck_runtime import BRIDGE_ASSET_FILENAMES, TrainerRuntimeError, TrainerRuntimeManager


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

    async def binding_snapshot(self, app_id=1234):
        record = next(row for row in await self.plugin.list_bindings() if row["app_id"] == app_id)
        return {key: record[key] for key in ("app_id", "installation_id", "bound_at")}

    async def test_force_forget_releases_old_app_runtime_ownership_for_reinstalled_game(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        snapshot = await self.binding_snapshot()
        self.assertIn(1234, self.plugin.runtime._prepared)
        self.assertTrue(await self.plugin.forget_trainer_binding(
            1234, snapshot["installation_id"], snapshot["bound_at"],
        ))
        self.assertEqual(await self.plugin.list_bindings(), [])
        self.assertNotIn(1234, self.plugin.runtime._prepared)
        self.assertNotIn(1234, self.plugin.runtime._tokens)
        self.assertNotIn(1234, self.plugin.runtime._owned_installations)
        self.assertTrue(Path(installed["executable"]).is_file())
        prepared = await self.plugin.prepare_trainer_bridge(5678, installed["id"], installed["folder"])
        binding = await self.plugin.bind_trainer(
            5678, installed["id"], prepared["launch_executable"],
            installation_folder=installed["folder"],
        )
        self.assertEqual(binding["app_id"], 5678)

    async def test_force_forget_stale_snapshot_does_not_revoke_preparation(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        snapshot = await self.binding_snapshot()
        with self.assertRaisesRegex(TrainerDeckError, "记录已变化"):
            await self.plugin.forget_trainer_binding(1234, snapshot["installation_id"], "stale")
        self.assertIn(1234, self.plugin.runtime._prepared)
        self.assertIsNotNone(await self.plugin.get_binding(1234))

    async def test_replacing_binding_cannot_commit_preparation_revoked_by_forgetting_old_record(self):
        old = await self.download("v1")
        new = await self.download("v2")
        await self.prepare_and_bind(old)
        snapshot = await self.binding_snapshot()
        prepared = await self.plugin.prepare_trainer_bridge(1234, new["id"], new["folder"])
        await self.plugin.forget_trainer_binding(1234, snapshot["installation_id"], snapshot["bound_at"])
        with self.assertRaisesRegex(TrainerRuntimeError, "准备状态已变化"):
            await self.plugin.bind_trainer(1234, new["id"], prepared["launch_executable"], installation_folder=new["folder"])
        self.assertEqual(await self.plugin.list_bindings(), [])
        self.assertNotIn(1234, self.plugin.runtime._tokens)
        prepared = await self.plugin.prepare_trainer_bridge(1234, new["id"], new["folder"])
        self.assertEqual((await self.plugin.bind_trainer(1234, new["id"], prepared["launch_executable"], installation_folder=new["folder"]))["app_id"], 1234)

    async def test_original_executable_binding_does_not_require_bridge_preparation(self):
        installed = await self.download()
        binding = await self.plugin.bind_trainer(1234, installed["id"], installed["executable"], installation_folder=installed["folder"])
        self.assertEqual(binding["app_id"], 1234)
        self.assertNotIn(1234, self.plugin.runtime._prepared)

    async def test_force_delete_discards_confirmed_binding_and_runtime_ownership(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        snapshot = await self.binding_snapshot()
        self.assertTrue(await self.plugin.delete_installation(installed["id"], installed["folder"], [snapshot]))
        self.assertFalse(Path(installed["folder"]).exists())
        self.assertEqual(await self.plugin.list_bindings(), [])
        self.assertNotIn(1234, self.plugin.runtime._prepared)
        self.assertNotIn(1234, self.plugin.runtime._tokens)
        self.assertNotIn(1234, self.plugin.runtime._owned_installations)
        self.assertEqual(self.plugin.runtime._installation_owners, {})

    async def test_force_delete_cannot_bypass_connected_or_os_process_protection(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        snapshot = await self.binding_snapshot()
        before = self.plugin._ensure_core().bindings_path.read_bytes()
        with mock.patch.dict(self.plugin.runtime._sessions, {1234: {"connected": True}}):
            with self.assertRaisesRegex(TrainerRuntimeError, "仍在运行"):
                await self.plugin.delete_installation(installed["id"], installed["folder"], [snapshot])
        with mock.patch.object(self.plugin._ensure_core(), "_assert_installation_not_running", side_effect=TrainerDeckError("Wine 仍在运行")):
            with self.assertRaisesRegex(TrainerDeckError, "Wine 仍在运行"):
                await self.plugin.delete_installation(installed["id"], installed["folder"], [snapshot])
        self.assertEqual(self.plugin._ensure_core().bindings_path.read_bytes(), before)
        self.assertTrue(Path(installed["executable"]).is_file())
        self.assertIn(1234, self.plugin.runtime._prepared)
        self.assertIn(1234, self.plugin.runtime._tokens)

    async def test_force_delete_historical_path_cannot_revoke_connected_new_version(self):
        old = await self.download("v1")
        current = await self.download("v2")
        await self.prepare_and_bind(current)
        core = self.plugin._ensure_core()
        records = json.loads(core.bindings_path.read_text(encoding="utf-8"))
        records["1234"]["candidate_launch_executables"].append(old["executable"])
        core.bindings_path.write_text(json.dumps(records), encoding="utf-8")
        snapshot = await self.binding_snapshot()
        before = core.bindings_path.read_bytes()
        with mock.patch.dict(self.plugin.runtime._sessions, {1234: {"connected": True}}):
            with self.assertRaisesRegex(TrainerDeckError, "关联修改器仍在运行"):
                await self.plugin.delete_installation(old["id"], old["folder"], [snapshot])
        self.assertTrue(Path(old["executable"]).is_file())
        self.assertTrue(Path(current["executable"]).is_file())
        self.assertEqual(core.bindings_path.read_bytes(), before)
        self.assertIn(1234, self.plugin.runtime._prepared)

    async def test_binding_mutations_wait_for_force_delete_transaction(self):
        installed = await self.download()
        await self.prepare_and_bind(installed)
        snapshot = await self.binding_snapshot()
        core = self.plugin._ensure_core()
        remove = core.delete_installation
        entered = threading.Event()
        release = threading.Event()

        def paused_delete(*arguments):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Timed out releasing force deletion")
            return remove(*arguments)

        with mock.patch.object(core, "delete_installation", side_effect=paused_delete):
            deleting = asyncio.create_task(self.plugin.delete_installation(installed["id"], installed["folder"], [snapshot]))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            rebinding = asyncio.create_task(self.plugin.bind_trainer(5678, installed["id"], installation_folder=installed["folder"]))
            unbinding = asyncio.create_task(self.plugin.unbind_trainer(1234, True))
            try:
                await asyncio.sleep(0)
                self.assertFalse(rebinding.done())
                self.assertFalse(unbinding.done())
            finally:
                release.set()
            self.assertTrue(await deleting)
            with self.assertRaisesRegex(TrainerDeckError, "找不到已安装修改器"):
                await rebinding
            self.assertFalse(await unbinding)
        self.assertEqual(await self.plugin.list_bindings(), [])

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
