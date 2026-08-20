import unittest
from pathlib import Path


class BridgeWindowPolicyTests(unittest.TestCase):
    def setUp(self):
        repository = Path(__file__).resolve().parents[1]
        self.reader_source = (
            repository
            / "bridge"
            / "TrainerDeckBridge"
            / "ReflectionMenuReader.cs"
        ).read_text(encoding="utf-8")
        self.runtime_source = (
            repository
            / "bridge"
            / "TrainerDeckBridge"
            / "BridgeRuntime.cs"
        ).read_text(encoding="utf-8")
        self.protocol_source = (
            repository
            / "bridge"
            / "TrainerDeckBridge"
            / "ProtocolModels.cs"
        ).read_text(encoding="utf-8")
        self.menu_source = (
            repository
            / "bridge"
            / "TrainerDeckBridge"
            / "MenuProtocolParser.cs"
        ).read_text(encoding="utf-8")

    def test_bridge_does_not_mutate_original_trainer_window_visibility(self):
        forbidden = (
            "EnsureWindowSuppressedOnUiThread",
            "focusSuppressionActive",
            'FindMethod(mainWindow, "Hide"',
            '"ShowInTaskbar"',
        )
        for marker in forbidden:
            with self.subTest(marker=marker):
                self.assertNotIn(marker, self.reader_source)

    def test_runtime_does_not_change_window_policy_after_authentication(self):
        self.assertNotIn("SetMenuBridgeConnected", self.runtime_source)
        self.assertNotIn("SetBridgeConnected", self.runtime_source)

    def test_bridge_no_longer_advertises_focus_suppression(self):
        self.assertNotIn(
            "window_focus_suppression_v1",
            self.protocol_source,
        )
        self.assertIn(
            'message["bridge_version"] = "0.7.0";',
            self.protocol_source,
        )
        self.assertIn(
            '"trainer_window_visible_v1"',
            self.protocol_source,
        )
        self.assertIn(
            '"auto_return_confirmation_v1"',
            self.protocol_source,
        )
        self.assertIn(
            '"value_command_receipt_v1"',
            self.protocol_source,
        )
        self.assertIn(
            '"localized_widget_fallback_v1"',
            self.protocol_source,
        )
        self.assertIn(
            '"nonblocking_ui_commands_v1"',
            self.protocol_source,
        )
        self.assertIn(
            '"independent_heartbeat_v1"',
            self.protocol_source,
        )

    def test_heartbeat_is_independent_from_ui_state_capture(self):
        poll_loop = self.runtime_source.split(
            "private void PollLoop()", 1
        )[1].split("private void HeartbeatLoop()", 1)[0]
        heartbeat_loop = self.runtime_source.split(
            "private void HeartbeatLoop()", 1
        )[1].split("private bool TrySend", 1)[0]

        self.assertIn("new Thread(HeartbeatLoop)", self.runtime_source)
        self.assertIn("ProtocolFactory.Heartbeat", heartbeat_loop)
        self.assertNotIn("menuReader.Capture", heartbeat_loop)
        self.assertNotIn("ProtocolFactory.Heartbeat", poll_loop)

    def test_ui_commands_are_posted_without_blocking_the_connection_reader(self):
        for method in (
            "BeginExecuteDesired",
            "BeginExecuteValue",
            "BeginExecuteAction",
        ):
            with self.subTest(method=method):
                self.assertIn("menuReader." + method, self.runtime_source)
        for method in (
            "menuReader.ExecuteDesired(",
            "menuReader.ExecuteValue(",
            "menuReader.ExecuteAction(",
        ):
            with self.subTest(method=method):
                self.assertNotIn(method, self.runtime_source)

        self.assertIn("dispatcherBeginInvoke.Invoke", self.reader_source)
        self.assertIn("synchronizeInvoke.BeginInvoke", self.reader_source)
        self.assertIn("commandInFlight", self.runtime_source)
        self.assertIn("ThreadPool.QueueUserWorkItem", self.runtime_source)

    def test_ready_writes_are_generation_scoped(self):
        send = self.runtime_source.split(
            "private bool TrySend", 1
        )[1].split("private void SendHello", 1)[0]
        invalidate = self.runtime_source.split(
            "private void InvalidateConnection", 1
        )[1].split("private long NextSequence", 1)[0]

        self.assertIn(
            "connectionGeneration != expectedGeneration",
            send,
        )
        self.assertIn("!connectionReady", send)
        self.assertIn(
            "object.ReferenceEquals(client, expected)",
            invalidate,
        )

    def test_english_plain_text_does_not_override_chinese_widget_metadata(self):
        validation = self.menu_source.split(
            "private static void ValidateLocalizedOptions", 1
        )[1].split("private static void ValidateEquivalent", 1)[0]
        guard = "if (!english.widget.hasWidget)"
        self.assertIn(guard, validation)
        self.assertLess(validation.index(guard), validation.index("ValidateEquivalent"))

    def test_tooltip_literals_are_normalized_for_decky_rendering(self):
        self.assertIn('.Replace("\\\\r\\\\n", "\\n")', self.reader_source)
        self.assertIn('.Replace("\\\\n", "\\n")', self.reader_source)

    def test_command_acceptance_serializes_native_result_status(self):
        self.assertIn(
            'message["status"] = result.status;',
            self.protocol_source,
        )

    def test_stage_write_is_not_reported_as_a_core_applied_value(self):
        self.assertIn('? "applied"\n                    : "staged"', self.reader_source)
        self.assertIn('result.status,\n                    "staged"', self.runtime_source)

    def test_two_argument_option_delegate_preserves_fling_empty_args_abi(self):
        self.assertNotIn(
            "new object[] { optionId, value }",
            self.reader_source,
        )
        self.assertNotIn(
            "new object[] { optionId, ReadInputValue(control) }",
            self.reader_source,
        )
        self.assertEqual(
            self.reader_source.count(
                "new object[] { optionId, string.Empty }"
            ),
            3,
        )


if __name__ == "__main__":
    unittest.main()
