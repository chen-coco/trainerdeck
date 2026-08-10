using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace TrainerDeckBridgeLauncher
{
    internal static class LauncherLog
    {
        public static void Write(string message)
        {
            string rendered = message ?? string.Empty;
            string line = DateTime.UtcNow.ToString("o")
                + " "
                + rendered
                + Environment.NewLine;

            // PROTON_REMOTE_DEBUG_CMD redirects the launcher's standard error
            // into the Proton log when logging is enabled. This remains useful
            // when every Windows-side log directory is unavailable.
            try
            {
                Console.Error.WriteLine("[TrainerDeck Launcher] " + rendered);
            }
            catch
            {
            }

            HashSet<string> paths = new HashSet<string>(
                StringComparer.OrdinalIgnoreCase);
            AddCandidate(
                paths,
                AppDomain.CurrentDomain.BaseDirectory);

            try
            {
                string local = Environment.GetFolderPath(
                    Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrWhiteSpace(local))
                {
                    AddCandidate(
                        paths,
                        Path.Combine(local, "TrainerDeck", "BridgeCache"));
                }
            }
            catch
            {
            }

            foreach (string path in paths)
            {
                try
                {
                    string directory = Path.GetDirectoryName(path);
                    if (!string.IsNullOrWhiteSpace(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }
                    File.AppendAllText(path, line, new UTF8Encoding(false));
                }
                catch
                {
                }
            }
        }

        private static void AddCandidate(
            ISet<string> paths,
            string directory)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(directory))
                {
                    return;
                }

                paths.Add(
                    Path.GetFullPath(
                        Path.Combine(
                            directory,
                            "trainerdeck-bridge-launcher.log")));
            }
            catch
            {
            }
        }
    }
}
