import unittest
from pathlib import Path


class BridgeLauncherResilienceTests(unittest.TestCase):
    def setUp(self):
        repository = Path(__file__).resolve().parents[1]
        self.source = (
            repository
            / "bridge"
            / "TrainerDeckBridgeLauncher"
            / "Program.cs"
        ).read_text(encoding="utf-8")

    def test_any_observed_startup_exit_without_ready_fails_open(self):
        self.assertIn("return processExited && !bridgeReady;", self.source)
        self.assertNotIn("ShortExitThresholdMilliseconds", self.source)
        self.assertNotIn("exitCode == 0", self.source)

    def test_ready_probe_uses_only_log_growth_after_launch_baseline(self):
        self.assertIn(
            "Path.GetDirectoryName(trainer.PreparedPath),\n"
            "                    Path.GetDirectoryName(originalPath)",
            self.source,
        )
        self.assertIn("initialLength = TryGetLength(path);", self.source)
        self.assertIn(
            "long startOffset = stream.Length >= initialLength",
            self.source,
        )
        self.assertIn("stream.Position = startOffset;", self.source)
        self.assertIn('BridgeReadyLine = "Bridge started."', self.source)

    def test_startup_exit_waits_for_possible_wrapper_child_ready_signal(self):
        self.assertIn(
            "the fail-open \"\n"
            "                            + \"decision until the startup observation window",
            self.source,
        )
        self.assertGreaterEqual(
            self.source.count("TryFindFreshReady(out"),
            2,
        )

    def test_monitoring_error_never_starts_a_second_trainer(self):
        self.assertIn(
            "Fail-open suppressed: prepared trainer monitoring failed",
            self.source,
        )
        self.assertIn(
            "return WaitWithoutFailOpen(process, processId, lifetime);",
            self.source,
        )
        self.assertIn(
            "return new PreparedLaunchOutcome(\n"
            "                    processId,\n"
            "                    1,\n"
            "                    lifetime.ElapsedMilliseconds,\n"
            "                    false);",
            self.source,
        )

    def test_launcher_records_process_and_fail_open_decision_diagnostics(self):
        for marker in (
            "Prepared trainer started: pid=",
            "Prepared trainer exited: pid=",
            "exit_code=",
            "lifetime_ms=",
            "Fail-open decision: starting the original trainer",
            "Fail-open suppressed:",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.source)


if __name__ == "__main__":
    unittest.main()
