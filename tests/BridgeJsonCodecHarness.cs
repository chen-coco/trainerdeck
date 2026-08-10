using System;
using System.Collections.Generic;

namespace TrainerDeckBridge
{
    internal sealed class BridgeJsonCodecHarnessManifest
    {
        public int protocol { get; set; }

        public string host { get; set; }

        public int port { get; set; }

        public long app_id { get; set; }
    }

    internal static class BridgeJsonCodecHarness
    {
        public static int Main()
        {
            Dictionary<string, object> labels =
                new Dictionary<string, object>();
            labels["zh_cn"] = "师父\n\\窗口";
            labels["en"] = "Sifu";

            Dictionary<string, object> option =
                new Dictionary<string, object>();
            option["id"] = "N1";
            option["active"] = false;
            option["minimum"] = 0.5;
            option["labels"] = labels;

            List<object> options = new List<object>();
            options.Add(option);

            Dictionary<string, object> payload =
                new Dictionary<string, object>();
            payload["type"] = "snapshot";
            payload["revision"] = 4294967296L;
            payload["game_available"] = true;
            payload["options"] = options;

            string json = JsonCodec.Serialize(payload);
            Dictionary<string, object> decoded =
                (Dictionary<string, object>)JsonCodec.DeserializeObject(json);
            List<object> decodedOptions =
                (List<object>)decoded["options"];
            Dictionary<string, object> decodedOption =
                (Dictionary<string, object>)decodedOptions[0];
            Dictionary<string, object> decodedLabels =
                (Dictionary<string, object>)decodedOption["labels"];
            if ((string)decoded["type"] != "snapshot"
                || (long)decoded["revision"] != 4294967296L
                || (string)decodedLabels["zh_cn"] != "师父\n\\窗口")
            {
                throw new InvalidOperationException(
                    "Protocol JSON round-trip failed.");
            }

            BridgeJsonCodecHarnessManifest manifest =
                JsonCodec.Deserialize<BridgeJsonCodecHarnessManifest>(
                    "{\"protocol\":1,\"host\":\"127.0.0.1\","
                    + "\"port\":34295,\"app_id\":3908080889}");
            if (manifest.protocol != 1
                || manifest.host != "127.0.0.1"
                || manifest.port != 34295
                || manifest.app_id != 3908080889L)
            {
                throw new InvalidOperationException(
                    "Manifest JSON conversion failed.");
            }

            bool invalidRejected = false;
            try
            {
                JsonCodec.DeserializeObject("{\"x\":1,\"x\":2}");
            }
            catch (FormatException)
            {
                invalidRejected = true;
            }
            if (!invalidRejected)
            {
                throw new InvalidOperationException(
                    "Duplicate JSON key was accepted.");
            }

            Console.WriteLine("PASS bridge JSON codec round-trip");
            return 0;
        }
    }
}
