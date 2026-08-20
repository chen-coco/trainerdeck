using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using TrainerDeckBridge;
using TrainerDeckBridge.Protocol;

namespace TrainerDeckBridgeLauncher
{
    internal sealed class PreparedTrainer
    {
        public string OriginalPath { get; set; }

        public string PreparedPath { get; set; }

        public string WorkingDirectory { get; set; }

        public string RuntimeLabel { get; set; }

        public string RuntimeVersion { get; set; }

        public string PayloadName { get; set; }
    }

    internal sealed class BridgePayload
    {
        public string ResourceName { get; set; }

        public byte[] Data { get; set; }
    }

    internal static class TrainerPreparer
    {
        private const string BridgeFileName = "TrainerDeckBridge.dll";
        private const string Clr2BridgeResourceName =
            "TrainerDeckBridge.Clr2.dll";
        private const string Clr4BridgeResourceName =
            "TrainerDeckBridge.Clr4.dll";

        private static readonly byte[] StandardMzFirst32 =
        {
            0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00,
            0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00,
            0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        };

        public static PreparedTrainer Prepare(
            string manifestPath,
            BridgeManifest manifest)
        {
            string launcherDirectory = Path.GetDirectoryName(
                Path.GetFullPath(manifestPath));
            string originalPath = ResolvePath(
                launcherDirectory,
                manifest.TrainerPath);
            if (!File.Exists(originalPath))
            {
                throw new FileNotFoundException(
                    "Trainer executable was not found.",
                    originalPath);
            }

            if (!string.Equals(
                    Path.GetExtension(originalPath),
                    ".exe",
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "Manifest trainer must point to an .exe file.");
            }

            string cacheRoot = ResolveCacheRoot(
                launcherDirectory,
                manifest.cacheDirectory);
            string trainerHash = ComputeSha256(originalPath);
            if (!string.IsNullOrWhiteSpace(manifest.trainer_sha256)
                && !string.Equals(
                    trainerHash,
                    manifest.trainer_sha256,
                    StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "The trainer SHA-256 no longer matches the prepared manifest.");
            }

            string tokenHash = ComputeSha256Text(manifest.token);
            string cacheDirectory = Path.Combine(
                cacheRoot,
                trainerHash.Substring(0, 16)
                    + "-a"
                    + manifest.app_id.ToString(
                        CultureInfo.InvariantCulture)
                    + "-s"
                    + tokenHash.Substring(0, 16));
            Directory.CreateDirectory(cacheDirectory);
            TryHide(cacheDirectory);

            string preparedPath = Path.Combine(
                cacheDirectory,
                Path.GetFileName(originalPath));
            if (string.Equals(
                    Path.GetFullPath(preparedPath),
                    Path.GetFullPath(originalPath),
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Prepared trainer path resolves to the original executable.");
            }

            string stagingPath = Path.Combine(
                cacheDirectory,
                ".td-"
                    + Guid.NewGuid().ToString("N").Substring(0, 16)
                    + ".tmp");
            ManagedRuntimeInfo selectedRuntime = null;
            BridgePayload selectedPayload = null;

            try
            {
                File.Copy(originalPath, stagingPath, false);
                PeResource encryptedUi = PeUiResource.Read(
                    originalPath,
                    manifest.resourceType,
                    manifest.resourceId,
                    manifest.resourceLanguage);
                byte[] xorKey = DeriveXorKey(encryptedUi.Data);
                byte[] decryptedUi = ApplyXor(encryptedUi.Data, xorKey);
                EnsureMz(decryptedUi);
                selectedRuntime = UiAssemblyPatcher.InspectRuntime(
                    decryptedUi,
                    "Trainer UI");
                selectedPayload = ReadEmbeddedBridgePayload(
                    selectedRuntime);
                LauncherLog.Write(
                    "Bridge payload selected: runtime="
                    + selectedRuntime.RuntimeLabel
                    + " runtime_version=\""
                    + selectedRuntime.RuntimeVersion
                    + "\" mscorlib_major="
                    + selectedRuntime.MscorlibMajor
                    + " payload=\""
                    + selectedPayload.ResourceName
                    + "\".");

                byte[] patchedUi = UiAssemblyPatcher.InjectBridgeStart(
                    decryptedUi,
                    selectedPayload.Data,
                    selectedRuntime.Runtime);
                EnsureMz(patchedUi);
                byte[] encryptedPatchedUi = ApplyXor(patchedUi, xorKey);
                PeUiResource.Replace(
                    stagingPath,
                    manifest.resourceType,
                    manifest.resourceId,
                    encryptedUi.Language,
                    encryptedPatchedUi);

                string cachedBridgePath = Path.Combine(
                    cacheDirectory,
                    BridgeFileName);
                string cachedManifestPath = Path.Combine(
                    cacheDirectory,
                    "trainerdeck-bridge.json");

                ClearCacheFileOverwriteAttributes(preparedPath);
                ClearCacheFileOverwriteAttributes(cachedBridgePath);
                ClearCacheFileOverwriteAttributes(cachedManifestPath);

                PublishCacheFile(stagingPath, preparedPath);
                AtomicWriteBytes(
                    cachedBridgePath,
                    selectedPayload.Data);
                AtomicWriteText(
                    cachedManifestPath,
                    JsonCodec.Serialize(manifest));

                LauncherLog.Write(
                    "Bridge payload cached: runtime="
                    + selectedRuntime.RuntimeLabel
                    + " payload=\""
                    + selectedPayload.ResourceName
                    + "\" cached_as=\""
                    + cachedBridgePath
                    + "\".");

                TryHide(preparedPath);
                TryHide(cachedBridgePath);
                TryHide(cachedManifestPath);
            }
            finally
            {
                if (File.Exists(stagingPath))
                {
                    try
                    {
                        File.Delete(stagingPath);
                    }
                    catch
                    {
                    }
                }
            }

            return new PreparedTrainer
            {
                OriginalPath = originalPath,
                PreparedPath = preparedPath,
                WorkingDirectory = Path.GetDirectoryName(originalPath),
                RuntimeLabel = selectedRuntime.RuntimeLabel,
                RuntimeVersion = selectedRuntime.RuntimeVersion,
                PayloadName = selectedPayload.ResourceName
            };
        }

        private static BridgePayload ReadEmbeddedBridgePayload(
            ManagedRuntimeInfo selectedRuntime)
        {
            if (selectedRuntime == null)
            {
                throw new ArgumentNullException("selectedRuntime");
            }

            string resourceName = selectedRuntime.Runtime == BridgeRuntime.Clr2
                ? Clr2BridgeResourceName
                : Clr4BridgeResourceName;
            Assembly launcherAssembly = typeof(TrainerPreparer).Assembly;
            using (Stream resource =
                launcherAssembly.GetManifestResourceStream(resourceName))
            {
                if (resource == null)
                {
                    throw new InvalidDataException(
                        "Embedded bridge payload is missing: "
                        + resourceName
                        + ".");
                }

                using (MemoryStream copy = new MemoryStream())
                {
                    resource.CopyTo(copy);
                    byte[] data = copy.ToArray();
                    if (data.Length == 0)
                    {
                        throw new InvalidDataException(
                            "Embedded bridge payload is empty: "
                            + resourceName
                            + ".");
                    }

                    ManagedRuntimeInfo payloadRuntime =
                        UiAssemblyPatcher.InspectRuntime(
                            data,
                            "Embedded bridge payload " + resourceName);
                    if (payloadRuntime.Runtime != selectedRuntime.Runtime)
                    {
                        throw new InvalidDataException(
                            "Embedded bridge payload "
                            + resourceName
                            + " has runtime "
                            + payloadRuntime.RuntimeLabel
                            + ", expected "
                            + selectedRuntime.RuntimeLabel
                            + ".");
                    }

                    return new BridgePayload
                    {
                        ResourceName = resourceName,
                        Data = data
                    };
                }
            }
        }

        private static byte[] DeriveXorKey(byte[] encryptedUi)
        {
            if (encryptedUi == null
                || encryptedUi.Length < StandardMzFirst32.Length)
            {
                throw new InvalidDataException(
                    "UI/101 is too short to derive its XOR key.");
            }

            byte[] key = new byte[StandardMzFirst32.Length];
            for (int index = 0; index < key.Length; index++)
            {
                key[index] = (byte)(
                    encryptedUi[index] ^ StandardMzFirst32[index]);
            }

            return key;
        }

        private static byte[] ApplyXor(byte[] source, byte[] key)
        {
            byte[] result = new byte[source.Length];
            for (int index = 0; index < source.Length; index++)
            {
                result[index] = (byte)(
                    source[index] ^ key[index % key.Length]);
            }

            return result;
        }

        private static void EnsureMz(byte[] assembly)
        {
            if (assembly == null
                || assembly.Length < 2
                || assembly[0] != 0x4d
                || assembly[1] != 0x5a)
            {
                throw new InvalidDataException(
                    "Decrypted UI/101 is not an MZ assembly. "
                    + "This trainer uses an unsupported resource format.");
            }
        }

        private static string ResolveCacheRoot(
            string launcherDirectory,
            string configured)
        {
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return ResolvePath(launcherDirectory, configured);
            }

            string local = Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(local))
            {
                local = Path.GetTempPath();
            }

            return Path.Combine(
                local,
                "TrainerDeck",
                "BridgeCache");
        }

        private static string ResolvePath(string baseDirectory, string path)
        {
            string combined = Path.IsPathRooted(path)
                ? path
                : Path.Combine(baseDirectory, path);
            return Path.GetFullPath(combined);
        }

        public static string ResolveOriginalTrainer(
            string manifestPath,
            BridgeManifest manifest)
        {
            string launcherDirectory = Path.GetDirectoryName(
                Path.GetFullPath(manifestPath));
            return ResolvePath(launcherDirectory, manifest.TrainerPath);
        }

        private static string ComputeSha256(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(path))
            {
                byte[] hash = sha.ComputeHash(stream);
                return BitConverter.ToString(hash)
                    .Replace("-", string.Empty)
                    .ToLowerInvariant();
            }
        }

        private static string ComputeSha256Text(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
            using (SHA256 sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(bytes))
                    .Replace("-", string.Empty)
                    .ToLowerInvariant();
            }
        }

        private static void AtomicWriteBytes(string path, byte[] data)
        {
            string staging = CreateShortStagingPath(path);
            try
            {
                File.WriteAllBytes(staging, data);
                PublishCacheFile(staging, path);
            }
            finally
            {
                TryDelete(staging);
            }
        }

        private static void AtomicWriteText(string path, string value)
        {
            string staging = CreateShortStagingPath(path);
            try
            {
                File.WriteAllText(
                    staging,
                    value,
                    new UTF8Encoding(false));
                PublishCacheFile(staging, path);
            }
            finally
            {
                TryDelete(staging);
            }
        }

        private static string CreateShortStagingPath(string destination)
        {
            return Path.Combine(
                Path.GetDirectoryName(destination),
                ".td-"
                    + Guid.NewGuid().ToString("N").Substring(0, 16)
                    + ".tmp");
        }

        private static void PublishCacheFile(
            string staging,
            string destination)
        {
            if (File.Exists(destination))
            {
                EnsureSameCacheFile(staging, destination);
                TryDelete(staging);
                return;
            }

            try
            {
                File.Move(staging, destination);
            }
            catch (IOException)
            {
                // A second Host using the same immutable session generation
                // may win the first publish. Its files describe the same
                // trainer hash, AppID, and token, so the existing destination
                // is authoritative and safe to reuse.
                if (!File.Exists(destination))
                {
                    throw;
                }

                EnsureSameCacheFile(staging, destination);
            }
        }

        private static void EnsureSameCacheFile(
            string staging,
            string destination)
        {
            FileInfo staged = new FileInfo(staging);
            FileInfo published = new FileInfo(destination);
            if (staged.Length != published.Length)
            {
                throw new InvalidDataException(
                    "Immutable TrainerDeck cache generation conflict: "
                    + destination);
            }

            using (FileStream left = File.OpenRead(staging))
            using (FileStream right = File.OpenRead(destination))
            {
                byte[] leftBuffer = new byte[64 * 1024];
                byte[] rightBuffer = new byte[leftBuffer.Length];
                int leftCount;
                while ((leftCount = left.Read(
                    leftBuffer,
                    0,
                    leftBuffer.Length)) > 0)
                {
                    int rightCount = right.Read(
                        rightBuffer,
                        0,
                        rightBuffer.Length);
                    if (leftCount != rightCount)
                    {
                        throw new InvalidDataException(
                            "Immutable TrainerDeck cache generation conflict: "
                            + destination);
                    }

                    for (int index = 0; index < leftCount; index++)
                    {
                        if (leftBuffer[index] != rightBuffer[index])
                        {
                            throw new InvalidDataException(
                                "Immutable TrainerDeck cache generation conflict: "
                                + destination);
                        }
                    }
                }
            }
        }

        private static void TryDelete(string path)
        {
            if (!File.Exists(path))
            {
                return;
            }

            try
            {
                File.Delete(path);
            }
            catch
            {
            }
        }

        private static void ClearCacheFileOverwriteAttributes(string path)
        {
            if (!File.Exists(path))
            {
                return;
            }

            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                FileAttributes cleared = attributes
                    & ~FileAttributes.Hidden
                    & ~FileAttributes.ReadOnly;
                if (cleared != attributes)
                {
                    File.SetAttributes(path, cleared);
                }
            }
            catch (Exception exception)
            {
                throw new IOException(
                    "Failed to clear overwrite-blocking attributes from "
                    + "TrainerDeck cache file: "
                    + path,
                    exception);
            }
        }

        private static void TryHide(string path)
        {
            try
            {
                FileAttributes attributes = File.GetAttributes(path);
                File.SetAttributes(path, attributes | FileAttributes.Hidden);
            }
            catch
            {
                // Wine and some Linux-backed filesystems may not preserve the
                // Windows hidden attribute. The dedicated cache still applies.
            }
        }
    }
}
