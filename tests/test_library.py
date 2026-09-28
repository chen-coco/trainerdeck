import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from trainerdeck_core import METADATA_FILENAME, TrainerDeckCore, TrainerDeckError
from trainerdeck_runtime import BRIDGE_ASSET_FILENAMES, TrainerRuntimeError, TrainerRuntimeManager


class LibraryCoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.core = self.make_core()
        self.trainer_root = Path(self.core.get_settings()["trainer_root"])

    def tearDown(self):
        self.temporary.cleanup()

    def make_core(self):
        return TrainerDeckCore(self.root / "settings", self.root / "runtime", self.home)

    def install(self, version="v1", installation_id="a" * 24):
        folder = self.trainer_root / "Game" / version
        folder.mkdir(parents=True)
        (folder / "Trainer.exe").write_bytes(b"MZtrainer")
        metadata = {
            "schema_version": 3,
            "id": installation_id,
            "sha256": "b" * 64,
            "game_name": "Game",
            "title": "Game Trainer",
            "version": version,
            "executable_relative": "Trainer.exe",
            "installed_at": "2026-09-20T00:00:00+00:00",
        }
        self.write_json(folder / METADATA_FILENAME, metadata)
        return self.core._installation_record(folder, metadata)

    @staticmethod
    def write_json(path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_favorites_persist_and_are_isolated_by_game_and_executable_hash(self):
        digest = "a" * 64
        self.assertEqual(self.core.get_option_favorites(12, digest), [])
        self.assertEqual(self.core.set_option_favorite(12, digest.upper(), "无限生命", True), ["无限生命"])
        fresh = self.make_core()
        self.assertEqual(fresh.get_option_favorites(12, digest), ["无限生命"])
        self.assertEqual(fresh.get_option_favorites(13, digest), [])
        self.assertEqual(fresh.get_option_favorites(12, "b" * 64), [])
        self.assertEqual(fresh.set_option_favorite(12, digest, "无限生命", False), [])
        self.assertEqual(fresh._favorite_records(), {})

    def test_concurrent_favorite_updates_across_core_instances_do_not_lose_writes(self):
        cores = [self.make_core() for _ in range(4)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda index: cores[index % 4].set_option_favorite(12, "a" * 64, f"option-{index}", True), range(64)))
        self.assertEqual(set(self.core.get_option_favorites(12, "a" * 64)), {f"option-{index}" for index in range(64)})
        self.assertEqual(list(self.core.settings_dir.glob("*.tmp")), [])

    def test_invalid_favorites_cannot_overwrite_existing_data(self):
        self.core.set_option_favorite(12, "a" * 64, "health", True)
        before = self.core.favorites_path.read_bytes()
        cases = [
            (True, "a" * 64, "health", True),
            (0, "a" * 64, "health", True),
            (2 ** 32, "a" * 64, "health", True),
            (12, "archive-hash", "health", True),
            (12, "a" * 64, "\0bad", True),
            (12, "a" * 64, "x" * 129, True),
            (12, "a" * 64, "health", 1),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments), self.assertRaises(TrainerDeckError):
                self.core.set_option_favorite(*arguments)
            self.assertEqual(self.core.favorites_path.read_bytes(), before)

    def test_favorite_limit_and_corruption_fail_without_destroying_existing_data(self):
        with patch("trainerdeck_core.MAX_FAVORITES_PER_SCOPE", 1):
            self.core.set_option_favorite(12, "a" * 64, "health", True)
            with self.assertRaises(TrainerDeckError):
                self.core.set_option_favorite(12, "a" * 64, "money", True)
        self.assertEqual(self.core.get_option_favorites(12, "a" * 64), ["health"])
        self.core.favorites_path.write_text("broken", encoding="utf-8")
        with self.assertRaises(TrainerDeckError):
            self.core.set_option_favorite(12, "a" * 64, "health", True)
        self.assertEqual(self.core.favorites_path.read_text(encoding="utf-8"), "broken")

    def test_delete_exact_copy_leaves_other_versions_and_recovery_records(self):
        selected = self.install()
        duplicate = self.install("v1-2")
        self.write_json(self.core.bindings_path, {"12": {"installation_id": selected["id"], "active": False, "launch_options_restored": True}})
        before = self.core.bindings_path.read_bytes()
        self.assertTrue(self.core.delete_installation(selected["id"], selected["folder"]))
        self.assertFalse(Path(selected["folder"]).exists())
        self.assertTrue(Path(duplicate["executable"]).is_file())
        self.assertEqual(self.core.bindings_path.read_bytes(), before)

    def test_live_process_check_protects_unbound_installation_and_retries_after_exit(self):
        selected = self.install()
        self.write_json(self.core.bindings_path, {"12": {"installation_id": selected["id"], "active": False, "launch_options_restored": True}})
        with patch.object(self.core, "_assert_installation_not_running", side_effect=TrainerDeckError("仍在运行")):
            with self.assertRaisesRegex(TrainerDeckError, "仍在运行"):
                self.core.delete_installation(selected["id"], selected["folder"])
        self.assertTrue(Path(selected["folder"]).is_dir())
        with patch.object(self.core, "_assert_installation_not_running", return_value=None):
            self.assertTrue(self.core.delete_installation(selected["id"], selected["folder"]))

    def test_active_binding_duplicate_id_and_unrestored_launch_options_block_delete(self):
        selected = self.install()
        duplicate = self.install("v1-2")
        for binding in [
            {"installation_id": selected["id"], "active": True, "installation_folder": duplicate["folder"]},
            {"installation_id": selected["id"], "active": False, "launch_options_restored": False},
            {"installation_id": "another", "active": True, "managed_launch_executable": selected["executable"]},
        ]:
            with self.subTest(binding=binding):
                self.write_json(self.core.bindings_path, {"12": binding})
                with self.assertRaises(TrainerDeckError):
                    self.core.delete_installation(selected["id"], selected["folder"])
                self.assertTrue(Path(selected["executable"]).is_file())

    def test_binding_duplicate_download_keeps_the_exact_selected_folder(self):
        selected = self.install()
        duplicate = self.install("v1-2")
        self.assertEqual(self.core.get_installation(selected["id"], selected["folder"])["folder"], selected["folder"])
        binding = self.core.bind_trainer(12, selected["id"], installation_folder=duplicate["folder"])
        self.assertEqual(binding["folder"], duplicate["folder"])
        self.assertEqual(self.core.get_binding(12)["folder"], duplicate["folder"])
        self.assertEqual(self.core.list_binding_records()[0]["installation_folder"], duplicate["folder"])
        import shutil
        shutil.rmtree(duplicate["folder"])
        self.assertIsNone(self.core.get_binding(12))
        self.assertTrue(Path(selected["folder"]).is_dir())
        self.assertEqual(self.core.list_binding_records()[0]["installation_folder"], duplicate["folder"])

    def test_parent_outside_wrong_id_and_spoofed_metadata_are_rejected(self):
        selected = self.install()
        for folder, identifier in [
            (self.trainer_root, selected["id"]),
            (self.trainer_root / "Game", selected["id"]),
            (self.home, selected["id"]),
            (Path(selected["folder"]), "b" * 24),
            (Path(selected["folder"]) / ".." / "v1", selected["id"]),
        ]:
            with self.subTest(folder=folder), self.assertRaises(TrainerDeckError):
                self.core.delete_installation(identifier, str(folder))
        metadata_path = Path(selected["folder"]) / METADATA_FILENAME
        self.write_json(metadata_path, {"id": selected["id"]})
        with self.assertRaises(TrainerDeckError):
            self.core.delete_installation(selected["id"], selected["folder"])
        self.assertTrue(Path(selected["executable"]).exists())

    def test_external_executable_and_corrupt_binding_file_are_rejected(self):
        selected = self.install()
        metadata_path = Path(selected["folder"]) / METADATA_FILENAME
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["executable_relative"] = "../../outside.exe"
        outside = self.trainer_root / "outside.exe"
        outside.write_bytes(b"MZoutside")
        self.write_json(metadata_path, metadata)
        with self.assertRaises(TrainerDeckError):
            self.core.delete_installation(selected["id"], selected["folder"])
        self.assertTrue(outside.exists())
        metadata["executable_relative"] = "Trainer.exe"
        self.write_json(metadata_path, metadata)
        self.core.bindings_path.write_text("corrupt", encoding="utf-8")
        with self.assertRaises(TrainerDeckError):
            self.core.delete_installation(selected["id"], selected["folder"])
        self.assertTrue(Path(selected["folder"]).exists())

    def test_hardlinked_external_file_prevents_cleanup(self):
        selected = self.install()
        outside = self.home / "keep.txt"
        outside.write_text("keep", encoding="utf-8")
        os.link(outside, Path(selected["folder"]) / "linked.txt")
        with self.assertRaises(TrainerDeckError):
            self.core.delete_installation(selected["id"], selected["folder"])
        self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_symlinked_nested_directory_prevents_cleanup(self):
        selected = self.install()
        outside = self.home / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep", encoding="utf-8")
        try:
            (Path(selected["folder"]) / "linked").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Creating symbolic links is unavailable on this host")
        with self.assertRaises(TrainerDeckError):
            self.core.delete_installation(selected["id"], selected["folder"])
        self.assertTrue((outside / "keep.txt").exists())


class InstallationProcessInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.folder = self.root / "Game" / "v1"
        self.folder.mkdir(parents=True)
        self.executable = self.folder / "Game Trainer.exe"
        self.executable.write_bytes(b"MZsample-trainer")
        self.proc = self.root / "proc"
        self.proc.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def process(self, command, environment="", comm="wine64", pid=123):
        process = self.proc / str(pid)
        process.mkdir(exist_ok=True)
        (process / "cmdline").write_bytes(command.encode("utf-8"))
        (process / "environ").write_bytes(environment.encode("utf-8"))
        (process / "comm").write_bytes(comm.encode("utf-8"))
        return process

    def inspect(self):
        TrainerDeckCore._assert_installation_not_running(self.folder, self.executable, self.proc)

    def test_native_and_wine_executable_paths_are_protected(self):
        paths = [str(self.executable), "Z:" + str(self.executable).replace("/", "\\")]
        for path in paths:
            with self.subTest(path=path):
                self.process(f'wine64\0"{path}"\0')
                with self.assertRaisesRegex(TrainerDeckError, "仍在运行"):
                    self.inspect()

    def test_external_cache_generation_is_protected_without_cwd_or_environment(self):
        digest = hashlib.sha256(self.executable.read_bytes()).hexdigest()[:16]
        cached = f"C:\\users\\steamuser\\AppData\\Local\\TrainerDeck\\BridgeCache\\{digest}-a123-s{'a' * 16}\\{self.executable.name}"
        self.process(cached + "\0", comm="Game Trainer.ex")
        with self.assertRaisesRegex(TrainerDeckError, "仍在运行"):
            self.inspect()

    def test_manifest_and_proton_command_environment_are_protected(self):
        for name, value in [
            ("TRAINERDECK_BRIDGE_MANIFEST", str(self.folder / "trainerdeck-bridge.json")),
            ("PROTON_REMOTE_DEBUG_CMD", f"'{self.folder / 'TrainerDeckBridgeLauncher.exe'}'"),
        ]:
            with self.subTest(name=name):
                self.process("wine64\0C:\\cache\\other.exe\0", f"{name}={value}\0")
                with self.assertRaisesRegex(TrainerDeckError, "仍在运行"):
                    self.inspect()

    def test_original_working_directory_is_protected(self):
        process = self.process("wine64\0C:\\cache\\other.exe\0")
        original = os.readlink

        def readlink(path, *arguments, **keywords):
            if Path(path) == process / "cwd":
                return str(self.folder)
            return original(path, *arguments, **keywords)

        with patch("trainerdeck_core.os.readlink", side_effect=readlink):
            with self.assertRaisesRegex(TrainerDeckError, "仍在运行"):
                self.inspect()

    def test_sibling_versions_and_unrelated_environment_do_not_block(self):
        for sibling in ("v1-2", "v10", "v1 extra", "v1)"):
            with self.subTest(sibling=sibling):
                other = self.folder.with_name(sibling) / "Other Trainer.exe"
                self.process(f"wine64\0{other}\0", f"UNRELATED_DOCUMENT={self.folder}\0")
                self.inspect()

    def test_unreadable_unrelated_process_does_not_block(self):
        process = self.process("steamwebhelper\0", comm="steamwebhelper")
        original = Path.open

        def open_file(path, *arguments, **keywords):
            if path in (process / "cmdline", process / "environ"):
                raise PermissionError("another user")
            return original(path, *arguments, **keywords)

        with patch.object(Path, "open", open_file):
            self.inspect()

    def test_unreadable_matching_trainer_is_reported_but_exit_removes_block(self):
        process = self.process(f"wine64\0{self.executable.name}\0", comm=self.executable.name[:15])
        original = Path.open

        def open_file(path, *arguments, **keywords):
            if path == process / "environ":
                raise PermissionError("process cannot be inspected")
            return original(path, *arguments, **keywords)

        with patch.object(Path, "open", open_file):
            with self.assertRaisesRegex(TrainerDeckError, "无法确认修改器"):
                self.inspect()
        shutil.rmtree(process)
        self.inspect()

    def test_uninspectable_wine_is_not_assumed_unrelated(self):
        process = self.process("wine64\0", comm="wine64")
        original = Path.open

        def open_file(path, *arguments, **keywords):
            if path in (process / "cmdline", process / "environ"):
                raise PermissionError("Wine process cannot be inspected")
            return original(path, *arguments, **keywords)

        with patch.object(Path, "open", open_file):
            with self.assertRaisesRegex(TrainerDeckError, "Wine 进程"):
                self.inspect()

    def test_known_different_wine_executable_with_unreadable_environment_does_not_block(self):
        process = self.process("wine64\0C:\\Games\\OtherGame.exe\0", comm="OtherGame.exe")
        original = Path.open

        def open_file(path, *arguments, **keywords):
            if path == process / "environ":
                raise PermissionError("Other game's environment cannot be inspected")
            return original(path, *arguments, **keywords)

        with patch.object(Path, "open", open_file):
            self.inspect()

    def test_chinese_process_name_uses_linux_byte_limit(self):
        self.executable = self.folder / "中文游戏修改器.exe"
        self.executable.write_bytes(b"MZother-trainer")
        process = self.process("", comm="unused")
        (process / "comm").write_bytes(self.executable.name.encode("utf-8")[:15])
        original = Path.open

        def open_file(path, *arguments, **keywords):
            if path == process / "environ":
                raise PermissionError("Trainer cannot be inspected")
            return original(path, *arguments, **keywords)

        with patch.object(Path, "open", open_file):
            with self.assertRaisesRegex(TrainerDeckError, "无法确认修改器"):
                self.inspect()

    def test_process_exiting_during_enumeration_does_not_block(self):
        (self.proc / "123").mkdir()
        self.inspect()

    def test_missing_process_surface_is_reported(self):
        self.proc.rmdir()
        with self.assertRaisesRegex(TrainerDeckError, "无法检查运行中的修改器"):
            self.inspect()


class LibraryRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        assets = self.root / "assets"
        assets.mkdir()
        for name in BRIDGE_ASSET_FILENAMES:
            (assets / name).write_bytes(b"test")
        self.manager = TrainerRuntimeManager(self.root / "runtime", assets)
        await self.manager.start(None)
        self.folder = self.root / "trainer"
        self.folder.mkdir()
        executable = self.folder / "Trainer.exe"
        executable.write_bytes(b"MZtrainer")
        self.installation = {"id": "a" * 24, "folder": str(self.folder), "executable": str(executable), "sha256": "b" * 64}

    async def asyncTearDown(self):
        await self.manager.stop()
        self.temporary.cleanup()

    async def test_prepared_then_unbound_trainer_can_be_deleted_without_reload(self):
        self.manager.prepare_bridge(12, self.installation)
        await self.manager.revoke_app(12)
        called = []
        self.manager.delete_unused_installation(str(self.folder), lambda: called.append(True))
        self.assertEqual(called, [True])

    async def test_connected_trainer_is_still_protected(self):
        self.manager.prepare_bridge(12, self.installation)
        called = []
        with patch.dict(self.manager._sessions, {12: {"connected": True}}):
            with self.assertRaisesRegex(TrainerRuntimeError, "仍在运行"):
                self.manager.delete_unused_installation(str(self.folder), lambda: called.append(True))
        self.assertEqual(called, [])

    async def test_prepare_and_delete_are_serialized_without_permanent_prepare_lockout(self):
        entered = threading.Event()
        release = threading.Event()
        removed = []
        deploy = self.manager._deploy_bridge_files

        def paused_deploy(*arguments):
            entered.set()
            if not release.wait(5):
                raise AssertionError("Test timed out waiting for deletion")
            return deploy(*arguments)

        with patch.object(self.manager, "_deploy_bridge_files", side_effect=paused_deploy):
            prepared = asyncio.create_task(asyncio.to_thread(self.manager.prepare_bridge, 12, self.installation))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            deleted = asyncio.create_task(asyncio.to_thread(self.manager.delete_unused_installation, str(self.folder), lambda: removed.append(True)))
            await asyncio.sleep(0)
            self.assertFalse(deleted.done())
            release.set()
            await prepared
            await deleted
        self.assertEqual(removed, [True])

    async def test_successful_delete_revokes_unused_preparation(self):
        self.manager.prepare_bridge(12, self.installation)
        self.assertTrue(self.manager.delete_unused_installation(str(self.folder), lambda: True))
        self.assertNotIn(12, self.manager._tokens)
        self.assertNotIn(12, self.manager._prepared)
        self.assertNotIn(12, self.manager._owned_installations)

    async def test_unused_folder_executes_delete_under_prepare_lock(self):
        observed = []
        def remove():
            observed.append(self.manager._prepare_lock.locked())
            return True
        self.assertTrue(self.manager.delete_unused_installation(str(self.folder), remove))
        self.assertEqual(observed, [True])


if __name__ == "__main__":
    unittest.main()
