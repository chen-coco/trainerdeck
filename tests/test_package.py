import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from scripts import package


class DeckyPackageTests(unittest.TestCase):
    @staticmethod
    def _write_bridge_fixture(
        directory: Path,
        *,
        omitted_build_inputs: tuple[str, ...] = (),
    ) -> dict[str, bytes]:
        directory.mkdir(parents=True)
        payloads = {
            "TrainerDeckBridge.Clr2.dll": b"MZ-clr2-payload\0unique",
            "TrainerDeckBridge.Clr4.dll": b"MZ-clr4-payload\0unique",
        }
        (directory / package.BRIDGE_HOST_FILE).write_bytes(b"MZ-host")
        for filename, payload in payloads.items():
            if filename not in omitted_build_inputs:
                (directory / filename).write_bytes(payload)
        return payloads

    def _validate_bridge_fixture(
        self,
        directory: Path,
        resources: dict[str, bytes | None],
        contracts: dict[str, tuple[str, int]] | None = None,
    ) -> None:
        expected_contracts = (
            contracts
            if contracts is not None
            else {
                "TrainerDeckBridge.Clr2.dll": ("v2.0.50727", 2),
                "TrainerDeckBridge.Clr4.dll": ("v4.0.30319", 4),
            }
        )

        def read_contract(image: bytes, label: str) -> tuple[str, int]:
            filename = Path(label).name
            self.assertEqual(image, (directory / filename).read_bytes())
            return expected_contracts[filename]

        with mock.patch.object(
            package,
            "_read_manifest_resources",
            return_value=resources,
        ), mock.patch.object(
            package,
            "_read_managed_runtime_contract",
            side_effect=read_contract,
        ):
            package._validate_embedded_bridge_payloads(directory)

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
                external_bridge_payloads = [
                    name
                    for name in names
                    if Path(name).name.startswith("TrainerDeckBridge")
                    and name.casefold().endswith(".dll")
                ]
                self.assertEqual(external_bridge_payloads, [])
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

    def test_clr_payloads_are_build_inputs_not_release_files(self):
        self.assertEqual(
            set(package.BRIDGE_BUILD_ONLY_FILES),
            {
                "TrainerDeckBridge.Clr2.dll",
                "TrainerDeckBridge.Clr4.dll",
            },
        )
        self.assertTrue(
            set(package.BRIDGE_BUILD_ONLY_FILES).isdisjoint(
                package.BRIDGE_FILES
            )
        )

    def test_embedded_bridge_payload_validation_accepts_exact_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)

            self._validate_bridge_fixture(
                bridge_directory,
                dict(payloads),
            )

    def test_embedded_bridge_payload_validation_rejects_missing_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)
            resources = {
                "prefix.TrainerDeckBridge.Clr2.dll": payloads[
                    "TrainerDeckBridge.Clr2.dll"
                ],
                "TrainerDeckBridge.Clr2.dll.extra": payloads[
                    "TrainerDeckBridge.Clr2.dll"
                ],
                "TrainerDeckBridge.Clr4.dll": payloads[
                    "TrainerDeckBridge.Clr4.dll"
                ],
            }

            with self.assertRaisesRegex(
                SystemExit,
                "missing resource name TrainerDeckBridge[.]Clr2[.]dll",
            ):
                self._validate_bridge_fixture(bridge_directory, resources)

    def test_embedded_bridge_payload_validation_rejects_missing_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)
            resources = dict(payloads)
            resources["TrainerDeckBridge.Clr4.dll"] = b"wrong-payload"

            with self.assertRaisesRegex(
                SystemExit,
                "payload mismatch TrainerDeckBridge[.]Clr4[.]dll",
            ):
                self._validate_bridge_fixture(bridge_directory, resources)

    def test_embedded_bridge_payload_validation_rejects_swapped_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)
            resources = {
                "TrainerDeckBridge.Clr2.dll": payloads[
                    "TrainerDeckBridge.Clr4.dll"
                ],
                "TrainerDeckBridge.Clr4.dll": payloads[
                    "TrainerDeckBridge.Clr2.dll"
                ],
            }

            with self.assertRaisesRegex(
                SystemExit,
                "payload mismatch TrainerDeckBridge[.]Clr2[.]dll",
            ):
                self._validate_bridge_fixture(bridge_directory, resources)

    def test_embedded_bridge_payload_validation_rejects_two_clr4_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)
            contracts = {
                "TrainerDeckBridge.Clr2.dll": ("v4.0.30319", 4),
                "TrainerDeckBridge.Clr4.dll": ("v4.0.30319", 4),
            }

            with self.assertRaisesRegex(
                SystemExit,
                "runtime family mismatch TrainerDeckBridge[.]Clr2[.]dll",
            ):
                self._validate_bridge_fixture(
                    bridge_directory,
                    dict(payloads),
                    contracts,
                )

    def test_embedded_bridge_payload_validation_rejects_wrong_core_family(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            payloads = self._write_bridge_fixture(bridge_directory)
            contracts = {
                "TrainerDeckBridge.Clr2.dll": ("v2.0.50727", 2),
                "TrainerDeckBridge.Clr4.dll": ("v4.0.30319", 2),
            }

            with self.assertRaisesRegex(
                SystemExit,
                "metadata='v4[.]0[.]30319', mscorlib=2; expected clr4",
            ):
                self._validate_bridge_fixture(
                    bridge_directory,
                    dict(payloads),
                    contracts,
                )

    def test_embedded_bridge_payload_validation_rejects_missing_build_input(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            bridge_directory = Path(temporary) / "bridge"
            self._write_bridge_fixture(
                bridge_directory,
                omitted_build_inputs=("TrainerDeckBridge.Clr2.dll",),
            )

            with self.assertRaisesRegex(
                SystemExit,
                "Missing bridge build inputs: TrainerDeckBridge[.]Clr2[.]dll",
            ):
                package._validate_embedded_bridge_payloads(bridge_directory)

    def test_production_bridge_host_contains_both_exact_payloads(self):
        package._validate_embedded_bridge_payloads()


if __name__ == "__main__":
    unittest.main()
