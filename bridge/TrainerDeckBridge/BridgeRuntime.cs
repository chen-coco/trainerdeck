using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using TrainerDeckBridge.Protocol;

namespace TrainerDeckBridge
{
    internal sealed class BridgeRuntime
    {
        private const int HeartbeatIntervalMilliseconds = 3000;

        private volatile BridgeManifest manifest;
        private readonly string manifestPath;
        private readonly long appId;
        private readonly string trainerSha256;
        private readonly ReflectionMenuReader menuReader;
        private readonly object connectionGate;
        private readonly object writeGate;
        private readonly string sessionId;

        private TcpClient client;
        private NetworkStream stream;
        private bool connectionReady;
        private int connectionGeneration;
        private long sequence;
        private long lastPublishedRevision;
        private int forceSnapshot;
        private int commandInFlight;

        public BridgeRuntime(
            string manifestPath,
            BridgeManifest manifest,
            ReflectionMenuReader menuReader)
        {
            if (manifest == null)
            {
                throw new ArgumentNullException("manifest");
            }
            if (FrameworkCompat.IsNullOrWhiteSpace(manifestPath))
            {
                throw new ArgumentException(
                    "Manifest path is required.",
                    "manifestPath");
            }

            if (menuReader == null)
            {
                throw new ArgumentNullException("menuReader");
            }

            this.manifestPath = Path.GetFullPath(manifestPath);
            this.manifest = manifest;
            appId = manifest.app_id;
            trainerSha256 = manifest.trainer_sha256 ?? string.Empty;
            this.menuReader = menuReader;
            connectionGate = new object();
            writeGate = new object();
            sessionId = Guid.NewGuid().ToString("N");
        }

        public void Start()
        {
            Thread connectionWorker = new Thread(ConnectionLoop);
            connectionWorker.Name = "TrainerDeckBridge.Connection";
            connectionWorker.IsBackground = true;
            connectionWorker.Start();

            Thread pollWorker = new Thread(PollLoop);
            pollWorker.Name = "TrainerDeckBridge.StatePoll";
            pollWorker.IsBackground = true;
            pollWorker.Start();

            Thread heartbeatWorker = new Thread(HeartbeatLoop);
            heartbeatWorker.Name = "TrainerDeckBridge.Heartbeat";
            heartbeatWorker.IsBackground = true;
            heartbeatWorker.Start();
        }

        public void ReportAuthoritativeState(string optionId, bool active)
        {
            menuReader.ReportAuthoritativeState(optionId, active);
            Interlocked.Exchange(ref forceSnapshot, 1);
        }

        public void ReportMenuPayload(string chineseMenu, string englishMenu)
        {
            menuReader.ReportMenuPayload(chineseMenu, englishMenu);
            Interlocked.Exchange(ref forceSnapshot, 1);
        }

        private void ConnectionLoop()
        {
            while (true)
            {
                TcpClient connectedClient = null;
                NetworkStream connectedStream = null;

                try
                {
                    BridgeManifest endpoint = ReloadManifest();
                    connectedClient = Connect(endpoint);
                    connectedStream = connectedClient.GetStream();
                    connectedClient.NoDelay = true;

                    lock (connectionGate)
                    {
                        client = connectedClient;
                        stream = connectedStream;
                        connectionReady = false;
                        connectionGeneration++;
                    }

                    SendHello(
                        ProtocolFactory.Hello(
                            endpoint.protocol,
                            endpoint.token,
                            endpoint.app_id,
                            sessionId,
                            endpoint.trainer_sha256,
                            menuReader.UiFingerprint),
                        connectedClient,
                        connectedStream);

                    while (true)
                    {
                        string json = ReadFrame(connectedStream);
                        object decoded = JsonCodec.DeserializeObject(json);
                        IDictionary<string, object> message =
                            decoded as IDictionary<string, object>;
                        if (message != null)
                        {
                            HandleInbound(message);
                        }
                    }
                }
                catch (Exception ex)
                {
                    BridgeLog.Write(
                        "Bridge connection closed: "
                        + ex.GetType().Name
                        + ": "
                        + ex.Message);
                }
                finally
                {
                    ClearConnection(connectedClient);
                    if (connectedStream != null)
                    {
                        try
                        {
                            connectedStream.Dispose();
                        }
                        catch
                        {
                        }
                    }

                    if (connectedClient != null)
                    {
                        try
                        {
                            connectedClient.Close();
                        }
                        catch
                        {
                        }
                    }
                }

                Thread.Sleep(1000);
            }
        }

        private BridgeManifest ReloadManifest()
        {
            BridgeManifest refreshed = BridgeManifest.Load(
                manifestPath,
                false);
            if (refreshed.app_id != appId
                || !string.Equals(
                    refreshed.trainer_sha256 ?? string.Empty,
                    trainerSha256,
                    StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "Reloaded bridge manifest changed trainer identity.");
            }

            if (refreshed.maxFrameBytes != manifest.maxFrameBytes)
            {
                throw new InvalidDataException(
                    "Reloaded bridge manifest changed maxFrameBytes.");
            }

            manifest = refreshed;
            return refreshed;
        }

        private TcpClient Connect(BridgeManifest endpoint)
        {
            TcpClient next = new TcpClient(AddressFamily.InterNetwork);
            IAsyncResult result = null;
            try
            {
                result = next.BeginConnect(
                    IPAddress.Loopback,
                    endpoint.port,
                    null,
                    null);
                if (!result.AsyncWaitHandle.WaitOne(
                        endpoint.connectTimeoutMs,
                        false))
                {
                    throw new TimeoutException("Loopback connection timed out.");
                }

                next.EndConnect(result);
                return next;
            }
            catch
            {
                next.Close();
                throw;
            }
            finally
            {
                if (result != null)
                {
                    try
                    {
                        result.AsyncWaitHandle.Close();
                    }
                    catch
                    {
                    }
                }
            }
        }

        private void HandleInbound(IDictionary<string, object> message)
        {
            string messageType = ReadString(message, "type");
            if (string.Equals(
                    messageType,
                    "hello_ack",
                    StringComparison.Ordinal))
            {
                if (!string.Equals(
                        ReadString(message, "session_id"),
                        sessionId,
                        StringComparison.Ordinal))
                {
                    return;
                }
                long acknowledgedProtocol;
                if (!TryReadInt64(
                        message,
                        "protocol",
                        out acknowledgedProtocol)
                    || acknowledgedProtocol != manifest.protocol)
                {
                    return;
                }

                bool accepted = false;
                lock (connectionGate)
                {
                    if (stream != null)
                    {
                        connectionReady = true;
                        accepted = true;
                    }
                }
                if (accepted)
                {
                    Interlocked.Exchange(ref forceSnapshot, 1);
                }
                return;
            }

            bool toggleCommand = string.Equals(
                messageType,
                "command",
                StringComparison.Ordinal);
            bool valueCommand = string.Equals(
                messageType,
                "value_command",
                StringComparison.Ordinal);
            bool actionCommand = string.Equals(
                messageType,
                "action_command",
                StringComparison.Ordinal);
            if (!toggleCommand && !valueCommand && !actionCommand)
            {
                return;
            }

            if (!string.Equals(
                    ReadString(message, "session_id"),
                    sessionId,
                    StringComparison.Ordinal))
            {
                return;
            }

            int commandGeneration = GetConnectionGeneration();
            if (commandGeneration <= 0)
            {
                return;
            }

            string requestId = ReadString(message, "request_id");
            string optionId = ReadString(message, "option_id");
            long expectedRevision;
            if (!TryReadInt64(
                    message,
                    "expected_bridge_revision",
                    out expectedRevision)
                || expectedRevision != Interlocked.Read(
                    ref lastPublishedRevision))
            {
                TrySend(
                    ProtocolFactory.CommandError(
                        manifest.token,
                        sessionId,
                        requestId,
                        "bridge revision changed"),
                    commandGeneration);
                return;
            }

            bool desired = false;
            string desiredValue = null;
            string expectedValue = null;
            if (toggleCommand)
            {
                if (!TryReadBoolean(message, "desired", out desired))
                {
                    TrySend(
                        ProtocolFactory.CommandError(
                            manifest.token,
                            sessionId,
                            requestId,
                            "missing desired state"),
                        commandGeneration);
                    return;
                }
            }
            else if (valueCommand)
            {
                if (!TryReadExactString(message, "value", out desiredValue))
                {
                    TrySend(
                        ProtocolFactory.CommandError(
                            manifest.token,
                            sessionId,
                            requestId,
                            "missing value"),
                        commandGeneration);
                    return;
                }
                if (!TryReadExactString(
                        message,
                        "expected_value",
                        out expectedValue))
                {
                    TrySend(
                        ProtocolFactory.CommandError(
                            manifest.token,
                            sessionId,
                            requestId,
                            "missing expected value"),
                        commandGeneration);
                    return;
                }
            }

            if (Interlocked.CompareExchange(
                    ref commandInFlight,
                    1,
                    0) != 0)
            {
                TrySend(
                    ProtocolFactory.CommandError(
                        manifest.token,
                        sessionId,
                        requestId,
                        "another trainer UI command is still running"),
                    commandGeneration);
                return;
            }

            try
            {
                Action<CommandResult> completion = delegate(
                    CommandResult result)
                {
                    if (!ThreadPool.QueueUserWorkItem(
                            delegate
                            {
                                CompleteCommand(
                                    commandGeneration,
                                    requestId,
                                    result);
                            }))
                    {
                        Interlocked.Exchange(ref commandInFlight, 0);
                        BridgeLog.Write(
                            "UI command response could not be queued.");
                    }
                };

                if (toggleCommand)
                {
                    menuReader.BeginExecuteDesired(
                        optionId,
                        desired,
                        completion);
                }
                else if (valueCommand)
                {
                    menuReader.BeginExecuteValue(
                        optionId,
                        desiredValue,
                        expectedValue,
                        completion);
                }
                else
                {
                    menuReader.BeginExecuteAction(optionId, completion);
                }

                BridgeLog.Write(
                    "UI command queued: request_id="
                    + requestId
                    + " option_id="
                    + optionId
                    + ".");
            }
            catch (Exception ex)
            {
                Interlocked.Exchange(ref commandInFlight, 0);
                Exception cause = ex is TargetInvocationException
                    && ex.InnerException != null
                        ? ex.InnerException
                        : ex;
                TrySend(
                    ProtocolFactory.CommandError(
                        manifest.token,
                        sessionId,
                        requestId,
                        "trainer UI dispatch failed: " + cause.Message),
                    commandGeneration);
            }
        }

        private void CompleteCommand(
            int commandGeneration,
            string requestId,
            CommandResult result)
        {
            try
            {
                Interlocked.Exchange(ref forceSnapshot, 1);
                if (result == null)
                {
                    result = new CommandResult
                    {
                        status = "rejected",
                        error = "trainer UI command returned no result"
                    };
                }

                BridgeLog.Write(
                    "UI command completed: request_id="
                    + requestId
                    + " status="
                    + (result.status ?? string.Empty)
                    + ".");

                if (IsAcceptedCommandResult(result))
                {
                    TrySend(
                        ProtocolFactory.CommandAccepted(
                            manifest.token,
                            sessionId,
                            requestId,
                            result),
                        commandGeneration);
                }
                else
                {
                    TrySend(
                        ProtocolFactory.CommandError(
                            manifest.token,
                            sessionId,
                            requestId,
                            result.error),
                        commandGeneration);
                }
            }
            catch (Exception ex)
            {
                BridgeLog.Write(
                    "UI command response failed: "
                    + ex.GetType().Name
                    + ": "
                    + ex.Message);
            }
            finally
            {
                Interlocked.Exchange(ref commandInFlight, 0);
            }
        }

        private static bool IsAcceptedCommandResult(CommandResult result)
        {
            return string.Equals(
                    result.status,
                    "queued",
                    StringComparison.Ordinal)
                || string.Equals(
                    result.status,
                    "noop",
                    StringComparison.Ordinal)
                || string.Equals(
                    result.status,
                    "applied",
                    StringComparison.Ordinal)
                || string.Equals(
                    result.status,
                    "staged",
                    StringComparison.Ordinal);
        }

        private void PollLoop()
        {
            int observedGeneration = -1;
            string previousFingerprint = null;

            while (true)
            {
                try
                {
                    MenuSnapshot snapshot = menuReader.Capture();
                    int generation = GetConnectionGeneration();
                    if (generation > 0)
                    {
                        string currentStructure = BuildStructureFingerprint(snapshot);
                        bool publishFull = generation != observedGeneration
                            || !string.Equals(
                                previousFingerprint,
                                currentStructure,
                                StringComparison.Ordinal)
                            || Interlocked.Exchange(
                                ref forceSnapshot,
                                0) == 1;

                        if (publishFull)
                        {
                            long revision = NextSequence();
                            Interlocked.Exchange(
                                ref lastPublishedRevision,
                                revision);
                            if (TrySend(
                                    ProtocolFactory.Snapshot(
                                        manifest.token,
                                        sessionId,
                                        revision,
                                        snapshot),
                                    generation))
                            {
                                observedGeneration = generation;
                                previousFingerprint = currentStructure;
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    BridgeLog.Write(
                        "State poll failed: "
                        + ex.GetType().Name
                        + ": "
                        + ex.Message);
                }

                Thread.Sleep(manifest.pollIntervalMs);
            }
        }

        private void HeartbeatLoop()
        {
            while (true)
            {
                try
                {
                    int generation = GetConnectionGeneration();
                    if (generation > 0)
                    {
                        TrySend(
                            ProtocolFactory.Heartbeat(
                                manifest.token,
                                sessionId),
                            generation);
                    }
                }
                catch (Exception ex)
                {
                    BridgeLog.Write(
                        "Heartbeat failed: "
                        + ex.GetType().Name
                        + ": "
                        + ex.Message);
                }

                Thread.Sleep(HeartbeatIntervalMilliseconds);
            }
        }

        private bool TrySend(object message, int expectedGeneration)
        {
            byte[] payload;
            byte[] header;
            try
            {
                payload = SerializeMessage(message);
                header = BuildFrameHeader(payload.Length);
            }
            catch (Exception ex)
            {
                BridgeLog.Write(
                    "Bridge frame serialization failed: "
                    + ex.GetType().Name
                    + ": "
                    + ex.Message);
                return false;
            }

            TcpClient destinationClient;
            NetworkStream destination;
            Exception writeError = null;
            lock (writeGate)
            {
                lock (connectionGate)
                {
                    if (stream == null
                        || client == null
                        || !connectionReady
                        || connectionGeneration != expectedGeneration)
                    {
                        return false;
                    }

                    destinationClient = client;
                    destination = stream;
                }

                try
                {
                    WriteFrame(destination, header, payload);
                }
                catch (Exception ex)
                {
                    writeError = ex;
                }
            }

            if (writeError == null)
            {
                return true;
            }

            BridgeLog.Write(
                "Bridge send failed: "
                + writeError.GetType().Name
                + ": "
                + writeError.Message);
            InvalidateConnection(destinationClient);
            return false;
        }

        private void SendHello(
            object message,
            TcpClient expectedClient,
            NetworkStream expectedStream)
        {
            byte[] payload = SerializeMessage(message);
            byte[] header = BuildFrameHeader(payload.Length);

            lock (writeGate)
            {
                lock (connectionGate)
                {
                    if (!object.ReferenceEquals(client, expectedClient)
                        || !object.ReferenceEquals(stream, expectedStream))
                    {
                        throw new IOException(
                            "Bridge connection changed before hello.");
                    }
                }

                WriteFrame(expectedStream, header, payload);
            }
        }

        private byte[] SerializeMessage(object message)
        {
            string json = JsonCodec.Serialize(message);
            byte[] payload = new UTF8Encoding(false).GetBytes(json);
            if (payload.Length > manifest.maxFrameBytes)
            {
                throw new InvalidDataException(
                    "Outgoing JSON frame exceeds maxFrameBytes.");
            }

            return payload;
        }

        private static byte[] BuildFrameHeader(int payloadLength)
        {
            return new[]
            {
                (byte)(payloadLength & 0xff),
                (byte)((payloadLength >> 8) & 0xff),
                (byte)((payloadLength >> 16) & 0xff),
                (byte)((payloadLength >> 24) & 0xff)
            };
        }

        private static void WriteFrame(
            Stream destination,
            byte[] header,
            byte[] payload)
        {
            destination.Write(header, 0, header.Length);
            destination.Write(payload, 0, payload.Length);
            destination.Flush();
        }

        private string ReadFrame(Stream source)
        {
            byte[] header = ReadExact(source, 4);
            int length = header[0]
                | (header[1] << 8)
                | (header[2] << 16)
                | (header[3] << 24);
            if (length < 2 || length > manifest.maxFrameBytes)
            {
                throw new InvalidDataException(
                    "Invalid incoming JSON frame length: "
                    + length.ToString(CultureInfo.InvariantCulture));
            }

            byte[] payload = ReadExact(source, length);
            return new UTF8Encoding(false, true).GetString(payload);
        }

        private static byte[] ReadExact(Stream source, int length)
        {
            byte[] buffer = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int read = source.Read(buffer, offset, length - offset);
                if (read <= 0)
                {
                    throw new EndOfStreamException(
                        "Bridge connection closed during a frame.");
                }

                offset += read;
            }

            return buffer;
        }

        private int GetConnectionGeneration()
        {
            lock (connectionGate)
            {
                return stream == null || !connectionReady
                    ? 0
                    : connectionGeneration;
            }
        }

        private void ClearConnection(TcpClient expected)
        {
            lock (connectionGate)
            {
                if (object.ReferenceEquals(client, expected))
                {
                    client = null;
                    stream = null;
                    connectionReady = false;
                }
            }
        }

        private void InvalidateConnection(TcpClient expected)
        {
            TcpClient current;
            lock (connectionGate)
            {
                if (!object.ReferenceEquals(client, expected))
                {
                    return;
                }

                current = expected;
                client = null;
                stream = null;
                connectionReady = false;
            }

            if (current != null)
            {
                try
                {
                    current.Close();
                }
                catch
                {
                }
            }
        }

        private long NextSequence()
        {
            return Interlocked.Increment(ref sequence);
        }

        private static string BuildStateKey(TrainerOption option)
        {
            string toggled = option.active.HasValue
                ? (option.active.Value ? "1" : "0")
                : "?";
            return toggled
                + "|"
                + (option.controllable ? "1" : "0")
                + "|"
                + (option.action_controllable ? "1" : "0")
                + "|"
                + (option.value_controllable ? "1" : "0")
                + "|"
                + (option.value_type ?? string.Empty)
                + "|"
                + (option.value_apply_mode ?? string.Empty)
                + "|"
                + (option.value ?? string.Empty);
        }

        private static string BuildStructureFingerprint(MenuSnapshot snapshot)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append(snapshot.gameRunning ? "1\n" : "0\n");

            for (int index = 0; index < snapshot.options.Count; index++)
            {
                TrainerOption option = snapshot.options[index];
                builder.Append("O|");
                builder.Append(option.id);
                builder.Append('|');
                builder.Append(option.kind);
                builder.Append('|');
                AppendTexts(builder, option.labels);
                AppendTexts(builder, option.tooltips);
                AppendTexts(builder, option.group);
                builder.Append(option.tooltip_style);
                builder.Append('|');
                builder.Append(
                    option.minimum.HasValue
                        ? option.minimum.Value.ToString(
                            "R",
                            CultureInfo.InvariantCulture)
                        : string.Empty);
                builder.Append('|');
                builder.Append(
                    option.maximum.HasValue
                        ? option.maximum.Value.ToString(
                            "R",
                            CultureInfo.InvariantCulture)
                        : string.Empty);
                builder.Append('|');
                builder.Append(
                    option.step.HasValue
                        ? option.step.Value.ToString(
                            "R",
                            CultureInfo.InvariantCulture)
                        : string.Empty);
                builder.Append('|');
                builder.Append(BuildStateKey(option));
                builder.Append('\n');
            }

            return builder.ToString();
        }

        private static void AppendTexts(
            StringBuilder builder,
            IDictionary<string, string> values)
        {
            string[] keys = { "zh_cn", "zh_tw", "en", "current" };
            for (int index = 0; index < keys.Length; index++)
            {
                string value;
                if (values.TryGetValue(keys[index], out value))
                {
                    builder.Append(keys[index]);
                    builder.Append('=');
                    builder.Append(value);
                    builder.Append(';');
                }
            }
        }

        private static string ReadString(
            IDictionary<string, object> message,
            string key)
        {
            object value;
            return message.TryGetValue(key, out value) && value != null
                ? Convert.ToString(value, CultureInfo.InvariantCulture)
                : null;
        }

        private static bool TryReadBoolean(
            IDictionary<string, object> message,
            string key,
            out bool value)
        {
            object raw;
            if (message.TryGetValue(key, out raw) && raw is bool)
            {
                value = (bool)raw;
                return true;
            }

            value = false;
            return false;
        }

        private static bool TryReadExactString(
            IDictionary<string, object> message,
            string key,
            out string value)
        {
            object raw;
            if (message.TryGetValue(key, out raw) && raw is string)
            {
                value = (string)raw;
                return true;
            }

            value = null;
            return false;
        }

        private static bool TryReadInt64(
            IDictionary<string, object> message,
            string key,
            out long value)
        {
            object raw;
            if (message.TryGetValue(key, out raw) && raw != null)
            {
                try
                {
                    value = Convert.ToInt64(
                        raw,
                        CultureInfo.InvariantCulture);
                    return true;
                }
                catch
                {
                }
            }

            value = 0;
            return false;
        }
    }
}
