using System;
using System.IO;
using System.Security.Cryptography;
using TrainerDeckBridge.Protocol;

namespace TrainerDeckBridgeLauncher
{
    internal sealed class PreparedTrainer
    {
        public string OriginalPath { get; set; }

        public string PreparedPath { get; set; }

        public string WorkingDirectory { get; set; }
    }

    internal static class TrainerPreparer
    {
        private const string BridgeFileName = "TrainerDeckBridge.dll";

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

            string cacheDirectory = Path.Combine(
                cacheRoot,
                trainerHash.Substring(0, 16));
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
                Path.GetFileNameWithoutExtension(originalPath)
                    + ".trainerdeck-staging-"
                    + Guid.NewGuid().ToString("N")
                    + ".exe");

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
                string bridgeAssemblyPath = Path.Combine(
                    launcherDirectory,
                    BridgeFileName);
                if (!File.Exists(bridgeAssemblyPath))
                {
                    throw new FileNotFoundException(
                        "TrainerDeckBridge.dll is required.",
                        bridgeAssemblyPath);
                }

                byte[] patchedUi = UiAssemblyPatcher.InjectBridgeStart(
                    decryptedUi,
                    bridgeAssemblyPath);
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

                File.Copy(stagingPath, preparedPath, true);
                File.Copy(
                    bridgeAssemblyPath,
                    cachedBridgePath,
                    true);
                File.Copy(
                    manifestPath,
                    cachedManifestPath,
                    true);

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
                WorkingDirectory = Path.GetDirectoryName(originalPath)
            };
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
