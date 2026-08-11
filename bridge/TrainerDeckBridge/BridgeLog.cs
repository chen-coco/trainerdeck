using System;
using System.IO;
using System.Text;

namespace TrainerDeckBridge
{
    internal static class BridgeLog
    {
        private static readonly object Gate = new object();

        public static void Write(string message)
        {
            try
            {
                string directory = AppDomain.CurrentDomain.BaseDirectory;
                string path = Path.Combine(directory, "trainerdeck-bridge.log");
                string line = DateTime.UtcNow.ToString("o")
                    + " "
                    + (message ?? string.Empty)
                    + Environment.NewLine;

                lock (Gate)
                {
                    File.AppendAllText(path, line, new UTF8Encoding(false));
                }
            }
            catch
            {
                // The bridge must never take the original trainer down because
                // its optional diagnostic log is not writable.
            }
        }
    }
}
