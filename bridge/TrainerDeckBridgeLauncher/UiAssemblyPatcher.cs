using System;
using System.Collections.Generic;
using System.IO;
using Mono.Cecil;
using Mono.Cecil.Cil;

namespace TrainerDeckBridgeLauncher
{
    internal static class UiAssemblyPatcher
    {
        public static byte[] InjectBridgeStart(
            byte[] uiAssembly,
            string bridgeAssemblyPath)
        {
            if (uiAssembly == null || uiAssembly.Length < 2)
            {
                throw new ArgumentException(
                    "Decrypted UI assembly is empty.",
                    "uiAssembly");
            }

            if (!File.Exists(bridgeAssemblyPath))
            {
                throw new FileNotFoundException(
                    "TrainerDeckBridge.dll is missing.",
                    bridgeAssemblyPath);
            }

            using (MemoryStream input = new MemoryStream(
                uiAssembly,
                false))
            using (AssemblyDefinition targetAssembly =
                AssemblyDefinition.ReadAssembly(
                    input,
                    new ReaderParameters { InMemory = true }))
            using (AssemblyDefinition bridgeAssembly =
                AssemblyDefinition.ReadAssembly(bridgeAssemblyPath))
            {
                ModuleDefinition targetModule = targetAssembly.MainModule;
                EnsureCurrentRuntime(targetModule, "Trainer UI");
                EnsureCurrentRuntime(
                    bridgeAssembly.MainModule,
                    "TrainerDeck bridge");
                MethodDefinition bridgeStart = FindBridgeStart(
                    bridgeAssembly.MainModule);
                MethodReference importedStart = targetModule.ImportReference(
                    bridgeStart);
                MethodDefinition bridgeStateReport = FindBridgeStateReport(
                    bridgeAssembly.MainModule);
                MethodReference importedStateReport =
                    targetModule.ImportReference(bridgeStateReport);
                MethodDefinition bridgeMenuPayloadReport =
                    FindBridgeMenuPayloadReport(
                        bridgeAssembly.MainModule);
                MethodReference importedMenuPayloadReport =
                    targetModule.ImportReference(
                        bridgeMenuPayloadReport);
                MethodDefinition targetMethod = FindTrainerHook(targetModule);
                MethodDefinition stateTarget = FindTrainerStateHook(
                    targetModule);
                MethodDefinition menuTarget = FindTrainerMenuHook(
                    targetModule);

                if (!ContainsCall(targetMethod, importedStart))
                {
                    AddExitTrampoline(targetMethod, importedStart);
                }
                if (!ContainsCall(stateTarget, importedStateReport))
                {
                    AddStateCallbacks(
                        stateTarget,
                        importedStateReport);
                }
                if (!ContainsCall(
                        menuTarget,
                        importedMenuPayloadReport))
                {
                    AddMenuPayloadCallback(
                        menuTarget,
                        importedMenuPayloadReport);
                }

                using (MemoryStream output = new MemoryStream())
                {
                    targetAssembly.Write(output);
                    byte[] patchedAssembly = output.ToArray();
                    EnsurePatchedAssembly(patchedAssembly);
                    return patchedAssembly;
                }
            }
        }

        private static void EnsurePatchedAssembly(byte[] patchedAssembly)
        {
            using (MemoryStream input = new MemoryStream(
                patchedAssembly,
                false))
            using (AssemblyDefinition assembly =
                AssemblyDefinition.ReadAssembly(
                    input,
                    new ReaderParameters { InMemory = true }))
            {
                EnsureCurrentRuntime(
                    assembly.MainModule,
                    "Patched trainer UI");
            }
        }

        private static void EnsureCurrentRuntime(
            ModuleDefinition module,
            string description)
        {
            if (module == null)
            {
                throw new ArgumentNullException("module");
            }

            int coreLibraryReferences = 0;
            for (int index = 0;
                index < module.AssemblyReferences.Count;
                index++)
            {
                AssemblyNameReference reference =
                    module.AssemblyReferences[index];
                if (!string.Equals(
                        reference.Name,
                        "mscorlib",
                        StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                coreLibraryReferences++;
                int major = reference.Version == null
                    ? 0
                    : reference.Version.Major;
                if (major != 2)
                {
                    throw new InvalidDataException(
                        description
                        + " must reference the current CLR2 mscorlib, not "
                        + (reference.Version == null
                            ? "<missing>"
                            : reference.Version.ToString())
                        + ".");
                }
            }

            if (coreLibraryReferences != 1)
            {
                throw new InvalidDataException(
                    description
                    + " must contain exactly one CLR2 mscorlib reference.");
            }

            string runtimeVersion = module.RuntimeVersion ?? string.Empty;
            if (!runtimeVersion.StartsWith(
                    "v2.",
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    description
                    + " must use the current CLR2 metadata runtime.");
            }
        }

        private static MethodDefinition FindBridgeStart(ModuleDefinition module)
        {
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                if (!string.Equals(
                        type.FullName,
                        "TrainerDeckBridge.EntryPoint",
                        StringComparison.Ordinal))
                {
                    continue;
                }

                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (method.IsStatic
                        && string.Equals(
                            method.Name,
                            "Start",
                            StringComparison.Ordinal)
                        && method.Parameters.Count == 1
                        && string.Equals(
                            method.Parameters[0].ParameterType.FullName,
                            "System.Object",
                            StringComparison.Ordinal)
                        && string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        return method;
                    }
                }
            }

            throw new InvalidDataException(
                "TrainerDeckBridge.EntryPoint.Start(object) was not found.");
        }

        private static MethodDefinition FindBridgeStateReport(
            ModuleDefinition module)
        {
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                if (!string.Equals(
                        type.FullName,
                        "TrainerDeckBridge.EntryPoint",
                        StringComparison.Ordinal))
                {
                    continue;
                }

                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (method.IsStatic
                        && string.Equals(
                            method.Name,
                            "ReportOptionState",
                            StringComparison.Ordinal)
                        && method.Parameters.Count == 3
                        && string.Equals(
                            method.Parameters[0].ParameterType.FullName,
                            "System.Object",
                            StringComparison.Ordinal)
                        && string.Equals(
                            method.Parameters[1].ParameterType.FullName,
                            "System.String",
                            StringComparison.Ordinal)
                        && string.Equals(
                            method.Parameters[2].ParameterType.FullName,
                            "System.Boolean",
                            StringComparison.Ordinal)
                        && string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        return method;
                    }
                }
            }

            throw new InvalidDataException(
                "TrainerDeckBridge.EntryPoint.ReportOptionState"
                + "(object,string,bool) was not found.");
        }

        private static MethodDefinition FindBridgeMenuPayloadReport(
            ModuleDefinition module)
        {
            MethodDefinition match = null;
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                if (!string.Equals(
                        type.FullName,
                        "TrainerDeckBridge.EntryPoint",
                        StringComparison.Ordinal))
                {
                    continue;
                }

                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (!method.IsStatic
                        || !string.Equals(
                            method.Name,
                            "ReportMenuPayload",
                            StringComparison.Ordinal)
                        || method.Parameters.Count != 3
                        || !string.Equals(
                            method.Parameters[0].ParameterType.FullName,
                            "System.Object",
                            StringComparison.Ordinal)
                        || !string.Equals(
                            method.Parameters[1].ParameterType.FullName,
                            "System.String",
                            StringComparison.Ordinal)
                        || !string.Equals(
                            method.Parameters[2].ParameterType.FullName,
                            "System.String",
                            StringComparison.Ordinal)
                        || !string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (match != null)
                    {
                        throw new InvalidDataException(
                            "Multiple TrainerDeckBridge.EntryPoint."
                            + "ReportMenuPayload(object,string,string)"
                            + " methods were found.");
                    }

                    match = method;
                }
            }

            if (match == null)
            {
                throw new InvalidDataException(
                    "TrainerDeckBridge.EntryPoint.ReportMenuPayload"
                    + "(object,string,string) was not found.");
            }

            return match;
        }

        private static MethodDefinition FindTrainerHook(ModuleDefinition module)
        {
            MethodDefinition match = null;
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (!string.Equals(
                            method.Name,
                            "TrainerCall_SetFunctionPointers",
                            StringComparison.Ordinal)
                        || method.IsStatic
                        || !method.HasBody
                        || method.Parameters.Count != 0
                        || !string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (match != null)
                    {
                        throw new InvalidDataException(
                            "Multiple TrainerCall_SetFunctionPointers methods found.");
                    }

                    match = method;
                }
            }

            if (match == null)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetFunctionPointers was not found in UI/101.");
            }

            return match;
        }

        private static MethodDefinition FindTrainerStateHook(
            ModuleDefinition module)
        {
            MethodDefinition match = null;
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (!string.Equals(
                            method.Name,
                            "TrainerCall_SetCheatOptionState",
                            StringComparison.Ordinal)
                        || method.IsStatic
                        || !method.HasBody
                        || method.Parameters.Count != 0
                        || !string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (match != null)
                    {
                        throw new InvalidDataException(
                            "Multiple TrainerCall_SetCheatOptionState"
                            + " methods found.");
                    }

                    match = method;
                }
            }

            if (match == null)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetCheatOptionState was not found in UI/101.");
            }

            return match;
        }

        private static MethodDefinition FindTrainerMenuHook(
            ModuleDefinition module)
        {
            MethodDefinition match = null;
            foreach (TypeDefinition type in AllTypes(module.Types))
            {
                for (int index = 0; index < type.Methods.Count; index++)
                {
                    MethodDefinition method = type.Methods[index];
                    if (!string.Equals(
                            method.Name,
                            "TrainerCall_SetOptionList",
                            StringComparison.Ordinal)
                        || method.IsStatic
                        || !method.HasBody
                        || method.Parameters.Count != 0
                        || !string.Equals(
                            method.ReturnType.FullName,
                            "System.Void",
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (match != null)
                    {
                        throw new InvalidDataException(
                            "Multiple TrainerCall_SetOptionList"
                            + " methods found.");
                    }

                    match = method;
                }
            }

            if (match == null)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetOptionList was not found in UI/101.");
            }

            return match;
        }

        private static bool ContainsCall(
            MethodDefinition target,
            MethodReference bridgeStart)
        {
            for (int index = 0;
                index < target.Body.Instructions.Count;
                index++)
            {
                Instruction instruction = target.Body.Instructions[index];
                MethodReference called = instruction.Operand as MethodReference;
                if (called != null
                    && string.Equals(
                        called.FullName,
                        bridgeStart.FullName,
                        StringComparison.Ordinal)
                    && string.Equals(
                        called.DeclaringType.FullName,
                        bridgeStart.DeclaringType.FullName,
                        StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static void AddExitTrampoline(
            MethodDefinition target,
            MethodReference bridgeStart)
        {
            List<Instruction> returns = new List<Instruction>();
            for (int index = 0;
                index < target.Body.Instructions.Count;
                index++)
            {
                Instruction instruction = target.Body.Instructions[index];
                if (instruction.OpCode == OpCodes.Ret)
                {
                    returns.Add(instruction);
                }
            }

            if (returns.Count == 0)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetFunctionPointers has no return instruction.");
            }

            ILProcessor processor = target.Body.GetILProcessor();
            Instruction trampoline = processor.Create(OpCodes.Ldarg_0);
            Instruction call = processor.Create(OpCodes.Call, bridgeStart);
            Instruction finalReturn = processor.Create(OpCodes.Ret);
            processor.Append(trampoline);
            processor.Append(call);
            processor.Append(finalReturn);

            // Mutating each original ret preserves existing branch and exception
            // handler targets while routing every exit through Start(this).
            for (int index = 0; index < returns.Count; index++)
            {
                returns[index].OpCode = OpCodes.Br;
                returns[index].Operand = trampoline;
            }

            if (target.Body.MaxStackSize < 1)
            {
                target.Body.MaxStackSize = 1;
            }
        }

        private static void AddStateCallbacks(
            MethodDefinition target,
            MethodReference bridgeStateReport)
        {
            Instruction readString = null;
            Instruction readInt32 = null;
            for (int index = 0;
                index < target.Body.Instructions.Count;
                index++)
            {
                Instruction instruction = target.Body.Instructions[index];
                MethodReference called = instruction.Operand as MethodReference;
                if (called == null
                    || (instruction.OpCode != OpCodes.Call
                        && instruction.OpCode != OpCodes.Callvirt)
                    || called.Parameters.Count != 0)
                {
                    continue;
                }

                if (string.Equals(
                        called.Name,
                        "ReadString",
                        StringComparison.Ordinal)
                    && string.Equals(
                        called.ReturnType.FullName,
                        "System.String",
                        StringComparison.Ordinal))
                {
                    if (readString != null)
                    {
                        throw new InvalidDataException(
                            "TrainerCall_SetCheatOptionState has multiple"
                            + " ReadString(): String protocol reads.");
                    }

                    readString = instruction;
                }
                else if (string.Equals(
                        called.Name,
                        "ReadInt32",
                        StringComparison.Ordinal)
                    && string.Equals(
                        called.ReturnType.FullName,
                        "System.Int32",
                        StringComparison.Ordinal))
                {
                    if (readInt32 != null)
                    {
                        throw new InvalidDataException(
                            "TrainerCall_SetCheatOptionState has multiple"
                            + " ReadInt32(): Int32 protocol reads.");
                    }

                    readInt32 = instruction;
                }
            }

            if (readString == null || readInt32 == null)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetCheatOptionState does not expose a"
                    + " unique ReadString/ReadInt32 protocol state flow.");
            }

            int readStringIndex =
                target.Body.Instructions.IndexOf(readString);
            int readInt32Index =
                target.Body.Instructions.IndexOf(readInt32);
            if (readStringIndex < 0
                || readInt32Index <= readStringIndex)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetCheatOptionState does not read the"
                    + " option ID before its raw state.");
            }

            Instruction loadEnabled = readInt32.Next;
            Instruction compareEnabled = loadEnabled == null
                ? null
                : loadEnabled.Next;
            if (loadEnabled == null
                || loadEnabled.OpCode != OpCodes.Ldc_I4_1
                || compareEnabled == null
                || compareEnabled.OpCode != OpCodes.Ceq)
            {
                throw new InvalidDataException(
                    "ReadInt32 state is not immediately normalized by"
                    + " ldc.i4.1/ceq.");
            }

            target.Body.InitLocals = true;
            VariableDefinition optionId = new VariableDefinition(
                target.Module.TypeSystem.String);
            VariableDefinition rawState = new VariableDefinition(
                target.Module.TypeSystem.Int32);
            target.Body.Variables.Add(optionId);
            target.Body.Variables.Add(rawState);

            ILProcessor processor = target.Body.GetILProcessor();
            Instruction duplicateId = processor.Create(OpCodes.Dup);
            processor.InsertAfter(readString, duplicateId);
            processor.InsertAfter(
                duplicateId,
                processor.Create(OpCodes.Stloc, optionId));

            Instruction duplicateRawState = processor.Create(OpCodes.Dup);
            processor.InsertAfter(readInt32, duplicateRawState);
            processor.InsertAfter(
                duplicateRawState,
                processor.Create(OpCodes.Stloc, rawState));

            Instruction loadWindow = processor.Create(OpCodes.Ldarg_0);
            processor.InsertAfter(compareEnabled, loadWindow);
            Instruction loadOption = processor.Create(
                OpCodes.Ldloc,
                optionId);
            processor.InsertAfter(loadWindow, loadOption);
            Instruction loadRawState = processor.Create(
                OpCodes.Ldloc,
                rawState);
            processor.InsertAfter(loadOption, loadRawState);
            Instruction loadOne = processor.Create(OpCodes.Ldc_I4_1);
            processor.InsertAfter(loadRawState, loadOne);
            Instruction compareRawState = processor.Create(OpCodes.Ceq);
            processor.InsertAfter(loadOne, compareRawState);
            processor.InsertAfter(
                compareRawState,
                processor.Create(OpCodes.Call, bridgeStateReport));

            IncreaseMaxStack(target.Body, 4);
        }

        private static void AddMenuPayloadCallback(
            MethodDefinition target,
            MethodReference bridgeMenuPayloadReport)
        {
            Instruction setupCall = null;
            for (int index = 0;
                index < target.Body.Instructions.Count;
                index++)
            {
                Instruction instruction = target.Body.Instructions[index];
                MethodReference called = instruction.Operand as MethodReference;
                if (called == null
                    || (instruction.OpCode != OpCodes.Call
                        && instruction.OpCode != OpCodes.Callvirt)
                    || !string.Equals(
                        called.Name,
                        "SetupCheatOptions",
                        StringComparison.Ordinal)
                    || called.Parameters.Count != 2
                    || !string.Equals(
                        called.Parameters[0].ParameterType.FullName,
                        "System.String",
                        StringComparison.Ordinal)
                    || !string.Equals(
                        called.Parameters[1].ParameterType.FullName,
                        "System.String",
                        StringComparison.Ordinal)
                    || !string.Equals(
                        called.ReturnType.FullName,
                        "System.Void",
                        StringComparison.Ordinal))
                {
                    continue;
                }

                if (setupCall != null)
                {
                    throw new InvalidDataException(
                        "TrainerCall_SetOptionList has multiple"
                        + " SetupCheatOptions(string,string) calls.");
                }

                setupCall = instruction;
            }

            if (setupCall == null)
            {
                throw new InvalidDataException(
                    "TrainerCall_SetOptionList does not call"
                    + " SetupCheatOptions(string,string).");
            }

            Instruction englishLoad = PreviousMeaningful(setupCall);
            Instruction chineseLoad = PreviousMeaningful(englishLoad);
            VariableDefinition english = GetLoadedVariable(
                target.Body,
                englishLoad);
            VariableDefinition chinese = GetLoadedVariable(
                target.Body,
                chineseLoad);
            if (chinese == null
                || english == null
                || chinese.Index == english.Index
                || !string.Equals(
                    chinese.VariableType.FullName,
                    "System.String",
                    StringComparison.Ordinal)
                || !string.Equals(
                    english.VariableType.FullName,
                    "System.String",
                    StringComparison.Ordinal))
            {
                throw new InvalidDataException(
                    "SetupCheatOptions arguments are not direct loads"
                    + " from distinct String locals.");
            }

            ILProcessor processor = target.Body.GetILProcessor();
            Instruction loadWindow = processor.Create(OpCodes.Ldarg_0);
            processor.InsertBefore(setupCall, loadWindow);
            Instruction loadChinese = processor.Create(
                OpCodes.Ldloc,
                chinese);
            processor.InsertAfter(loadWindow, loadChinese);
            Instruction loadEnglish = processor.Create(
                OpCodes.Ldloc,
                english);
            processor.InsertAfter(loadChinese, loadEnglish);
            processor.InsertAfter(
                loadEnglish,
                processor.Create(
                    OpCodes.Call,
                    bridgeMenuPayloadReport));

            IncreaseMaxStack(target.Body, 3);
        }

        private static Instruction PreviousMeaningful(Instruction instruction)
        {
            Instruction current = instruction.Previous;
            while (current != null && current.OpCode == OpCodes.Nop)
            {
                current = current.Previous;
            }

            return current;
        }

        private static VariableDefinition GetLoadedVariable(
            MethodBody body,
            Instruction instruction)
        {
            if (instruction == null)
            {
                return null;
            }

            if (instruction.OpCode == OpCodes.Ldloc
                || instruction.OpCode == OpCodes.Ldloc_S)
            {
                return instruction.Operand as VariableDefinition;
            }

            if (instruction.OpCode == OpCodes.Ldloc_0)
            {
                return VariableAt(body, 0);
            }
            if (instruction.OpCode == OpCodes.Ldloc_1)
            {
                return VariableAt(body, 1);
            }
            if (instruction.OpCode == OpCodes.Ldloc_2)
            {
                return VariableAt(body, 2);
            }
            if (instruction.OpCode == OpCodes.Ldloc_3)
            {
                return VariableAt(body, 3);
            }

            return null;
        }

        private static void IncreaseMaxStack(
            MethodBody body,
            int additionalDepth)
        {
            if (body == null
                || additionalDepth < 0
                || body.MaxStackSize > int.MaxValue - additionalDepth)
            {
                throw new InvalidDataException(
                    "Method MaxStack cannot be increased safely.");
            }

            body.MaxStackSize += additionalDepth;
        }

        private static VariableDefinition VariableAt(MethodBody body, int index)
        {
            return body != null && index >= 0 && index < body.Variables.Count
                ? body.Variables[index]
                : null;
        }

        private static IEnumerable<TypeDefinition> AllTypes(
            IEnumerable<TypeDefinition> roots)
        {
            foreach (TypeDefinition type in roots)
            {
                yield return type;
                foreach (TypeDefinition nested in AllTypes(type.NestedTypes))
                {
                    yield return nested;
                }
            }
        }
    }
}
