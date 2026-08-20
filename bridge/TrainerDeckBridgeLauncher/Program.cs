using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using TrainerDeckBridge.Protocol;

namespace TrainerDeckBridgeLauncher
{
    internal static class Program
    {
        private const string ManifestName = "trainerdeck-bridge.json";
        private const string BridgeLogName = "trainerdeck-bridge.log";
        private const string BridgeReadyLine = "Bridge started.";
        private const string LiveManifestEnvironmentVariable =
            "TRAINERDECK_BRIDGE_MANIFEST";
        private const int MinimumStartupObservationMilliseconds = 12000;
        private const int MaximumStartupObservationMilliseconds = 30000;
        private const int StartupObservationPaddingMilliseconds = 5000;
        private const int ObservationPollMilliseconds = 100;

        public static int Main(string[] args)
        {
            try
            {
                LauncherLog.Write(
                    "Launcher entered: version="
                    + typeof(Program).Assembly.GetName().Version
                    + " clr="
                    + Environment.Version
                    + " process_bits="
                    + (IntPtr.Size * 8)
                    + " base_directory=\""
                    + AppDomain.CurrentDomain.BaseDirectory
                    + "\" current_directory=\""
                    + Environment.CurrentDirectory
                    + "\" argument_count="
                    + args.Length
                    + ".");
                bool prepareOnly = false;
                List<string> forwarded = new List<string>();
                for (int index = 0; index < args.Length; index++)
                {
                    if (string.Equals(
                            args[index],
                            "--prepare-only",
                            StringComparison.Ordinal))
                    {
                        prepareOnly = true;
                    }
                    else
                    {
                        forwarded.Add(args[index]);
                    }
                }

                string manifestPath = Path.Combine(
                    AppDomain.CurrentDomain.BaseDirectory,
                    ManifestName);
                BridgeManifest manifest = BridgeManifest.Load(
                    manifestPath,
                    true);
                string originalPath = TrainerPreparer.ResolveOriginalTrainer(
                    manifestPath,
                    manifest);
                LauncherLog.Write(
                    "Manifest loaded: app_id="
                    + manifest.app_id
                    + " manifest=\""
                    + manifestPath
                    + "\" original=\""
                    + originalPath
                    + "\".");
                PreparedTrainer trainer;
                try
                {
                    trainer = TrainerPreparer.Prepare(
                        manifestPath,
                        manifest);
                }
                catch (Exception preparationError)
                {
                    LauncherLog.Write(
                        "Bridge preparation failed: " + preparationError);
                    if (prepareOnly)
                    {
                        throw;
                    }

                    LauncherLog.Write(
                        "Fail-open: starting the original trainer without bridge.");
                    return StartAndWait(
                        originalPath,
                        Path.GetDirectoryName(originalPath),
                        forwarded);
                }

                LauncherLog.Write(
                    "Prepared trainer available: prepared=\""
                    + trainer.PreparedPath
                    + "\" original=\""
                    + originalPath
                    + "\" working_directory=\""
                    + trainer.WorkingDirectory
                    + "\" runtime="
                    + trainer.RuntimeLabel
                    + " runtime_version=\""
                    + trainer.RuntimeVersion
                    + "\" payload=\""
                    + trainer.PayloadName
                    + "\".");
                Console.WriteLine(trainer.PreparedPath);
                if (prepareOnly)
                {
                    return 0;
                }

                BridgeReadyProbe readyProbe = new BridgeReadyProbe(
                    Path.GetDirectoryName(trainer.PreparedPath),
                    Path.GetDirectoryName(originalPath));
                Process preparedProcess;
                try
                {
                    preparedProcess = StartProcess(
                        trainer.PreparedPath,
                        trainer.WorkingDirectory,
                        forwarded,
                        manifestPath);
                }
                catch (Exception startError)
                {
                    LauncherLog.Write(
                        "Prepared trainer start failed: " + startError);
                    LauncherLog.Write(
                        "Fail-open: starting the original trainer without bridge.");
                    return StartAndWait(
                        originalPath,
                        Path.GetDirectoryName(originalPath),
                        forwarded,
                        "original fail-open trainer");
                }

                PreparedLaunchOutcome outcome;
                using (preparedProcess)
                {
                    outcome = ObservePreparedProcess(
                        preparedProcess,
                        trainer.PreparedPath,
                        readyProbe,
                        GetStartupObservationMilliseconds(manifest));
                }

                if (outcome.ShouldFailOpen)
                {
                    LauncherLog.Write(
                        "Fail-open decision: starting the original trainer; "
                        + "reason=prepared_exited_without_fresh_bridge_ready "
                        + "prepared_pid="
                        + outcome.ProcessId
                        + " prepared_exit_code="
                        + outcome.ExitCode
                        + " prepared_lifetime_ms="
                        + outcome.LifetimeMilliseconds
                        + ".");
                    return StartAndWait(
                        originalPath,
                        Path.GetDirectoryName(originalPath),
                        forwarded,
                        "original fail-open trainer");
                }

                return outcome.ExitCode;
            }
            catch (Exception ex)
            {
                LauncherLog.Write("Launcher failed before completion: " + ex);
                Console.Error.WriteLine(
                    "TrainerDeck bridge launcher failed: " + ex);
                return 1;
            }
        }

        private static int StartAndWait(
            string executablePath,
            string workingDirectory,
            IList<string> forwarded,
            string processDescription = "trainer")
        {
            Stopwatch lifetime = Stopwatch.StartNew();
            using (Process process = StartProcess(
                executablePath,
                workingDirectory,
                forwarded))
            {
                int processId = process.Id;
                LauncherLog.Write(
                    processDescription
                    + " started: pid="
                    + processId
                    + " path=\""
                    + executablePath
                    + "\".");
                process.WaitForExit();
                int exitCode = process.ExitCode;
                LauncherLog.Write(
                    processDescription
                    + " exited: pid="
                    + processId
                    + " exit_code="
                    + exitCode
                    + " lifetime_ms="
                    + lifetime.ElapsedMilliseconds
                    + ".");
                return exitCode;
            }
        }

        private static Process StartProcess(
            string executablePath,
            string workingDirectory,
            IList<string> forwarded,
            string liveManifestPath = null)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = executablePath;
            startInfo.WorkingDirectory = workingDirectory;
            startInfo.UseShellExecute = false;
            startInfo.Arguments = JoinArguments(forwarded);
            if (!string.IsNullOrWhiteSpace(liveManifestPath))
            {
                string resolvedManifestPath = Path.GetFullPath(
                    liveManifestPath);
                if (!string.Equals(
                        Path.GetFileName(resolvedManifestPath),
                        ManifestName,
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException(
                        "The live bridge manifest has an unexpected name.");
                }

                // The immutable cache keeps the exact launch snapshot, while
                // the running Bridge follows this atomically replaced outer
                // manifest so a Decky backend restart can rotate port/token
                // without relaunching the trainer.
                startInfo.EnvironmentVariables[
                    LiveManifestEnvironmentVariable] = resolvedManifestPath;
            }

            LauncherLog.Write(
                "Process.Start requested: path=\""
                + executablePath
                + "\" working_directory=\""
                + workingDirectory
                + "\" argument_count="
                + forwarded.Count
                + " use_shell_execute=false.");
            Process process = Process.Start(startInfo);
            if (process == null)
            {
                throw new InvalidOperationException(
                    "The trainer did not start.");
            }

            return process;
        }

        private static PreparedLaunchOutcome ObservePreparedProcess(
            Process process,
            string executablePath,
            BridgeReadyProbe readyProbe,
            int startupObservationMilliseconds)
        {
            Stopwatch lifetime = Stopwatch.StartNew();
            int processId = process.Id;
            LauncherLog.Write(
                "Prepared trainer started: pid="
                + processId
                + " path=\""
                + executablePath
                + "\" startup_observation_ms="
                + startupObservationMilliseconds
                + " bridge_ready_signal=\""
                + BridgeReadyLine
                + "\".");

            try
            {
                return ObservePreparedProcessCore(
                    process,
                    processId,
                    lifetime,
                    readyProbe,
                    startupObservationMilliseconds);
            }
            catch (Exception monitoringError)
            {
                // Once Process.Start succeeds, an observation failure must not
                // cause a second trainer instance. Waiting is safer than an
                // ambiguous fail-open after a possible wrapper hand-off.
                LauncherLog.Write(
                    "Fail-open suppressed: prepared trainer monitoring failed "
                    + "after start; refusing to risk a duplicate trainer. pid="
                    + processId
                    + " error="
                    + monitoringError
                    + ".");
                return WaitWithoutFailOpen(process, processId, lifetime);
            }
        }

        private static PreparedLaunchOutcome ObservePreparedProcessCore(
            Process process,
            int processId,
            Stopwatch lifetime,
            BridgeReadyProbe readyProbe,
            int startupObservationMilliseconds)
        {
            bool processExited = false;
            int exitCode = 1;
            long exitLifetimeMilliseconds = -1;
            bool startupExitWaitLogged = false;

            while (lifetime.ElapsedMilliseconds
                < startupObservationMilliseconds)
            {
                string readyLogPath;
                if (readyProbe.TryFindFreshReady(out readyLogPath))
                {
                    LauncherLog.Write(
                        "Fresh bridge ready signal observed: pid="
                        + processId
                        + " lifetime_ms="
                        + lifetime.ElapsedMilliseconds
                        + " log=\""
                        + readyLogPath
                        + "\".");
                    if (!processExited)
                    {
                        process.WaitForExit();
                        exitCode = process.ExitCode;
                        exitLifetimeMilliseconds = lifetime.ElapsedMilliseconds;
                        LogPreparedExit(
                            processId,
                            exitCode,
                            exitLifetimeMilliseconds,
                            true);
                    }

                    LauncherLog.Write(
                        "Fail-open suppressed: a fresh bridge ready signal "
                        + "was observed for this launch. pid="
                        + processId
                        + ".");
                    return new PreparedLaunchOutcome(
                        processId,
                        exitCode,
                        exitLifetimeMilliseconds,
                        false);
                }

                int remainingMilliseconds = startupObservationMilliseconds
                    - (int)Math.Min(
                        startupObservationMilliseconds,
                        lifetime.ElapsedMilliseconds);
                int waitMilliseconds = Math.Max(
                    1,
                    Math.Min(
                        ObservationPollMilliseconds,
                        remainingMilliseconds));
                if (!processExited && process.WaitForExit(waitMilliseconds))
                {
                    process.WaitForExit();
                    processExited = true;
                    exitCode = process.ExitCode;
                    exitLifetimeMilliseconds = lifetime.ElapsedMilliseconds;
                    LogPreparedExit(
                        processId,
                        exitCode,
                        exitLifetimeMilliseconds,
                        false);

                    if (!startupExitWaitLogged)
                    {
                        startupExitWaitLogged = true;
                        LauncherLog.Write(
                            "Prepared trainer exited during startup; delaying "
                            + "the fail-open "
                            + "decision until the startup observation window "
                            + "ends so a wrapper child can publish bridge ready. "
                            + "pid="
                            + processId
                            + " exit_code="
                            + exitCode
                            + ".");
                    }
                }
                else if (processExited)
                {
                    Thread.Sleep(waitMilliseconds);
                }
            }

            if (!processExited && process.WaitForExit(0))
            {
                process.WaitForExit();
                processExited = true;
                exitCode = process.ExitCode;
                exitLifetimeMilliseconds = lifetime.ElapsedMilliseconds;
                LogPreparedExit(
                    processId,
                    exitCode,
                    exitLifetimeMilliseconds,
                    false);
            }

            string finalReadyLogPath;
            bool bridgeReady = readyProbe.TryFindFreshReady(
                out finalReadyLogPath);
            if (bridgeReady)
            {
                LauncherLog.Write(
                    "Fresh bridge ready signal observed at the end of the "
                    + "startup window: pid="
                    + processId
                    + " log=\""
                    + finalReadyLogPath
                    + "\".");
            }

            if (ShouldFailOpen(
                    processExited,
                    bridgeReady))
            {
                return new PreparedLaunchOutcome(
                    processId,
                    exitCode,
                    exitLifetimeMilliseconds,
                    true);
            }

            if (processExited)
            {
                LauncherLog.Write(
                    "Fail-open suppressed: prepared trainer exit was not an "
                    + "eligible startup exit without bridge ready. pid="
                    + processId
                    + ".");
                return new PreparedLaunchOutcome(
                    processId,
                    exitCode,
                    exitLifetimeMilliseconds,
                    false);
            }

            LauncherLog.Write(
                "Fail-open suppressed: prepared trainer survived the startup "
                + "observation window. pid="
                + processId
                + " observation_ms="
                + startupObservationMilliseconds
                + ".");
            process.WaitForExit();
            exitCode = process.ExitCode;
            exitLifetimeMilliseconds = lifetime.ElapsedMilliseconds;
            LogPreparedExit(
                processId,
                exitCode,
                exitLifetimeMilliseconds,
                bridgeReady);
            return new PreparedLaunchOutcome(
                processId,
                exitCode,
                exitLifetimeMilliseconds,
                false);
        }

        internal static bool ShouldFailOpen(
            bool processExited,
            bool bridgeReady)
        {
            return processExited && !bridgeReady;
        }

        private static PreparedLaunchOutcome WaitWithoutFailOpen(
            Process process,
            int processId,
            Stopwatch lifetime)
        {
            try
            {
                process.WaitForExit();
                int exitCode = process.ExitCode;
                long lifetimeMilliseconds = lifetime.ElapsedMilliseconds;
                LogPreparedExit(
                    processId,
                    exitCode,
                    lifetimeMilliseconds,
                    false);
                return new PreparedLaunchOutcome(
                    processId,
                    exitCode,
                    lifetimeMilliseconds,
                    false);
            }
            catch (Exception waitError)
            {
                LauncherLog.Write(
                    "Prepared trainer could no longer be observed; returning "
                    + "an error without fail-open. pid="
                    + processId
                    + " error="
                    + waitError
                    + ".");
                return new PreparedLaunchOutcome(
                    processId,
                    1,
                    lifetime.ElapsedMilliseconds,
                    false);
            }
        }

        private static void LogPreparedExit(
            int processId,
            int exitCode,
            long lifetimeMilliseconds,
            bool bridgeReady)
        {
            LauncherLog.Write(
                "Prepared trainer exited: pid="
                + processId
                + " exit_code="
                + exitCode
                + " lifetime_ms="
                + lifetimeMilliseconds
                + " bridge_ready="
                + (bridgeReady ? "true" : "false")
                + ".");
        }

        private static int GetStartupObservationMilliseconds(
            BridgeManifest manifest)
        {
            return Math.Min(
                MaximumStartupObservationMilliseconds,
                Math.Max(
                    MinimumStartupObservationMilliseconds,
                    manifest.connectTimeoutMs
                        + StartupObservationPaddingMilliseconds));
        }

        private static string JoinArguments(IList<string> arguments)
        {
            StringBuilder result = new StringBuilder();
            for (int index = 0; index < arguments.Count; index++)
            {
                if (index > 0)
                {
                    result.Append(' ');
                }

                result.Append(QuoteArgument(arguments[index]));
            }

            return result.ToString();
        }

        private static string QuoteArgument(string argument)
        {
            if (argument == null)
            {
                return "\"\"";
            }

            if (argument.Length > 0
                && argument.IndexOfAny(
                    new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return argument;
            }

            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            for (int index = 0; index < argument.Length; index++)
            {
                char character = argument[index];
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (character == '"')
                {
                    quoted.Append('\\', (backslashes * 2) + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }

                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(character);
            }

            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private sealed class PreparedLaunchOutcome
        {
            public PreparedLaunchOutcome(
                int processId,
                int exitCode,
                long lifetimeMilliseconds,
                bool shouldFailOpen)
            {
                ProcessId = processId;
                ExitCode = exitCode;
                LifetimeMilliseconds = lifetimeMilliseconds;
                ShouldFailOpen = shouldFailOpen;
            }

            public int ProcessId { get; private set; }

            public int ExitCode { get; private set; }

            public long LifetimeMilliseconds { get; private set; }

            public bool ShouldFailOpen { get; private set; }
        }

        private sealed class BridgeReadyProbe
        {
            private readonly List<BridgeLogCursor> cursors =
                new List<BridgeLogCursor>();

            public BridgeReadyProbe(params string[] directories)
            {
                HashSet<string> uniquePaths = new HashSet<string>(
                    StringComparer.OrdinalIgnoreCase);
                for (int index = 0; index < directories.Length; index++)
                {
                    string directory = directories[index];
                    if (string.IsNullOrWhiteSpace(directory))
                    {
                        continue;
                    }

                    string path = Path.Combine(directory, BridgeLogName);
                    path = Path.GetFullPath(path);
                    if (uniquePaths.Add(path))
                    {
                        cursors.Add(new BridgeLogCursor(path));
                    }
                }
            }

            public bool TryFindFreshReady(out string logPath)
            {
                for (int index = 0; index < cursors.Count; index++)
                {
                    if (cursors[index].HasFreshReady())
                    {
                        logPath = cursors[index].Path;
                        return true;
                    }
                }

                logPath = null;
                return false;
            }
        }

        private sealed class BridgeLogCursor
        {
            private readonly long initialLength;

            public BridgeLogCursor(string path)
            {
                Path = path;
                initialLength = TryGetLength(path);
            }

            public string Path { get; private set; }

            public bool HasFreshReady()
            {
                try
                {
                    using (FileStream stream = new FileStream(
                        Path,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete))
                    {
                        long startOffset = stream.Length >= initialLength
                            ? initialLength
                            : 0;
                        if (stream.Length <= startOffset)
                        {
                            return false;
                        }

                        stream.Position = startOffset;
                        using (StreamReader reader = new StreamReader(
                            stream,
                            new UTF8Encoding(false, true),
                            true))
                        {
                            string appended = reader.ReadToEnd();
                            return appended.IndexOf(
                                BridgeReadyLine,
                                StringComparison.Ordinal) >= 0;
                        }
                    }
                }
                catch
                {
                    return false;
                }
            }

            private static long TryGetLength(string path)
            {
                try
                {
                    FileInfo info = new FileInfo(path);
                    return info.Exists ? info.Length : 0;
                }
                catch
                {
                    return 0;
                }
            }
        }
    }
}
