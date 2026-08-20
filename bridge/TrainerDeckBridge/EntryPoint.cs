using System;
using System.Collections.Generic;
using System.IO;
using TrainerDeckBridge.Protocol;

namespace TrainerDeckBridge
{
    public static class EntryPoint
    {
        private const string ManifestName = "trainerdeck-bridge.json";
        private const string LiveManifestEnvironmentVariable =
            "TRAINERDECK_BRIDGE_MANIFEST";

        private static readonly object Gate = new object();
        private static BridgeRuntime runtime;
        private static object attachedWindow;
        private static object pendingWindow;
        private static string pendingChineseMenu;
        private static string pendingEnglishMenu;
        private static readonly Dictionary<string, bool> PendingStates =
            new Dictionary<string, bool>(StringComparer.Ordinal);

        public static void Start(object mainWindow)
        {
            if (mainWindow == null)
            {
                return;
            }

            lock (Gate)
            {
                if (runtime != null)
                {
                    if (!object.ReferenceEquals(attachedWindow, mainWindow))
                    {
                        BridgeLog.Write(
                            "Ignoring a second MainWindow instance in the same AppDomain.");
                    }

                    return;
                }

                try
                {
                    string manifestPath = ResolveManifestPath();
                    BridgeManifest manifest = BridgeManifest.Load(
                        manifestPath,
                        false);

                    ReflectionMenuReader reader = new ReflectionMenuReader(mainWindow);
                    if (object.ReferenceEquals(pendingWindow, mainWindow))
                    {
                        if (pendingChineseMenu != null
                            && pendingEnglishMenu != null)
                        {
                            reader.ReportMenuPayload(
                                pendingChineseMenu,
                                pendingEnglishMenu);
                        }

                        foreach (KeyValuePair<string, bool> state in PendingStates)
                        {
                            reader.ReportAuthoritativeState(
                                state.Key,
                                state.Value);
                        }
                    }

                    BridgeRuntime created = new BridgeRuntime(
                        manifestPath,
                        manifest,
                        reader);
                    attachedWindow = mainWindow;
                    runtime = created;
                    pendingWindow = null;
                    pendingChineseMenu = null;
                    pendingEnglishMenu = null;
                    PendingStates.Clear();
                    created.Start();
                    BridgeLog.Write("Bridge started.");
                }
                catch (Exception ex)
                {
                    // EntryPoint is injected into FLiNG's own initialization path.
                    // Never allow bridge failure to change the trainer's behavior.
                    BridgeLog.Write("Bridge start failed: " + ex);
                }
            }
        }

        private static string ResolveManifestPath()
        {
            string adjacentPath = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory,
                ManifestName);
            string livePath = Environment.GetEnvironmentVariable(
                LiveManifestEnvironmentVariable);
            if (FrameworkCompat.IsNullOrWhiteSpace(livePath))
            {
                return adjacentPath;
            }

            string resolved = Path.GetFullPath(livePath);
            if (!string.Equals(
                    Path.GetFileName(resolved),
                    ManifestName,
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "The live bridge manifest has an unexpected name.");
            }

            return resolved;
        }

        public static void ReportOptionState(
            object mainWindow,
            string optionId,
            bool active)
        {
            if (mainWindow == null || FrameworkCompat.IsNullOrWhiteSpace(optionId))
            {
                return;
            }

            try
            {
                lock (Gate)
                {
                    if (runtime == null)
                    {
                        RememberPendingWindow(mainWindow);
                        PendingStates[optionId] = active;
                        return;
                    }

                    if (!object.ReferenceEquals(attachedWindow, mainWindow))
                    {
                        return;
                    }

                    runtime.ReportAuthoritativeState(optionId, active);
                }
            }
            catch (Exception ex)
            {
                // This call is injected into FLiNG's core-state callback. Never
                // allow bridge bookkeeping to affect the original callback.
                BridgeLog.Write("Option-state report failed: " + ex);
            }
        }

        public static void ReportMenuPayload(
            object mainWindow,
            string chineseMenu,
            string englishMenu)
        {
            if (mainWindow == null
                || chineseMenu == null
                || englishMenu == null)
            {
                return;
            }

            try
            {
                lock (Gate)
                {
                    if (runtime == null)
                    {
                        RememberPendingWindow(mainWindow);
                        pendingChineseMenu = chineseMenu;
                        pendingEnglishMenu = englishMenu;
                        return;
                    }

                    if (!object.ReferenceEquals(attachedWindow, mainWindow))
                    {
                        return;
                    }

                    runtime.ReportMenuPayload(chineseMenu, englishMenu);
                }
            }
            catch (Exception ex)
            {
                // Menu publication is injected into FLiNG's own parser. Never
                // allow bridge parsing or bookkeeping to affect that parser.
                BridgeLog.Write("Menu-payload report failed: " + ex);
            }
        }

        private static void RememberPendingWindow(object mainWindow)
        {
            if (pendingWindow != null
                && !object.ReferenceEquals(pendingWindow, mainWindow))
            {
                pendingChineseMenu = null;
                pendingEnglishMenu = null;
                PendingStates.Clear();
            }

            pendingWindow = mainWindow;
        }
    }
}
