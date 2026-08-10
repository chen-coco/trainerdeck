using System;
using System.IO;
using TrainerDeckBridge;

namespace TrainerDeckBridge.Protocol
{
    internal sealed class BridgeManifest
    {
        public int protocol { get; set; }

        public string host { get; set; }

        public int port { get; set; }

        public string token { get; set; }

        public long app_id { get; set; }

        public string trainer_sha256 { get; set; }

        public string trainer { get; set; }

        public string trainer_relative { get; set; }

        public string cacheDirectory { get; set; }

        public int pollIntervalMs { get; set; }

        public int connectTimeoutMs { get; set; }

        public int maxFrameBytes { get; set; }

        public string resourceType { get; set; }

        public int resourceId { get; set; }

        public int resourceLanguage { get; set; }

        public static BridgeManifest Load(string path, bool requireTrainer)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(path))
            {
                throw new ArgumentException("Manifest path is required.", "path");
            }

            string json = File.ReadAllText(path);
            if (json.Length > 4 * 1024 * 1024)
            {
                throw new InvalidDataException(
                    "The bridge manifest exceeds the 4 MiB limit.");
            }
            BridgeManifest manifest = JsonCodec.Deserialize<BridgeManifest>(
                json);
            if (manifest == null)
            {
                throw new InvalidDataException("The bridge manifest is empty.");
            }

            manifest.ApplyDefaults();
            manifest.Validate(requireTrainer);
            return manifest;
        }

        private void ApplyDefaults()
        {
            if (protocol == 0)
            {
                protocol = 1;
            }

            if (FrameworkCompat.IsNullOrWhiteSpace(host))
            {
                host = "127.0.0.1";
            }

            if (pollIntervalMs == 0)
            {
                pollIntervalMs = 250;
            }

            if (connectTimeoutMs == 0)
            {
                connectTimeoutMs = 3000;
            }

            if (maxFrameBytes == 0)
            {
                maxFrameBytes = 1024 * 1024;
            }

            if (FrameworkCompat.IsNullOrWhiteSpace(resourceType))
            {
                resourceType = "UI";
            }

            if (resourceId == 0)
            {
                resourceId = 101;
            }
        }

        private void Validate(bool requireTrainer)
        {
            if (protocol != 1)
            {
                throw new InvalidDataException("Unsupported bridge protocol: " + protocol);
            }

            if (!string.Equals(host, "127.0.0.1", StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "The bridge endpoint must be exactly 127.0.0.1.");
            }

            if (port < 1 || port > 65535)
            {
                throw new InvalidDataException("Bridge port must be between 1 and 65535.");
            }

            if (FrameworkCompat.IsNullOrWhiteSpace(token) || token.Length < 16)
            {
                throw new InvalidDataException(
                    "Bridge token must contain at least 16 characters.");
            }

            if (pollIntervalMs < 100 || pollIntervalMs > 5000)
            {
                throw new InvalidDataException(
                    "pollIntervalMs must be between 100 and 5000.");
            }

            if (connectTimeoutMs < 250 || connectTimeoutMs > 30000)
            {
                throw new InvalidDataException(
                    "connectTimeoutMs must be between 250 and 30000.");
            }

            if (maxFrameBytes < 1024 || maxFrameBytes > 16 * 1024 * 1024)
            {
                throw new InvalidDataException(
                    "maxFrameBytes must be between 1024 and 16777216.");
            }

            if (requireTrainer && FrameworkCompat.IsNullOrWhiteSpace(trainer))
            {
                if (FrameworkCompat.IsNullOrWhiteSpace(trainer_relative))
                {
                    throw new InvalidDataException(
                        "Manifest trainer_relative path is required.");
                }
            }

            if (app_id <= 0 || app_id > uint.MaxValue)
            {
                throw new InvalidDataException(
                    "Manifest app_id must be between 1 and 4294967295.");
            }

            if (!FrameworkCompat.IsNullOrWhiteSpace(trainer_sha256)
                && (trainer_sha256.Length != 64
                    || !IsLowercaseHex(trainer_sha256)))
            {
                throw new InvalidDataException(
                    "trainer_sha256 must be 64 lowercase hexadecimal characters.");
            }

            if (resourceId < 1 || resourceId > 65535)
            {
                throw new InvalidDataException("resourceId must be between 1 and 65535.");
            }

            if (resourceLanguage < 0 || resourceLanguage > 65535)
            {
                throw new InvalidDataException(
                    "resourceLanguage must be between 0 and 65535.");
            }
        }

        public string TrainerPath
        {
            get
            {
                return !FrameworkCompat.IsNullOrWhiteSpace(trainer_relative)
                    ? trainer_relative
                    : trainer;
            }
        }

        private static bool IsLowercaseHex(string value)
        {
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                if (!((character >= '0' && character <= '9')
                    || (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }
    }
}
