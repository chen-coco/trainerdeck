using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace TrainerDeckBridgeLauncher
{
    internal sealed class PeResource
    {
        public byte[] Data { get; set; }

        public ushort Language { get; set; }
    }

    internal static class PeUiResource
    {
        private const uint LoadLibraryAsDataFile = 0x00000002;
        private const uint LoadLibraryAsImageResource = 0x00000020;

        private delegate bool EnumResourceLanguagesCallback(
            IntPtr module,
            string resourceType,
            IntPtr resourceName,
            ushort language,
            IntPtr parameter);

        public static PeResource Read(
            string executablePath,
            string resourceType,
            int resourceId,
            int configuredLanguage)
        {
            IntPtr module = LoadLibraryEx(
                executablePath,
                IntPtr.Zero,
                LoadLibraryAsDataFile | LoadLibraryAsImageResource);
            if (module == IntPtr.Zero)
            {
                throw LastError("LoadLibraryEx failed for the trainer.");
            }

            try
            {
                ushort language = configuredLanguage == 0
                    ? FindFirstLanguage(module, resourceType, resourceId)
                    : checked((ushort)configuredLanguage);
                IntPtr info = FindResourceEx(
                    module,
                    resourceType,
                    new IntPtr(resourceId),
                    language);
                if (info == IntPtr.Zero)
                {
                    throw LastError(
                        "FindResourceEx failed for "
                        + resourceType
                        + "/"
                        + resourceId
                        + ".");
                }

                uint size = SizeofResource(module, info);
                if (size == 0)
                {
                    throw LastError("SizeofResource returned zero.");
                }

                IntPtr loaded = LoadResource(module, info);
                if (loaded == IntPtr.Zero)
                {
                    throw LastError("LoadResource failed.");
                }

                IntPtr pointer = LockResource(loaded);
                if (pointer == IntPtr.Zero)
                {
                    throw LastError("LockResource failed.");
                }

                byte[] data = new byte[checked((int)size)];
                Marshal.Copy(pointer, data, 0, data.Length);
                return new PeResource
                {
                    Data = data,
                    Language = language
                };
            }
            finally
            {
                FreeLibrary(module);
            }
        }

        public static void Replace(
            string executablePath,
            string resourceType,
            int resourceId,
            ushort language,
            byte[] data)
        {
            if (data == null || data.Length == 0)
            {
                throw new ArgumentException("Resource data is empty.", "data");
            }

            IntPtr update = BeginUpdateResource(executablePath, false);
            if (update == IntPtr.Zero)
            {
                throw LastError("BeginUpdateResource failed.");
            }

            bool committed = false;
            GCHandle pinned = new GCHandle();
            try
            {
                pinned = GCHandle.Alloc(data, GCHandleType.Pinned);
                if (!UpdateResource(
                        update,
                        resourceType,
                        new IntPtr(resourceId),
                        language,
                        pinned.AddrOfPinnedObject(),
                        checked((uint)data.Length)))
                {
                    throw LastError("UpdateResource failed.");
                }

                if (!EndUpdateResource(update, false))
                {
                    update = IntPtr.Zero;
                    throw LastError("EndUpdateResource failed.");
                }

                update = IntPtr.Zero;
                committed = true;
            }
            finally
            {
                if (pinned.IsAllocated)
                {
                    pinned.Free();
                }

                if (!committed && update != IntPtr.Zero)
                {
                    EndUpdateResource(update, true);
                }
            }
        }

        private static ushort FindFirstLanguage(
            IntPtr module,
            string resourceType,
            int resourceId)
        {
            ushort selected = 0;
            EnumResourceLanguagesCallback callback =
                delegate(
                    IntPtr ignoredModule,
                    string ignoredType,
                    IntPtr ignoredName,
                    ushort language,
                    IntPtr ignoredParameter)
                {
                    selected = language;
                    return false;
                };

            bool result = EnumResourceLanguages(
                module,
                resourceType,
                new IntPtr(resourceId),
                callback,
                IntPtr.Zero);

            int error = Marshal.GetLastWin32Error();
            const int ResourceEnumUserStop = 15106;
            if (selected == 0
                && !result
                && error != ResourceEnumUserStop)
            {
                throw new Win32Exception(
                    error,
                    "EnumResourceLanguages failed.");
            }

            return selected;
        }

        private static Win32Exception LastError(string message)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), message);
        }

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        private static extern IntPtr LoadLibraryEx(
            string fileName,
            IntPtr file,
            uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeLibrary(IntPtr module);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        private static extern IntPtr FindResourceEx(
            IntPtr module,
            string resourceType,
            IntPtr resourceName,
            ushort language);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint SizeofResource(
            IntPtr module,
            IntPtr resourceInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LoadResource(
            IntPtr module,
            IntPtr resourceInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LockResource(IntPtr resourceData);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumResourceLanguages(
            IntPtr module,
            string resourceType,
            IntPtr resourceName,
            EnumResourceLanguagesCallback callback,
            IntPtr parameter);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        private static extern IntPtr BeginUpdateResource(
            string fileName,
            [MarshalAs(UnmanagedType.Bool)] bool deleteExistingResources);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateResource(
            IntPtr update,
            string resourceType,
            IntPtr resourceName,
            ushort language,
            IntPtr data,
            uint dataSize);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EndUpdateResource(
            IntPtr update,
            [MarshalAs(UnmanagedType.Bool)] bool discard);
    }
}
