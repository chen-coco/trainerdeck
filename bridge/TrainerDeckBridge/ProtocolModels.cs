using System.Collections.Generic;

namespace TrainerDeckBridge
{
    internal sealed class MenuSnapshot
    {
        public MenuSnapshot()
        {
            options = new List<TrainerOption>();
        }

        public bool gameRunning { get; set; }

        public List<TrainerOption> options { get; set; }
    }

    internal sealed class TrainerOption
    {
        public TrainerOption()
        {
            labels = new Dictionary<string, string>();
            tooltips = new Dictionary<string, string>();
            group = new Dictionary<string, string>();
            value_type = "none";
            value_apply_mode = "none";
        }

        public string id { get; set; }

        public string kind { get; set; }

        public Dictionary<string, string> labels { get; set; }

        public Dictionary<string, string> tooltips { get; set; }

        public Dictionary<string, string> group { get; set; }

        public string tooltip_style { get; set; }

        public bool? active { get; set; }

        public bool controllable { get; set; }

        public bool action_controllable { get; set; }

        public string value { get; set; }

        public bool value_controllable { get; set; }

        public string value_type { get; set; }

        public string value_apply_mode { get; set; }

        public double? minimum { get; set; }

        public double? maximum { get; set; }

        public double? step { get; set; }

        internal bool Available { get; set; }

        internal bool HasReadableInputValue { get; set; }

        internal bool ActionWithoutInput { get; set; }
    }

    internal sealed class CommandResult
    {
        public string status { get; set; }

        public string error { get; set; }

        public string operation { get; set; }

        public string value { get; set; }

        public bool invoked { get; set; }
    }

    internal static class ProtocolFactory
    {
        public static Dictionary<string, object> Hello(
            int protocol,
            string token,
            long appId,
            string sessionId,
            string trainerSha256,
            string uiFingerprint)
        {
            Dictionary<string, object> message = Base("hello", token);
            message["protocol"] = protocol;
            message["app_id"] = appId;
            message["session_id"] = sessionId;
            message["trainer_sha256"] = trainerSha256 ?? string.Empty;
            message["ui_fingerprint"] = uiFingerprint ?? string.Empty;
            message["bridge_version"] = "0.7.0";
            message["state_authority"] = "core_callback";
            message["value_state_authority"] = "ui_control_readback";
            message["capabilities"] = new[]
            {
                "toggle_command_v1",
                "action_command_v1",
                "value_snapshot_v1",
                "value_command_v1",
                "value_command_receipt_v1",
                "trainer_window_visible_v1",
                "auto_return_confirmation_v1",
                "localized_widget_fallback_v1",
                "nonblocking_ui_commands_v1",
                "independent_heartbeat_v1"
            };
            return message;
        }

        public static Dictionary<string, object> Snapshot(
            string token,
            string sessionId,
            long revision,
            MenuSnapshot snapshot)
        {
            Dictionary<string, object> message = Base("snapshot", token);
            message["session_id"] = sessionId;
            message["revision"] = revision;
            message["game_available"] = snapshot.gameRunning;
            message["options"] = snapshot.options;
            return message;
        }

        public static Dictionary<string, object> Heartbeat(
            string token,
            string sessionId)
        {
            Dictionary<string, object> message = Base("heartbeat", token);
            message["session_id"] = sessionId;
            return message;
        }

        public static Dictionary<string, object> CommandAccepted(
            string token,
            string sessionId,
            string requestId,
            CommandResult result)
        {
            Dictionary<string, object> message = Base(
                "command_accepted",
                token);
            message["session_id"] = sessionId;
            message["request_id"] = requestId;
            if (result != null)
            {
                if (!FrameworkCompat.IsNullOrWhiteSpace(result.status))
                {
                    message["status"] = result.status;
                }
                if (!FrameworkCompat.IsNullOrWhiteSpace(result.operation))
                {
                    message["operation"] = result.operation;
                    if (result.value != null)
                    {
                        message["value"] = result.value;
                    }
                    message["invoked"] = result.invoked;
                }
            }
            return message;
        }

        public static Dictionary<string, object> CommandError(
            string token,
            string sessionId,
            string requestId,
            string error)
        {
            Dictionary<string, object> message = Base("command_error", token);
            message["session_id"] = sessionId;
            message["request_id"] = requestId;
            message["message"] = error ?? "trainer rejected the command";
            return message;
        }

        private static Dictionary<string, object> Base(
            string type,
            string token)
        {
            Dictionary<string, object> message =
                new Dictionary<string, object>();
            message["type"] = type;
            message["token"] = token;
            return message;
        }
    }
}
