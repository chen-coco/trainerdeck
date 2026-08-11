import unittest
from pathlib import Path
from xml.etree import ElementTree


class BridgeCurrentRuntimeTests(unittest.TestCase):
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

    def test_single_canonical_bridge_and_launcher_targets(self):
        bridge_root = ElementTree.parse(self.bridge_project).getroot()
        launcher_root = ElementTree.parse(self.launcher_project).getroot()
        self.assertEqual(bridge_root.findtext(".//TargetFramework"), "net35")
        self.assertEqual(
            launcher_root.findtext(".//TargetFramework"), "net462"
        )
        self.assertIsNone(bridge_root.find(".//TargetFrameworks"))
        self.assertFalse(
            (
                self.bridge
                / "TrainerDeckBridgeLauncher"
                / "BridgeAssemblySelector.cs"
            ).exists()
        )
        self.assertEqual(bridge_root.findtext(".//Version"), "0.6.7")
        self.assertEqual(launcher_root.findtext(".//Version"), "0.6.7")

    def test_preparer_uses_only_current_canonical_bridge(self):
        self.assertIn(
            'BridgeFileName = "TrainerDeckBridge.dll"', self.preparer
        )
        self.assertNotIn("Legacy", self.preparer)
        self.assertNotIn("Select(", self.preparer)
        self.assertNotIn("AtomicBridgePublisher", self.preparer)
        self.assertIn("UiAssemblyPatcher.InjectBridgeStart", self.preparer)
        self.assertIn("ResolveCacheRoot", self.preparer)
        self.assertIn("manifest.cacheDirectory", self.preparer)
        self.assertIn("TryHide(cacheDirectory)", self.preparer)
        self.assertIn("ClearCacheFileOverwriteAttributes", self.preparer)

    def test_patcher_keeps_three_hooks_without_runtime_selector(self):
        for marker in (
            "AddExitTrampoline",
            "AddStateCallbacks",
            "AddMenuPayloadCallback",
        ):
            self.assertIn(marker, self.patcher)
        self.assertNotIn("BridgeAssemblySelector", self.patcher)
        self.assertNotIn("EnsureCompatible", self.patcher)
        self.assertIn("EnsureCurrentRuntime", self.patcher)
        self.assertIn("major != 2", self.patcher)

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

    def test_build_scripts_publish_no_legacy_artifact(self):
        for relative in ("build.ps1", "build.sh"):
            with self.subTest(script=relative):
                source = (self.bridge / relative).read_text(encoding="utf-8")
                self.assertNotIn("TrainerDeckBridge.Legacy.dll", source)
                self.assertIn("net35", source)
                self.assertIn("net462", source)

    def test_manifest_retains_051_loading_and_safety_contract(self):
        self.assertIn("JsonCodec.Deserialize<BridgeManifest>", self.manifest)
        self.assertIn("manifest.ApplyDefaults()", self.manifest)
        self.assertIn("manifest.Validate(requireTrainer)", self.manifest)
        self.assertIn('public string cacheDirectory {', self.manifest)
        self.assertIn('public string trainer {', self.manifest)


if __name__ == "__main__":
    unittest.main()
