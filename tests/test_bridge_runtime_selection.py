import unittest
from pathlib import Path
from xml.etree import ElementTree


class BridgeRuntimeSelectionTests(unittest.TestCase):
    def setUp(self):
        self.repository = Path(__file__).resolve().parents[1]
        self.bridge = self.repository / "bridge"
        self.bridge_project = (
            self.bridge / "TrainerDeckBridge" / "TrainerDeckBridge.csproj"
        )
        self.launcher_project = (
            self.bridge
            / "TrainerDeckBridgeLauncher"
            / "TrainerDeckBridgeLauncher.csproj"
        )
        self.preparer = (
            self.bridge
            / "TrainerDeckBridgeLauncher"
            / "TrainerPreparer.cs"
        ).read_text(encoding="utf-8")
        self.patcher = (
            self.bridge
            / "TrainerDeckBridgeLauncher"
            / "UiAssemblyPatcher.cs"
        ).read_text(encoding="utf-8")
        self.runtime = (
            self.bridge / "TrainerDeckBridge" / "BridgeRuntime.cs"
        ).read_text(encoding="utf-8")
        self.manifest = (
            self.bridge / "Shared" / "BridgeManifest.cs"
        ).read_text(encoding="utf-8")

    def test_bridge_builds_same_identity_for_clr2_and_clr4(self):
        bridge_root = ElementTree.parse(self.bridge_project).getroot()
        launcher_root = ElementTree.parse(self.launcher_project).getroot()

        self.assertEqual(
            bridge_root.findtext(".//TargetFrameworks"),
            "net35;net40",
        )
        self.assertIsNone(bridge_root.find(".//TargetFramework"))
        self.assertEqual(
            bridge_root.findtext(".//AssemblyName"),
            "TrainerDeckBridge",
        )
        self.assertEqual(
            launcher_root.findtext(".//TargetFramework"),
            "net462",
        )
        self.assertEqual(bridge_root.findtext(".//Version"), "0.7.0")
        self.assertEqual(launcher_root.findtext(".//Version"), "0.7.0")

    def test_launcher_embeds_both_runtime_payload_build_outputs(self):
        launcher_root = ElementTree.parse(self.launcher_project).getroot()
        embedded = launcher_root.findall(".//EmbeddedResource")
        self.assertEqual(len(embedded), 2)

        normalized_inputs = {
            item.attrib["Include"].replace("\\", "/")
            for item in embedded
        }
        self.assertTrue(
            any(
                "/net35/TrainerDeckBridge.dll" in path
                for path in normalized_inputs
            )
        )
        self.assertTrue(
            any(
                "/net40/TrainerDeckBridge.dll" in path
                for path in normalized_inputs
            )
        )
        logical_names = {item.attrib.get("LogicalName") for item in embedded}
        self.assertEqual(len(logical_names), 2)
        self.assertNotIn(None, logical_names)

        project_reference = launcher_root.find(".//ProjectReference")
        self.assertIsNotNone(project_reference)
        self.assertEqual(
            project_reference.attrib.get("ReferenceOutputAssembly"),
            "false",
        )

    def test_preparer_selects_embedded_payload_and_publishes_canonical_cache(self):
        for marker in (
            "UiAssemblyPatcher.InspectRuntime",
            "ReadEmbeddedBridgePayload",
            "GetManifestResourceStream",
            "File.WriteAllBytes(",
            "cachedBridgePath",
            'BridgeFileName = "TrainerDeckBridge.dll"',
            "ComputeSha256Text(manifest.token)",
            'tokenHash.Substring(0, 16)',
            "JsonCodec.Serialize(manifest)",
            "PublishCacheFile",
            "ResolveCacheRoot",
            "manifest.cacheDirectory",
            "TryHide(cacheDirectory)",
            "ClearCacheFileOverwriteAttributes",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.preparer)

        self.assertNotIn(
            "Path.Combine(\n                    launcherDirectory,\n"
            "                    BridgeFileName)",
            self.preparer,
        )
        self.assertNotIn("File.Copy(\n                    bridgeAssemblyPath", self.preparer)

    def test_patcher_accepts_only_consistent_clr2_or_clr4_metadata(self):
        for marker in (
            "BridgeRuntime.Clr2",
            "BridgeRuntime.Clr4",
            'runtimeVersion.StartsWith(\n                    "v2."',
            'runtimeVersion.StartsWith(\n                    "v4."',
            "mscorlibMajor == 2",
            "mscorlibMajor == 4",
            "metadataRuntime != coreLibraryRuntime",
            "EnsureExpectedRuntime",
            "BridgeAssemblySimpleName",
            "EnsureBridgeAssemblyIdentity",
            "AddExitTrampoline",
            "AddStateCallbacks",
            "AddMenuPayloadCallback",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.patcher)
        self.assertNotIn("major != 2", self.patcher)

    def test_shared_json_codec_has_no_system_web_dependency(self):
        combined = "\n".join(
            (
                self.runtime,
                self.manifest,
                self.bridge_project.read_text(encoding="utf-8"),
                self.launcher_project.read_text(encoding="utf-8"),
            )
        )
        self.assertNotIn("System.Web.Extensions", combined)
        self.assertNotIn("JavaScriptSerializer", combined)
        self.assertIn("JsonCodec", combined)
        self.assertTrue((self.bridge / "Shared" / "JsonCodec.cs").exists())

    def test_build_scripts_publish_dual_build_only_payloads(self):
        for relative in ("build.ps1", "build.sh"):
            with self.subTest(script=relative):
                source = (self.bridge / relative).read_text(encoding="utf-8")
                self.assertIn("net35", source)
                self.assertIn("net40", source)
                self.assertIn("TrainerDeckBridge.Clr2.dll", source)
                self.assertIn("TrainerDeckBridge.Clr4.dll", source)

    def test_manifest_retains_loading_and_safety_contract(self):
        self.assertIn("JsonCodec.Deserialize<BridgeManifest>", self.manifest)
        self.assertIn("manifest.ApplyDefaults()", self.manifest)
        self.assertIn("manifest.Validate(requireTrainer)", self.manifest)
        self.assertIn('public string cacheDirectory {', self.manifest)
        self.assertIn('public string trainer {', self.manifest)


if __name__ == "__main__":
    unittest.main()
