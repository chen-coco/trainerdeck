import json
import shutil
import ssl
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

from trainerdeck_core import (
    METADATA_FILENAME,
    TrainerDeckCore,
    TrainerDeckError,
)


class CoreTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.core = TrainerDeckCore(
            settings_dir=self.root / "settings",
            runtime_dir=self.root / "runtime",
            user_home=self.home,
            user_name="deck",
        )

    def tearDown(self):
        self.temporary.cleanup()


class ProviderTests(CoreTestCase):
    def test_official_search_decodes_entities_in_nested_anchor_content(self):
        html = """
        <main>
          <a href="/trainer/like-a-dragon-infinite-wealth-trainer-123/?build=1&amp;lang=en">
            <span>Like a Dragon&#58;</span>
            <strong>&#x49;nfinite Wealth &amp; Friends</strong> Trainer
          </a>
        </main>
        """
        with patch.object(self.core, "_fetch_text", return_value=html):
            results = self.core._search_official(
                "Like a Dragon Infinite Wealth Friends"
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(
            results[0]["title"],
            "Like a Dragon: Infinite Wealth & Friends Trainer",
        )
        self.assertEqual(
            results[0]["page_url"],
            "https://flingtrainer.com/trainer/like-a-dragon-infinite-wealth-"
            "trainer-123/?build=1&lang=en",
        )

    def test_official_search_filters_sidebar_links(self):
        html = """
        <main>
          <a href="/trainer/example-game-trainer-123/">Example Game Trainer</a>
          <a href="https://[broken">Malformed link</a>
        </main>
        <aside>
          <a href="/trainer/unrelated-game-trainer-456/">Unrelated Game Trainer</a>
        </aside>
        """
        with patch.object(self.core, "_fetch_text", return_value=html):
            results = self.core._search_official("Example Game")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["game_name"], "Example Game")
        self.assertEqual(results[0]["provider"], "fling-official")

    def test_official_page_extracts_download_without_hotkey_controls(self):
        html = """
        <h1>Example Game Trainer</h1>
        <p>12 Options · Game Version: v1.0-v1.2+ · Last Updated: 2026.01.01</p>
        <h6>Options</h6>
        <p>
          Num 1 – Infinite Health<br>
          Ctrl+Num 2 – Edit Money
          <script>toolTips("this must not enter the label");</script><br>
          Shift+F3 – Set Game Speed
        </p>
        <h3>Download</h3>
        <a href="https://[broken">Malformed link</a>
        <a href="/downloads/opaque-token">Example.Game.v1.2.Trainer-FLiNG</a>
        """
        entry = {
            "id": "example",
            "provider": "fling-official",
            "game_name": "Example Game",
            "title": "Example Game Trainer",
            "version": "",
            "page_url": "https://flingtrainer.com/trainer/example/",
            "download_url": "",
        }
        with patch.object(self.core, "_fetch_text", return_value=html):
            details = self.core._page_details(entry)
        self.assertEqual(
            details["download_url"],
            "https://flingtrainer.com/downloads/opaque-token",
        )
        self.assertEqual(details["version"], "v1.0-v1.2+")
        self.assertNotIn("controls", details)

    def test_official_page_ignores_scripts_and_decodes_entities(self):
        html = """
        <script>
          document.write("Game Version: poisoned | Last Updated: never");
        </script>
        <p>
          20 Options&nbsp;<span>Game Version:</span>
          v2.0&ndash;v2.1+ &middot; Last Updated: 2026.02.02
        </p>
        <a href="/downloads/opaque-token?mirror=one&amp;format=zip">
          <span>Example</span><script>poisoned title</script>
          <strong>Trainer &amp; Tool</strong>
        </a>
        """
        entry = {
            "id": "example",
            "provider": "fling-official",
            "game_name": "Example Game",
            "title": "Example Game Trainer",
            "version": "",
            "page_url": "https://flingtrainer.com/trainer/example/",
            "download_url": "",
        }
        with patch.object(self.core, "_fetch_text", return_value=html):
            details = self.core._page_details(entry)

        self.assertEqual(details["version"], "v2.0–v2.1+")
        self.assertEqual(
            details["download_url"],
            "https://flingtrainer.com/downloads/opaque-token?mirror=one&format=zip",
        )
        self.assertEqual(details["download_name"], "Example Trainer & Tool")


class NetworkSecurityTests(CoreTestCase):
    def test_trusted_context_keeps_hostname_and_certificate_verification(self):
        import trainerdeck_core

        previous = trainerdeck_core._SSL_CONTEXT
        trainerdeck_core._SSL_CONTEXT = None
        try:
            context = trainerdeck_core._trusted_ssl_context()
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        finally:
            trainerdeck_core._SSL_CONTEXT = previous

    def test_page_request_passes_verified_context_to_urlopen(self):
        sentinel = object()
        with (
            patch("trainerdeck_core._trusted_ssl_context", return_value=sentinel),
            patch(
                "trainerdeck_core.urllib.request.urlopen",
                side_effect=urllib.error.URLError("stop"),
            ) as urlopen,
        ):
            with self.assertRaises(TrainerDeckError):
                self.core._fetch_text("https://flingtrainer.com/trainer/example/")
        self.assertIs(urlopen.call_args.kwargs["context"], sentinel)

    def test_binary_download_passes_verified_context_to_urlopen(self):
        sentinel = object()
        destination = self.root / "trainer-download"
        with (
            patch("trainerdeck_core._trusted_ssl_context", return_value=sentinel),
            patch(
                "trainerdeck_core.urllib.request.urlopen",
                side_effect=urllib.error.URLError("stop"),
            ) as urlopen,
        ):
            with self.assertRaises(TrainerDeckError):
                self.core._download_to_file(
                    "https://flingtrainer.com/downloads/example",
                    destination,
                    max_bytes=1024,
                    official_only=True,
                )
        self.assertIs(urlopen.call_args.kwargs["context"], sentinel)
        self.assertFalse(destination.exists())

class ArchiveTests(CoreTestCase):
    def test_default_trainer_root_is_downloads_trainer(self):
        settings = self.core.get_settings()
        self.assertEqual(
            settings["trainer_root"],
            str((self.home / "Downloads" / "trainer").resolve()),
        )
        self.assertTrue((self.home / "Downloads" / "trainer").is_dir())
        self.assertFalse(settings["restore_input_on_qam_close"])

    def test_zip_path_traversal_is_rejected(self):
        archive = self.root / "bad.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("../outside.exe", b"MZ")
        destination = self.root / "extract"
        destination.mkdir()
        with self.assertRaises(TrainerDeckError):
            self.core._safe_extract_zip(archive, destination)
        self.assertFalse((self.root / "outside.exe").exists())

    def test_direct_executable_preserves_safe_server_filename(self):
        payload = self.root / "direct-payload"
        payload.write_bytes(b"MZ" + b"\0" * 64)

        def copy_download(_url, destination, max_bytes, official_only):
            self.assertGreater(max_bytes, payload.stat().st_size)
            self.assertFalse(official_only)
            shutil.copy2(payload, destination)
            return (
                "Sifu.v1.29.Plus.16.Trainer-FLiNG.exe",
                "application/octet-stream",
                "b" * 64,
            )

        entry = {
            "id": "sifu",
            "provider": "external",
            "game_name": "Sifu",
            "title": "Sifu Trainer",
            "version": "v1.29",
            "download_url": "https://downloads.example.test/opaque-token",
        }
        with patch.object(self.core, "_download_to_file", side_effect=copy_download):
            installed = self.core.download_trainer(entry)

        executable = Path(installed["executable"])
        self.assertEqual(executable.name, "Sifu.v1.29.Plus.16.Trainer-FLiNG.exe")
        self.assertTrue(executable.is_file())
        self.assertEqual(
            installed["download_name"],
            "Sifu.v1.29.Plus.16.Trainer-FLiNG.exe",
        )

    def test_direct_executable_filename_cannot_escape_install_folder(self):
        payload = self.root / "direct-payload"
        payload.write_bytes(b"MZ" + b"\0" * 64)

        def copy_download(_url, destination, max_bytes, official_only):
            self.assertGreater(max_bytes, payload.stat().st_size)
            self.assertFalse(official_only)
            shutil.copy2(payload, destination)
            return "../../CON.exe", "application/octet-stream", "c" * 64

        entry = {
            "id": "safe-name",
            "provider": "external",
            "game_name": "Safe Name",
            "title": "Safe Name Trainer",
            "version": "v1",
            "download_url": "https://downloads.example.test/opaque-token",
        }
        with patch.object(self.core, "_download_to_file", side_effect=copy_download):
            installed = self.core.download_trainer(entry)

        executable = Path(installed["executable"])
        self.assertEqual(executable.name, "_CON.exe")
        self.assertEqual(executable.parent, Path(installed["folder"]))
        self.assertFalse((self.root / "CON.exe").exists())

    def test_direct_executable_uses_download_title_when_header_is_opaque(self):
        payload = self.root / "direct-payload"
        payload.write_bytes(b"MZ" + b"\0" * 64)

        def copy_download(_url, destination, max_bytes, official_only):
            self.assertGreater(max_bytes, payload.stat().st_size)
            self.assertFalse(official_only)
            shutil.copy2(payload, destination)
            return "", "application/octet-stream", "d" * 64

        entry = {
            "id": "like-a-dragon",
            "provider": "external",
            "game_name": "Like a Dragon Infinite Wealth",
            "title": "Like a Dragon Infinite Wealth Trainer",
            "download_name": "Like.a.Dragon.Infinite.Wealth.Trainer-FLiNG",
            "version": "v1",
            "download_url": "https://downloads.example.test/opaque-token",
        }
        with patch.object(self.core, "_download_to_file", side_effect=copy_download):
            installed = self.core.download_trainer(entry)

        self.assertEqual(
            Path(installed["executable"]).name,
            "Like.a.Dragon.Infinite.Wealth.Trainer-FLiNG.exe",
        )

    def test_download_install_list_and_bind_flow(self):
        archive = self.root / "trainer.zip"
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("Example Trainer.exe", b"MZ" + b"\0" * 64)
            zipped.writestr("readme.txt", b"example")

        def copy_download(_url, destination, max_bytes, official_only):
            self.assertGreater(max_bytes, archive.stat().st_size)
            self.assertFalse(official_only)
            shutil.copy2(archive, destination)
            return "Example.Trainer.zip", "application/zip", "a" * 64

        entry = {
            "id": "example",
            "provider": "external",
            "game_name": "Example Game",
            "title": "Example Game Trainer",
            "version": "v1.2",
            "page_url": "",
            "download_url": "https://downloads.example.test/trainer.zip",
        }
        with patch.object(self.core, "_download_to_file", side_effect=copy_download):
            installed = self.core.download_trainer(entry)

        self.assertTrue(Path(installed["executable"]).is_file())
        self.assertEqual(Path(installed["executable"]).name, "Example Trainer.exe")
        self.assertTrue((Path(installed["folder"]) / METADATA_FILENAME).is_file())
        self.assertEqual(len(self.core.list_installed()), 1)

        original_launch_options = "MANGOHUD=1 %command% --launcher-skip"
        applied_launch_options = (
            "PROTON_REMOTE_DEBUG_CMD=\"'/trainer.exe'\" "
            f"{original_launch_options}"
        )
        bound = self.core.bind_trainer(
            1234,
            installed["id"],
            installed["executable"],
            original_launch_options,
            applied_launch_options,
            "Example Game",
            "shortcut",
            '"/games/Example/Game.exe"',
            "shortcut",
        )
        self.assertEqual(bound["id"], installed["id"])
        self.assertEqual(
            bound["original_launch_options"], original_launch_options
        )
        self.assertEqual(bound["applied_launch_options"], applied_launch_options)
        self.assertEqual(bound["target_type"], "shortcut")
        self.assertEqual(bound["launch_options_field"], "shortcut")
        self.assertEqual(bound["shortcut_exe"], '"/games/Example/Game.exe"')
        self.assertIn(
            installed["executable"], bound["candidate_launch_executables"]
        )
        self.assertEqual(self.core.get_binding(1234)["id"], installed["id"])
        stored_binding = json.loads(
            self.core.bindings_path.read_text(encoding="utf-8")
        )["1234"]
        self.assertEqual(stored_binding["installation_id"], installed["id"])
        self.assertEqual(
            stored_binding["managed_launch_executable"],
            installed["executable"],
        )
        self.assertNotIn("executable", stored_binding)
        self.assertEqual(stored_binding["target_type"], "shortcut")
        self.assertEqual(stored_binding["launch_options_field"], "shortcut")
        self.assertEqual(
            self.core.list_bindings()[1234]["id"],
            installed["id"],
        )
        with self.assertRaisesRegex(
            TrainerDeckError,
            "AppID 1234",
        ):
            self.core.bind_trainer(
                5678,
                installed["id"],
                installed["executable"],
                "%command%",
                "PROTON_REMOTE_DEBUG_CMD=\"'/trainer.exe'\" %command%",
                "Another Game",
            )
        self.assertIsNone(self.core.get_binding(5678))
        updated_original = f"{original_launch_options} --user-added"
        updated_applied = (
            "PROTON_REMOTE_DEBUG_CMD=\"'/trainer.exe'\" "
            f"{updated_original}"
        )
        rebound = self.core.bind_trainer(
            1234,
            installed["id"],
            installed["executable"],
            updated_original,
            updated_applied,
            "Example Game",
        )
        self.assertEqual(rebound["original_launch_options"], updated_original)
        self.assertEqual(rebound["applied_launch_options"], updated_applied)
        self.assertEqual(rebound["target_type"], "shortcut")
        self.assertEqual(rebound["launch_options_field"], "shortcut")
        self.assertEqual(rebound["shortcut_exe"], '"/games/Example/Game.exe"')
        recovery_record = self.core.list_binding_records()[0]
        self.assertTrue(recovery_record["active"])
        self.assertFalse(recovery_record["launch_options_restored"])
        self.assertEqual(
            recovery_record["original_launch_options"], updated_original
        )
        self.assertEqual(recovery_record["launch_options_field"], "shortcut")
        self.assertTrue(self.core.unbind_trainer(1234, True))
        self.assertIsNone(self.core.get_binding(1234))
        recovery_record = self.core.list_binding_records()[0]
        self.assertFalse(recovery_record["active"])
        self.assertTrue(recovery_record["launch_options_restored"])

        released_binding = self.core.bind_trainer(
            5678,
            installed["id"],
            installed["executable"],
            "%command%",
            "PROTON_REMOTE_DEBUG_CMD=\"'/trainer.exe'\" %command%",
            "Another Game",
        )
        self.assertEqual(released_binding["app_id"], 5678)
        self.assertTrue(self.core.unbind_trainer(5678, True))

        bridge_launcher = (
            Path(installed["folder"]) / "TrainerDeckBridgeLauncher.exe"
        )
        bridge_launcher.write_bytes(b"MZ" + b"\0" * 64)
        bridge_binding = self.core.bind_trainer(
            1234,
            installed["id"],
            str(bridge_launcher),
            "%command% --new-baseline",
            "PROTON_REMOTE_DEBUG_CMD=\"'/bridge.exe'\" %command% --new-baseline",
            "Example Game",
        )
        self.assertEqual(
            bridge_binding["candidate_launch_executables"],
            [str(bridge_launcher.resolve())],
        )
        self.assertTrue(self.core.unbind_trainer(1234, True))

        self.core.bindings_path.write_text(
            json.dumps(
                {
                    "1234": {
                        "installation_id": installed["id"],
                        "display_name": "Example Game",
                    }
                }
            ),
            encoding="utf-8",
        )
        legacy_candidates = set(
            self.core.list_binding_records()[0][
                "candidate_launch_executables"
            ]
        )
        self.assertEqual(
            legacy_candidates,
            {installed["executable"], str(bridge_launcher.resolve())},
        )
        migrated_binding = self.core.bind_trainer(
            1234,
            installed["id"],
            str(bridge_launcher),
            "%command% --migrated-baseline",
            "PROTON_REMOTE_DEBUG_CMD=\"'/bridge.exe'\" %command% --migrated-baseline",
            "Example Game",
        )
        self.assertEqual(
            migrated_binding["candidate_launch_executables"],
            [str(bridge_launcher.resolve())],
        )
        self.assertTrue(self.core.unbind_trainer(1234, True))

        shutil.rmtree(installed["folder"])
        missing_files_record = self.core.list_binding_records()[0]
        self.assertEqual(missing_files_record["app_id"], 1234)
        self.assertEqual(missing_files_record["display_name"], "Example Game")
        self.assertIn(
            str(bridge_launcher.resolve()),
            missing_files_record["candidate_launch_executables"],
        )

    def test_legacy_binding_remains_recoverable_without_installation(self):
        self.core.bindings_path.write_text(
            json.dumps(
                {
                    "1091500": {
                        "installation_id": "missing-installation",
                        "managed_launch_executable": (
                            "/home/deck/Downloads/trainer/Cyberpunk 2077/"
                            "TrainerDeckBridgeLauncher.exe"
                        ),
                        "original_launch_options": None,
                    }
                }
            ),
            encoding="utf-8",
        )

        records = self.core.list_binding_records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["app_id"], 1091500)
        self.assertIsNone(records[0]["original_launch_options"])
        self.assertIsNone(records[0]["target_type"])
        self.assertIsNone(records[0]["launch_options_field"])
        self.assertTrue(records[0]["active"])

    def test_binding_launch_options_field_is_validated(self):
        with self.assertRaisesRegex(TrainerDeckError, "启动项字段无效"):
            self.core.bind_trainer(
                1234,
                "missing-installation",
                launch_options_field="unknown",
            )
        with self.assertRaisesRegex(TrainerDeckError, "只能使用普通启动项字段"):
            self.core.bind_trainer(
                1234,
                "missing-installation",
                target_type="steam",
                launch_options_field="shortcut",
            )

    def test_binding_rejects_different_ids_for_same_physical_folder(self):
        folder = self.home / "Downloads" / "trainer" / "shared"
        folder.mkdir(parents=True)
        executable = folder / "Shared Trainer.exe"
        executable.write_bytes(b"MZ" + b"\0" * 64)
        installations = {
            installation_id: {
                "id": installation_id,
                "title": f"Trainer {installation_id}",
                "folder": str(folder),
                "executable": str(executable),
                "sha256": "a" * 64,
            }
            for installation_id in ("logical-a", "logical-b")
        }

        def get_installation(installation_id):
            try:
                return installations[str(installation_id)]
            except KeyError as error:
                raise TrainerDeckError("找不到已安装修改器") from error

        with patch.object(
            self.core,
            "get_installation",
            side_effect=get_installation,
        ):
            self.core.bind_trainer(1234, "logical-a", str(executable))
            stored = json.loads(
                self.core.bindings_path.read_text(encoding="utf-8")
            )["1234"]
            self.assertEqual(
                Path(stored["installation_folder"]),
                folder.resolve(),
            )
            with self.assertRaisesRegex(TrainerDeckError, "AppID 1234"):
                self.core.bind_trainer(5678, "logical-b", str(executable))
            self.assertIsNone(self.core.get_binding(5678))

            self.assertTrue(self.core.unbind_trainer(1234, True))
            rebound = self.core.bind_trainer(
                5678,
                "logical-b",
                str(executable),
            )
            self.assertEqual(rebound["app_id"], 5678)

    def test_trainer_root_is_scoped(self):
        outside = self.root.parent / "not-allowed"
        settings = self.core.get_settings()
        settings["trainer_root"] = str(outside)
        with self.assertRaises(TrainerDeckError):
            self.core.save_settings(settings)


class JsonMetadataTests(CoreTestCase):
    def test_automatic_search_and_add_defaults_disabled(self):
        settings = self.core.get_settings()
        self.assertFalse(settings["auto_search_and_add"])
        self.assertNotIn("auto_search", settings)

    def test_automatic_search_and_add_round_trips_and_requires_bool(self):
        settings = self.core.get_settings()
        settings["auto_search_and_add"] = True
        self.assertTrue(
            self.core.save_settings(settings)["auto_search_and_add"]
        )
        settings["auto_search_and_add"] = False
        self.assertFalse(
            self.core.save_settings(settings)["auto_search_and_add"]
        )
        settings["auto_search_and_add"] = "true"
        with self.assertRaisesRegex(
            TrainerDeckError,
            "auto_search_and_add 必须是布尔值",
        ):
            self.core.save_settings(settings)

    def test_input_recovery_setting_round_trips_and_requires_bool(self):
        settings = self.core.get_settings()
        settings["restore_input_on_qam_close"] = True
        self.assertTrue(
            self.core.save_settings(settings)["restore_input_on_qam_close"]
        )
        settings["restore_input_on_qam_close"] = False
        self.assertFalse(
            self.core.save_settings(settings)["restore_input_on_qam_close"]
        )
        settings["restore_input_on_qam_close"] = "true"
        with self.assertRaisesRegex(
            TrainerDeckError,
            "restore_input_on_qam_close 必须是布尔值",
        ):
            self.core.save_settings(settings)

    def test_missing_input_recovery_setting_uses_disabled_default(self):
        self.core.settings_path.write_text(
            json.dumps(
                {
                    "schema_version": 3,
                    "trainer_root": str(self.home / "custom"),
                    "auto_search": True,
                }
            ),
            encoding="utf-8",
        )
        self.assertFalse(
            self.core.get_settings()["restore_input_on_qam_close"]
        )

    def test_legacy_default_path_is_migrated(self):
        legacy = {
            **self.core._defaults(),
            "schema_version": 1,
            "trainer_root": str(self.home / "Documents" / "TrainerDeck"),
        }
        settings_path = self.root / "settings" / "settings.json"
        settings_path.write_text(
            json.dumps(legacy),
            encoding="utf-8",
        )
        migrated = self.core.get_settings()
        self.assertEqual(
            migrated["trainer_root"],
            str((self.home / "Downloads" / "trainer").resolve()),
        )
        self.assertEqual(migrated["schema_version"], 3)

    def test_v2_default_path_and_removed_fields_are_migrated(self):
        legacy = {
            "schema_version": 2,
            "trainer_root": str(self.home / "trainer"),
            "auto_search": True,
            "official_enabled": False,
            "catalog_url": "https://example.invalid/catalog.json",
            "max_download_mb": 5,
        }
        self.core.settings_path.write_text(json.dumps(legacy), encoding="utf-8")
        migrated = self.core.get_settings()
        self.assertEqual(
            migrated["trainer_root"],
            str((self.home / "Downloads" / "trainer").resolve()),
        )
        self.assertFalse(migrated["auto_search_and_add"])
        self.assertNotIn("auto_search", migrated)
        self.assertNotIn("official_enabled", migrated)
        self.assertNotIn("catalog_url", migrated)
        self.assertNotIn("max_download_mb", migrated)

    def test_custom_v2_path_is_preserved(self):
        custom = self.home / "my-trainers"
        self.core.settings_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "trainer_root": str(custom),
                    "auto_search": True,
                }
            ),
            encoding="utf-8",
        )
        migrated = self.core.get_settings()
        self.assertEqual(migrated["trainer_root"], str(custom.resolve()))

    def test_v2_default_with_existing_trainers_is_preserved(self):
        old_root = self.home / "trainer"
        installed = old_root / "Example" / "v1"
        installed.mkdir(parents=True)
        (installed / METADATA_FILENAME).write_text("{}", encoding="utf-8")
        self.core.settings_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "trainer_root": str(old_root),
                    "auto_search": True,
                }
            ),
            encoding="utf-8",
        )
        migrated = self.core.get_settings()
        self.assertEqual(migrated["trainer_root"], str(old_root.resolve()))

    def test_metadata_is_utf8(self):
        settings = self.core.get_settings()
        settings["trainer_root"] = str(self.home / "修改器")
        saved = self.core.save_settings(settings)
        loaded = json.loads(
            (self.root / "settings" / "settings.json").read_text(encoding="utf-8")
        )
        self.assertEqual(loaded["trainer_root"], saved["trainer_root"])


if __name__ == "__main__":
    unittest.main()
