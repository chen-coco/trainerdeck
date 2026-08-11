import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from scripts import package


class DeckyPackageTests(unittest.TestCase):
    def test_release_version_is_consistent(self):
        main_source = (package.ROOT / "main.py").read_text(encoding="utf-8")
        readme = (package.ROOT / "README.md").read_text(encoding="utf-8")
        english_readme = (package.ROOT / "README_EN.md").read_text(
            encoding="utf-8"
        )
        core_source = (package.ROOT / "trainerdeck_core.py").read_text(
            encoding="utf-8"
        )

        self.assertIn(f'"version": "{package.VERSION}"', main_source)
        self.assertIn(f"TrainerDeck-{package.VERSION}.zip", readme)
        self.assertIn(
            f"TrainerDeck-{package.VERSION}.zip",
            english_readme,
        )
        self.assertIn(
            f'PLUGIN_VERSION = "{package.VERSION}"',
            core_source,
        )

    def test_readme_language_switch_is_bidirectional(self):
        readme = (package.ROOT / "README.md").read_text(encoding="utf-8")
        english_readme = (package.ROOT / "README_EN.md").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "**简体中文** | [English](README_EN.md)",
            readme,
        )
        self.assertIn(
            "[简体中文](README.md) | **English**",
            english_readme,
        )

    def test_archive_uses_decky_layout_and_python_module_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "TrainerDeck-test.zip"
            with mock.patch.object(package, "OUTPUT", output):
                package.main()

            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                manifests = [
                    name
                    for name in names
                    if name.endswith("/plugin.json")
                    and name.count("/") == 1
                ]
                self.assertEqual(manifests, ["TrainerDeck/plugin.json"])
                self.assertIn(
                    "TrainerDeck/py_modules/trainerdeck_core.py",
                    names,
                )
                self.assertIn(
                    "TrainerDeck/py_modules/trainerdeck_runtime.py",
                    names,
                )
                self.assertIn("TrainerDeck/README_EN.md", names)
                self.assertIn(
                    "TrainerDeck/bin/bridge/TrainerDeckBridge.dll",
                    names,
                )
                self.assertNotIn(
                    "TrainerDeck/bin/bridge/TrainerDeckBridge.Legacy.dll",
                    names,
                )
                self.assertNotIn(
                    "TrainerDeck/bin/bridge/TrainerDeckBridgeLauncher.exe.config",
                    names,
                )
                self.assertNotIn("TrainerDeck/trainerdeck_core.py", names)
                self.assertNotIn("TrainerDeck/trainerdeck_runtime.py", names)
                packaged = json.loads(
                    archive.read("TrainerDeck/package.json").decode("utf-8")
                )
                self.assertEqual(packaged["version"], package.VERSION)
                expected = {
                    (package.PREFIX / destination).as_posix()
                    for _, destination in package._archive_entries()
                }
                self.assertEqual(set(names), expected)


if __name__ == "__main__":
    unittest.main()
