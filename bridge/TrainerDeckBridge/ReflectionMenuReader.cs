using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace TrainerDeckBridge
{
    internal sealed class ReflectionMenuReader
    {
        private const int MaxInputValueLength = 256;

        private const BindingFlags InstanceFlags =
            BindingFlags.Instance
            | BindingFlags.Public
            | BindingFlags.NonPublic
            | BindingFlags.DeclaredOnly;

        private const BindingFlags StaticFlags =
            BindingFlags.Static
            | BindingFlags.Public
            | BindingFlags.NonPublic;

        private static readonly string[] LanguageKeys =
        {
            "zh_cn",
            "zh_tw",
            "en"
        };

        private static readonly Regex ImportantMarker = new Regex(
            "\\{important\\}",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private readonly object mainWindow;
        private readonly UiFramework uiFramework;
        private readonly object dispatcher;
        private readonly MethodInfo dispatcherCheckAccess;
        private readonly MethodInfo dispatcherInvoke;
        private readonly MethodInfo dispatcherBeginInvoke;
        private readonly ISynchronizeInvoke synchronizeInvoke;
        private readonly object stateGate;
        private readonly Dictionary<string, bool> authoritativeStates;
        private readonly object definitionGate;
        private MenuDefinitionSnapshot menuDefinition;
        private bool toggleResourcesLoaded;
        private object toggleOnResource;
        private object toggleOffResource;
        private string toggleOnFingerprint;
        private string toggleOffFingerprint;
        public string UiFingerprint { get; private set; }

        public ReflectionMenuReader(object mainWindow)
        {
            if (mainWindow == null)
            {
                throw new ArgumentNullException("mainWindow");
            }

            this.mainWindow = mainWindow;
            stateGate = new object();
            authoritativeStates =
                new Dictionary<string, bool>(StringComparer.Ordinal);
            definitionGate = new object();

            dispatcher = GetMemberValue(mainWindow, "Dispatcher");
            if (dispatcher != null)
            {
                dispatcherCheckAccess = FindMethod(
                    dispatcher,
                    "CheckAccess",
                    0);
                dispatcherInvoke = FindDispatcherMethod(
                    dispatcher.GetType(),
                    "Invoke");
                dispatcherBeginInvoke = FindDispatcherMethod(
                    dispatcher.GetType(),
                    "BeginInvoke");
                if (dispatcherCheckAccess == null
                    || dispatcherInvoke == null
                    || dispatcherBeginInvoke == null)
                {
                    throw new InvalidOperationException(
                        "FLiNG WPF Dispatcher has an unsupported API shape.");
                }

                uiFramework = UiFramework.Wpf;
            }
            else
            {
                synchronizeInvoke = mainWindow as ISynchronizeInvoke;
                if (synchronizeInvoke == null)
                {
                    throw new InvalidOperationException(
                        "FLiNG MainWindow exposes neither a WPF Dispatcher"
                        + " nor a WinForms synchronization interface.");
                }

                uiFramework = UiFramework.WinForms;
            }

            UiFingerprint = ComputeUiFingerprint(mainWindow.GetType());
        }

        public MenuSnapshot Capture()
        {
            return OnUiThread<MenuSnapshot>(
                delegate
                {
                    return CaptureOnUiThread();
                });
        }

        public void BeginExecuteDesired(
            string optionId,
            bool desired,
            Action<CommandResult> completion)
        {
            BeginOnUiThread(
                delegate
                {
                    return ExecuteDesiredOnUiThread(optionId, desired);
                },
                completion);
        }

        public void BeginExecuteValue(
            string optionId,
            string value,
            string expectedValue,
            Action<CommandResult> completion)
        {
            BeginOnUiThread(
                delegate
                {
                    return ExecuteValueOnUiThread(
                        optionId,
                        value,
                        expectedValue);
                },
                completion);
        }

        public void BeginExecuteAction(
            string optionId,
            Action<CommandResult> completion)
        {
            BeginOnUiThread(
                delegate
                {
                    return ExecuteActionOnUiThread(optionId);
                },
                completion);
        }

        public void ReportAuthoritativeState(string optionId, bool active)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(optionId))
            {
                return;
            }

            lock (stateGate)
            {
                authoritativeStates[optionId] = active;
            }
        }

        public void ReportMenuPayload(string chinese, string english)
        {
            MenuDefinitionSnapshot parsed = null;
            try
            {
                parsed = MenuProtocolParser.Parse(chinese, english);
            }
            catch (Exception ex)
            {
                // A protocol parse failure must never affect the original
                // trainer. Capture() will fall back to reflected UI metadata.
                BridgeLog.Write(
                    "Menu payload parse failed: "
                    + ex.GetType().Name
                    + ": "
                    + ex.Message);
            }

            lock (definitionGate)
            {
                menuDefinition = parsed;
            }
        }

        private T OnUiThread<T>(Func<T> operation)
        {
            if (uiFramework == UiFramework.Wpf)
            {
                bool hasAccess = (bool)dispatcherCheckAccess.Invoke(
                    dispatcher,
                    new object[0]);
                if (hasAccess)
                {
                    return operation();
                }

                return (T)dispatcherInvoke.Invoke(
                    dispatcher,
                    new object[] { operation, new object[0] });
            }

            bool? disposed = ReadNullableBoolean(mainWindow, "IsDisposed");
            if (disposed.HasValue && disposed.Value)
            {
                throw new InvalidOperationException(
                    "FLiNG WinForms window has been disposed.");
            }

            bool? handleCreated = ReadNullableBoolean(
                mainWindow,
                "IsHandleCreated");
            if (handleCreated.HasValue && !handleCreated.Value)
            {
                throw new InvalidOperationException(
                    "FLiNG WinForms window handle is not ready.");
            }

            if (!synchronizeInvoke.InvokeRequired)
            {
                return operation();
            }

            return (T)synchronizeInvoke.Invoke(operation, new object[0]);
        }

        private void BeginOnUiThread(
            Func<CommandResult> operation,
            Action<CommandResult> completion)
        {
            if (operation == null)
            {
                throw new ArgumentNullException("operation");
            }
            if (completion == null)
            {
                throw new ArgumentNullException("completion");
            }

            Action callback = delegate
            {
                CommandResult result;
                try
                {
                    result = operation();
                    if (result == null)
                    {
                        result = Rejected("ui-command-returned-no-result");
                    }
                }
                catch (TargetInvocationException ex)
                {
                    Exception cause = ex.InnerException ?? ex;
                    result = Rejected(
                        "ui-command-error: " + cause.Message);
                }
                catch (Exception ex)
                {
                    result = Rejected(
                        "ui-command-error: " + ex.Message);
                }

                try
                {
                    completion(result);
                }
                catch
                {
                    // Completion only queues work back to the bridge. It must
                    // never be allowed to escape into the trainer message pump.
                }
            };

            if (uiFramework == UiFramework.Wpf)
            {
                dispatcherBeginInvoke.Invoke(
                    dispatcher,
                    new object[] { callback, new object[0] });
                return;
            }

            bool? disposed = ReadNullableBoolean(mainWindow, "IsDisposed");
            if (disposed.HasValue && disposed.Value)
            {
                throw new InvalidOperationException(
                    "FLiNG WinForms window has been disposed.");
            }

            bool? handleCreated = ReadNullableBoolean(
                mainWindow,
                "IsHandleCreated");
            if (handleCreated.HasValue && !handleCreated.Value)
            {
                throw new InvalidOperationException(
                    "FLiNG WinForms window handle is not ready.");
            }

            synchronizeInvoke.BeginInvoke(callback, new object[0]);
        }

        private MenuSnapshot CaptureOnUiThread()
        {
            MenuSnapshot snapshot = new MenuSnapshot();
            snapshot.gameRunning = ReadGameRunning();
            if (!snapshot.gameRunning)
            {
                lock (stateGate)
                {
                    authoritativeStates.Clear();
                }
            }

            List<ControlBinding> controls = ReadOptionControls();
            MenuDefinitionSnapshot definition = ReadMenuDefinition();
            bool mergeDefinition = definition != null
                && definition.options != null
                && definition.options.Count == controls.Count;

            for (int index = 0; index < controls.Count; index++)
            {
                ControlBinding binding = controls[index];
                MenuDefinitionOption defined = mergeDefinition
                    ? definition.options[index]
                    : null;
                string optionId = binding.OptionId;
                if (FrameworkCompat.IsNullOrWhiteSpace(optionId) && defined != null)
                {
                    optionId = defined.id;
                }
                if (FrameworkCompat.IsNullOrWhiteSpace(optionId))
                {
                    continue;
                }

                TrainerOption option = ReadOption(
                    binding.Control,
                    optionId,
                    binding.Group,
                    snapshot.gameRunning);
                if (defined != null)
                {
                    MergeDefinition(option, defined);
                }

                ConfigureValueCapability(option, binding.Control);
                option.controllable = IsControllableKind(option.kind)
                    && option.Available
                    && option.active.HasValue;
                snapshot.options.Add(option);
            }

            return snapshot;
        }

        private List<ControlBinding> ReadOptionControls()
        {
            List<ControlBinding> options = new List<ControlBinding>();
            object area = GetMemberValue(mainWindow, "m_cheat_options_area");
            IEnumerable children = GetMenuChildren(area);
            if (children == null)
            {
                return options;
            }

            Dictionary<string, string> currentGroup =
                new Dictionary<string, string>();
            foreach (object child in children)
            {
                if (child == null)
                {
                    continue;
                }

                string typeName = child.GetType().Name;
                if (typeName.IndexOf(
                        "CheatOptionLabel",
                        StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    currentGroup = ReadLanguageTexts(
                        child,
                        "GetLabelText",
                        "m_label_texts",
                        "LabelText");
                    continue;
                }

                string optionId = ConvertToString(
                    GetMemberValue(child, "ID"));
                bool looksLikeOption = typeName.IndexOf(
                    "CheatOption",
                    StringComparison.OrdinalIgnoreCase) >= 0;
                if (FrameworkCompat.IsNullOrWhiteSpace(optionId) && !looksLikeOption)
                {
                    continue;
                }

                options.Add(
                    new ControlBinding
                    {
                        Control = child,
                        OptionId = optionId,
                        Group = new Dictionary<string, string>(currentGroup)
                    });
            }

            return options;
        }

        private IEnumerable GetMenuChildren(object area)
        {
            if (area == null)
            {
                return null;
            }

            string preferred = uiFramework == UiFramework.Wpf
                ? "Children"
                : "Controls";
            string fallback = uiFramework == UiFramework.Wpf
                ? "Controls"
                : "Children";
            IEnumerable children = GetMemberValue(area, preferred)
                as IEnumerable;
            return children ?? GetMemberValue(area, fallback) as IEnumerable;
        }

        private MenuDefinitionSnapshot ReadMenuDefinition()
        {
            lock (definitionGate)
            {
                return menuDefinition;
            }
        }

        private static void MergeDefinition(
            TrainerOption option,
            MenuDefinitionOption defined)
        {
            if (option == null || defined == null)
            {
                return;
            }

            if ((FrameworkCompat.IsNullOrWhiteSpace(option.kind)
                    || string.Equals(
                        option.kind,
                        "unknown",
                        StringComparison.Ordinal))
                && !FrameworkCompat.IsNullOrWhiteSpace(defined.kind))
            {
                option.kind = defined.kind;
            }

            if (defined.labels != null && defined.labels.Count > 0)
            {
                option.labels = MergeTexts(option.labels, defined.labels);
            }

            if (defined.group != null && defined.group.Count > 0)
            {
                option.group = MergeTexts(option.group, defined.group);
            }

            if (defined.tooltips != null && defined.tooltips.Count > 0)
            {
                bool markedImportant;
                option.tooltips = NormalizeTooltips(
                    MergeTexts(option.tooltips, defined.tooltips),
                    out markedImportant);
                if (markedImportant)
                {
                    option.tooltip_style = "important";
                }
            }

            if (string.Equals(
                    defined.tooltip_style,
                    "important",
                    StringComparison.OrdinalIgnoreCase))
            {
                option.tooltip_style = "important";
            }
            else if (FrameworkCompat.IsNullOrWhiteSpace(option.tooltip_style)
                && !FrameworkCompat.IsNullOrWhiteSpace(defined.tooltip_style))
            {
                option.tooltip_style = defined.tooltip_style;
            }

            if (option.value == null && defined.value != null)
            {
                option.value = defined.value;
            }

            if (IsKnownValueType(defined.value_type))
            {
                option.value_type = defined.value_type;
            }
            if (IsKnownValueApplyMode(defined.value_apply_mode))
            {
                option.value_apply_mode = defined.value_apply_mode;
            }
            option.ActionWithoutInput = defined.action_without_input;

            if (!option.minimum.HasValue)
            {
                option.minimum = defined.minimum;
            }
            if (!option.maximum.HasValue)
            {
                option.maximum = defined.maximum;
            }
            if (!option.step.HasValue)
            {
                option.step = defined.step;
            }
        }

        private static Dictionary<string, string> MergeTexts(
            IDictionary<string, string> reflected,
            IDictionary<string, string> protocol)
        {
            Dictionary<string, string> merged =
                reflected == null
                    ? new Dictionary<string, string>()
                    : new Dictionary<string, string>(reflected);
            if (protocol == null)
            {
                return merged;
            }

            foreach (KeyValuePair<string, string> pair in protocol)
            {
                if (!FrameworkCompat.IsNullOrWhiteSpace(pair.Value))
                {
                    merged[pair.Key] = pair.Value;
                }
            }

            return merged;
        }

        private TrainerOption ReadOption(
            object control,
            string optionId,
            IDictionary<string, string> currentGroup,
            bool gameRunning)
        {
            TrainerOption option = new TrainerOption();
            option.id = optionId;
            option.kind = DetermineKind(control.GetType().Name);
            option.labels = ReadLanguageTexts(
                control,
                "GetOptionText",
                "m_option_texts",
                "OptionName");
            option.group = new Dictionary<string, string>(currentGroup);
            option.tooltips = ReadLanguageTexts(
                control,
                "GetToolTipText",
                "m_tooltip_texts",
                null);

            bool markedImportant;
            option.tooltips = NormalizeTooltips(
                option.tooltips,
                out markedImportant);
            bool important = markedImportant || HasRedWarningVisual(control);
            option.tooltip_style = important ? "important" : "normal";

            // The first menu discovery may establish a baseline only from a
            // strictly readable WPF/WinForms toggle member. After that, only
            // the injected core callback changes this map, so an original
            // window click cannot be mistaken for a native acknowledgement.
            option.active = SnapshotState(
                optionId,
                control,
                gameRunning);
            option.Available = ReadAvailable(control);
            option.value = ReadInputValue(control);
            option.HasReadableInputValue = option.value != null;
            option.minimum = ReadNullableDouble(control, "MinimumValue");
            option.maximum = ReadNullableDouble(control, "MaximumValue");
            option.step = ReadNullableDouble(control, "Stepping");
            return option;
        }

        private void ConfigureValueCapability(
            TrainerOption option,
            object control)
        {
            if (option != null)
            {
                option.action_controllable = false;
            }
            if (option == null || control == null || !IsValueKind(option.kind))
            {
                if (option != null)
                {
                    option.value_controllable = false;
                    option.value_type = "none";
                    option.value_apply_mode = "none";
                }
                return;
            }

            if (option.ActionWithoutInput)
            {
                option.value = null;
                option.minimum = null;
                option.maximum = null;
                option.step = null;
                option.value_controllable = false;
                option.value_type = "none";
                option.value_apply_mode = "none";
                option.action_controllable = option.Available
                    && HasSupportedActionDelegate(control);
                return;
            }

            InputWriteTarget target = FindInputWriteTarget(control);
            string valueType = DetermineValueType(option, target);
            string applyMode = ValueApplyModeForKind(option.kind);
            if (string.Equals(applyMode, "invoke", StringComparison.Ordinal)
                && !HasSupportedExecuteDelegate())
            {
                applyMode = "none";
            }

            option.value_type = valueType;
            option.value_apply_mode = target == null
                ? "none"
                : applyMode;
            option.value_controllable = option.Available
                && option.HasReadableInputValue
                && target != null
                && !string.Equals(valueType, "none", StringComparison.Ordinal)
                && !string.Equals(applyMode, "none", StringComparison.Ordinal)
                && IsCurrentValueCompatible(option.value, valueType);
        }

        private static string DetermineValueType(
            TrainerOption option,
            InputWriteTarget target)
        {
            if (target != null)
            {
                Type underlying = Nullable.GetUnderlyingType(target.ValueType)
                    ?? target.ValueType;
                if (IsIntegerType(underlying))
                {
                    return "integer";
                }
                if (IsNumericType(underlying))
                {
                    return "number";
                }
            }

            if (IsKnownValueType(option.value_type)
                && !string.Equals(
                    option.value_type,
                    "none",
                    StringComparison.Ordinal))
            {
                return option.value_type;
            }
            if (string.Equals(
                    option.kind,
                    "toggle_with_input_adjustment",
                    StringComparison.Ordinal)
                || option.minimum.HasValue
                || option.maximum.HasValue
                || option.step.HasValue)
            {
                return "number";
            }

            double numeric;
            return TryParseFiniteDouble(option.value, out numeric)
                ? "number"
                : "text";
        }

        private static bool IsCurrentValueCompatible(
            string value,
            string valueType)
        {
            if (value == null || value.Length > MaxInputValueLength)
            {
                return false;
            }
            if (string.Equals(valueType, "integer", StringComparison.Ordinal))
            {
                long integer;
                return long.TryParse(
                    value,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out integer);
            }
            if (string.Equals(valueType, "number", StringComparison.Ordinal))
            {
                double numeric;
                return TryParseFiniteDouble(value, out numeric);
            }
            return string.Equals(valueType, "text", StringComparison.Ordinal)
                && !ContainsControlCharacters(value);
        }

        private bool? SnapshotState(
            string optionId,
            object control,
            bool gameRunning)
        {
            if (!gameRunning)
            {
                return null;
            }

            lock (stateGate)
            {
                bool reported;
                if (authoritativeStates.TryGetValue(optionId, out reported))
                {
                    return reported;
                }
            }

            bool? baseline = ReadToggledState(control);
            if (!baseline.HasValue)
            {
                return null;
            }

            lock (stateGate)
            {
                bool reported;
                if (authoritativeStates.TryGetValue(optionId, out reported))
                {
                    return reported;
                }

                authoritativeStates[optionId] = baseline.Value;
                return baseline.Value;
            }
        }

        private bool? ReadAuthoritativeState(string optionId)
        {
            lock (stateGate)
            {
                bool active;
                return authoritativeStates.TryGetValue(optionId, out active)
                    ? (bool?)active
                    : null;
            }
        }

        private CommandResult ExecuteDesiredOnUiThread(
            string optionId,
            bool desired)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(optionId))
            {
                return Rejected("missing-option-id");
            }

            if (!ReadGameRunning())
            {
                return Rejected("game-not-running");
            }

            object control = FindOptionControl(optionId);
            if (control == null)
            {
                return Rejected("unknown-option");
            }

            if (!ReadAvailable(control))
            {
                return Rejected("option-unavailable");
            }

            bool? current = ReadAuthoritativeState(optionId);
            if (!current.HasValue)
            {
                return Rejected("state-unavailable");
            }

            if (current.Value == desired)
            {
                return new CommandResult { status = "noop" };
            }

            Delegate execute = GetExecuteDelegate();
            if (execute == null)
            {
                return Rejected("delegate-unavailable");
            }

            try
            {
                MethodInfo invoke = execute.GetType().GetMethod("Invoke");
                if (invoke == null)
                {
                    return Rejected("unsupported-delegate-signature");
                }

                ParameterInfo[] parameters = invoke.GetParameters();
                if (parameters.Length == 1)
                {
                    execute.DynamicInvoke(new object[] { optionId });
                }
                else if (parameters.Length == 2)
                {
                    // FLiNG's two-argument ABI names the second value "args".
                    // Every inspected normal option click sends an empty args
                    // string; the native core reads numeric input through its
                    // existing TrainerCall_GetInputValue callback by option ID.
                    execute.DynamicInvoke(
                        new object[] { optionId, string.Empty });
                }
                else
                {
                    return Rejected("unsupported-delegate-signature");
                }

                // "queued" only means the native callback was invoked. No state
                // is changed here; the later injected core callback is authoritative.
                return new CommandResult { status = "queued" };
            }
            catch (TargetInvocationException ex)
            {
                Exception cause = ex.InnerException ?? ex;
                return Rejected("delegate-error: " + cause.Message);
            }
            catch (Exception ex)
            {
                return Rejected("delegate-error: " + ex.Message);
            }
        }

        private CommandResult ExecuteActionOnUiThread(string optionId)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(optionId))
            {
                return Rejected("missing-option-id");
            }
            if (!ReadGameRunning())
            {
                return Rejected("game-not-running");
            }

            MenuSnapshot snapshot = CaptureOnUiThread();
            TrainerOption option = FindSnapshotOption(snapshot, optionId);
            if (option == null)
            {
                return Rejected("unknown-option");
            }
            if (!option.action_controllable)
            {
                return Rejected("action-unavailable");
            }

            object control = FindOptionControl(optionId);
            if (control == null)
            {
                return Rejected("unknown-option");
            }
            if (!ReadAvailable(control))
            {
                return Rejected("option-unavailable");
            }

            string invokeError = InvokeActionDelegate(
                GetExecuteDelegate(),
                optionId,
                control);
            if (invokeError != null)
            {
                return Rejected(invokeError);
            }

            return new CommandResult
            {
                status = "applied",
                operation = "action",
                invoked = true
            };
        }

        private CommandResult ExecuteValueOnUiThread(
            string optionId,
            string desiredValue,
            string expectedValue)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(optionId))
            {
                return Rejected("missing-option-id");
            }
            if (desiredValue == null)
            {
                return Rejected("missing-value");
            }
            if (expectedValue == null)
            {
                return Rejected("missing-expected-value");
            }
            if (expectedValue.Length > MaxInputValueLength)
            {
                return Rejected("expected-value-too-long");
            }
            if (ContainsControlCharacters(expectedValue))
            {
                return Rejected("expected-value-has-control-characters");
            }
            if (!ReadGameRunning())
            {
                return Rejected("game-not-running");
            }

            MenuSnapshot snapshot = CaptureOnUiThread();
            TrainerOption option = FindSnapshotOption(snapshot, optionId);
            if (option == null)
            {
                return Rejected("unknown-option");
            }
            if (!option.value_controllable)
            {
                return Rejected("value-unavailable");
            }

            object control = FindOptionControl(optionId);
            if (control == null)
            {
                return Rejected("unknown-option");
            }
            if (!ReadAvailable(control))
            {
                return Rejected("option-unavailable");
            }

            string currentValue = ReadInputValue(control);
            if (currentValue == null)
            {
                return Rejected("value-unavailable");
            }
            if (!string.Equals(
                    currentValue,
                    expectedValue,
                    StringComparison.Ordinal))
            {
                return Rejected("expected-value-changed");
            }

            string normalizedValue;
            string validationError = ValidateDesiredValue(
                option,
                desiredValue,
                out normalizedValue);
            if (validationError != null)
            {
                return Rejected(validationError);
            }
            bool unchanged = ValuesEquivalent(
                currentValue,
                normalizedValue,
                option.value_type);
            if (ShouldNoopValueCommand(
                    option,
                    currentValue,
                    normalizedValue))
            {
                return new CommandResult
                {
                    status = "noop",
                    operation = "value",
                    value = currentValue,
                    invoked = false
                };
            }

            InputWriteTarget target = FindInputWriteTarget(control);
            if (target == null)
            {
                return Rejected("input-writer-unavailable");
            }

            bool valueWasWritten = !unchanged;
            string readback = currentValue;
            if (valueWasWritten)
            {
                string writeError;
                if (!TryWriteInputValue(
                        target,
                        normalizedValue,
                        out writeError))
                {
                    return Rejected(writeError);
                }

                readback = ReadInputValue(control);
                if (!ValuesEquivalent(
                        readback,
                        normalizedValue,
                        option.value_type))
                {
                    TryRestoreInputValue(target, currentValue);
                    return Rejected("value-readback-mismatch");
                }
            }

            bool invoked = false;
            if (string.Equals(
                    option.value_apply_mode,
                    "invoke",
                    StringComparison.Ordinal))
            {
                Delegate execute = GetExecuteDelegate();
                string invokeError = InvokeValueDelegate(
                    execute,
                    optionId,
                    readback);
                if (invokeError != null)
                {
                    if (valueWasWritten)
                    {
                        TryRestoreInputValue(target, currentValue);
                    }
                    return Rejected(invokeError);
                }
                invoked = true;

                readback = ReadInputValue(control);
                if (!ValuesEquivalent(
                        readback,
                        normalizedValue,
                        option.value_type))
                {
                    if (valueWasWritten)
                    {
                        TryRestoreInputValue(target, currentValue);
                    }
                    return Rejected("value-readback-mismatch");
                }
            }

            return new CommandResult
            {
                status = string.Equals(
                    option.value_apply_mode,
                    "invoke",
                    StringComparison.Ordinal)
                    ? "applied"
                    : "staged",
                operation = "value",
                value = readback,
                invoked = invoked
            };
        }

        private static bool ShouldNoopValueCommand(
            TrainerOption option,
            string currentValue,
            string desiredValue)
        {
            return option != null
                && string.Equals(
                    option.value_apply_mode,
                    "stage_then_toggle",
                    StringComparison.Ordinal)
                && ValuesEquivalent(
                    currentValue,
                    desiredValue,
                    option.value_type);
        }

        private Delegate GetExecuteDelegate()
        {
            Delegate execute = GetMemberValue(
                mainWindow,
                "ExecuteTrainerCommand") as Delegate;
            if (execute == null)
            {
                // Older WPF generations expose the same direct string command
                // delegate as ToggleCheat.
                execute = GetMemberValue(
                    mainWindow,
                    "ToggleCheat") as Delegate;
            }
            return execute;
        }

        private bool HasSupportedExecuteDelegate()
        {
            Delegate execute = GetExecuteDelegate();
            MethodInfo invoke = execute == null
                ? null
                : execute.GetType().GetMethod("Invoke");
            if (invoke == null)
            {
                return false;
            }

            return HasSupportedStringDelegateSignature(
                invoke.GetParameters());
        }

        private bool HasSupportedActionDelegate(object control)
        {
            Delegate execute = GetExecuteDelegate();
            MethodInfo invoke = execute == null
                ? null
                : execute.GetType().GetMethod("Invoke");
            if (invoke == null)
            {
                return false;
            }

            ParameterInfo[] parameters = invoke.GetParameters();
            if (!HasSupportedStringDelegateSignature(parameters))
            {
                return false;
            }
            if (parameters.Length == 1)
            {
                return true;
            }

            string hiddenValue;
            return TryReadSafeActionValue(control, out hiddenValue);
        }

        private static string InvokeActionDelegate(
            Delegate execute,
            string optionId,
            object control)
        {
            if (execute == null)
            {
                return "delegate-unavailable";
            }

            try
            {
                MethodInfo invoke = execute.GetType().GetMethod("Invoke");
                if (invoke == null)
                {
                    return "unsupported-delegate-signature";
                }
                ParameterInfo[] parameters = invoke.GetParameters();
                if (!HasSupportedStringDelegateSignature(parameters))
                {
                    return "unsupported-delegate-signature";
                }
                if (parameters.Length == 1)
                {
                    execute.DynamicInvoke(new object[] { optionId });
                    return null;
                }

                string hiddenValue;
                if (!TryReadSafeActionValue(control, out hiddenValue))
                {
                    return "action-value-unavailable";
                }
                execute.DynamicInvoke(
                    new object[] { optionId, string.Empty });
                return null;
            }
            catch (TargetInvocationException ex)
            {
                Exception cause = ex.InnerException ?? ex;
                return "delegate-error: " + cause.Message;
            }
            catch (Exception ex)
            {
                return "delegate-error: " + ex.Message;
            }
        }

        private static bool TryReadSafeActionValue(
            object control,
            out string value)
        {
            value = ReadConfirmedInputValue(control);
            return value != null
                && value.Length <= MaxInputValueLength
                && !ContainsControlCharacters(value);
        }

        private static string InvokeValueDelegate(
            Delegate execute,
            string optionId,
            string value)
        {
            if (execute == null)
            {
                return "delegate-unavailable";
            }

            try
            {
                MethodInfo invoke = execute.GetType().GetMethod("Invoke");
                if (invoke == null)
                {
                    return "unsupported-delegate-signature";
                }
                ParameterInfo[] parameters = invoke.GetParameters();
                if (!HasSupportedStringDelegateSignature(parameters))
                {
                    return "unsupported-delegate-signature";
                }
                if (parameters.Length == 1)
                {
                    execute.DynamicInvoke(new object[] { optionId });
                }
                else if (parameters.Length == 2)
                {
                    execute.DynamicInvoke(
                        new object[] { optionId, string.Empty });
                }
                else
                {
                    return "unsupported-delegate-signature";
                }
                return null;
            }
            catch (TargetInvocationException ex)
            {
                Exception cause = ex.InnerException ?? ex;
                return "delegate-error: " + cause.Message;
            }
            catch (Exception ex)
            {
                return "delegate-error: " + ex.Message;
            }
        }

        private static bool HasSupportedStringDelegateSignature(
            ParameterInfo[] parameters)
        {
            if (parameters == null
                || (parameters.Length != 1 && parameters.Length != 2)
                || !CanAcceptString(parameters[0].ParameterType))
            {
                return false;
            }
            return parameters.Length == 1
                || CanAcceptString(parameters[1].ParameterType);
        }

        private static bool CanAcceptString(Type type)
        {
            return type != null && type.IsAssignableFrom(typeof(string));
        }

        private static TrainerOption FindSnapshotOption(
            MenuSnapshot snapshot,
            string optionId)
        {
            if (snapshot == null || snapshot.options == null)
            {
                return null;
            }
            for (int index = 0; index < snapshot.options.Count; index++)
            {
                TrainerOption option = snapshot.options[index];
                if (option != null
                    && string.Equals(
                        option.id,
                        optionId,
                        StringComparison.Ordinal))
                {
                    return option;
                }
            }
            return null;
        }

        private static string ValidateDesiredValue(
            TrainerOption option,
            string value,
            out string normalized)
        {
            normalized = null;
            if (value == null)
            {
                return "missing-value";
            }
            if (value.Length > MaxInputValueLength)
            {
                return "value-too-long";
            }
            if (ContainsControlCharacters(value))
            {
                return "value-has-control-characters";
            }

            if (string.Equals(
                    option.value_type,
                    "text",
                    StringComparison.Ordinal))
            {
                normalized = value;
                return null;
            }

            string candidate = value.Trim();
            if (candidate.Length == 0)
            {
                return "value-empty";
            }

            double numeric;
            if (string.Equals(
                    option.value_type,
                    "integer",
                    StringComparison.Ordinal))
            {
                long integer;
                if (!long.TryParse(
                        candidate,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out integer))
                {
                    return "value-not-integer";
                }
                numeric = integer;
            }
            else if (string.Equals(
                    option.value_type,
                    "number",
                    StringComparison.Ordinal))
            {
                if (!TryParseFiniteDouble(candidate, out numeric))
                {
                    return "value-not-finite-number";
                }
            }
            else
            {
                return "value-type-unsupported";
            }

            if (option.minimum.HasValue)
            {
                if (!IsFinite(option.minimum.Value))
                {
                    return "minimum-not-finite";
                }
                if (numeric < option.minimum.Value
                    && !NearlyEqual(numeric, option.minimum.Value))
                {
                    return "value-below-minimum";
                }
            }
            if (option.maximum.HasValue)
            {
                if (!IsFinite(option.maximum.Value))
                {
                    return "maximum-not-finite";
                }
                if (numeric > option.maximum.Value
                    && !NearlyEqual(numeric, option.maximum.Value))
                {
                    return "value-above-maximum";
                }
            }

            if (string.Equals(
                    option.kind,
                    "toggle_with_input_adjustment",
                    StringComparison.Ordinal)
                && option.step.HasValue)
            {
                double step = option.step.Value;
                if (!IsFinite(step) || step <= 0.0)
                {
                    return "step-invalid";
                }
                double origin = option.minimum.HasValue
                    ? option.minimum.Value
                    : 0.0;
                double units = (numeric - origin) / step;
                if (!IsFinite(units)
                    || !NearlyEqual(units, Math.Round(units)))
                {
                    return "value-step-mismatch";
                }
            }

            normalized = candidate;
            return null;
        }

        private static bool ValuesEquivalent(
            string first,
            string second,
            string valueType)
        {
            if (first == null || second == null)
            {
                return false;
            }
            if (string.Equals(valueType, "integer", StringComparison.Ordinal))
            {
                long left;
                long right;
                return long.TryParse(
                        first,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out left)
                    && long.TryParse(
                        second,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out right)
                    && left == right;
            }
            if (string.Equals(valueType, "number", StringComparison.Ordinal))
            {
                double left;
                double right;
                return TryParseFiniteDouble(first, out left)
                    && TryParseFiniteDouble(second, out right)
                    && NearlyEqual(left, right);
            }
            return string.Equals(first, second, StringComparison.Ordinal);
        }

        private static bool TryParseFiniteDouble(
            string value,
            out double parsed)
        {
            return double.TryParse(
                    value,
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out parsed)
                && IsFinite(parsed);
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static bool NearlyEqual(double first, double second)
        {
            double scale = Math.Max(
                1.0,
                Math.Max(Math.Abs(first), Math.Abs(second)));
            return Math.Abs(first - second) <= 1.0e-9 * scale;
        }

        private static bool ContainsControlCharacters(string value)
        {
            for (int index = 0; index < value.Length; index++)
            {
                if (char.IsControl(value[index]))
                {
                    return true;
                }
            }
            return false;
        }

        private static InputWriteTarget FindInputWriteTarget(object control)
        {
            if (control == null)
            {
                return null;
            }

            MethodInfo setter = FindStringInputSetter(control.GetType());
            if (setter != null)
            {
                return new InputWriteTarget(
                    control,
                    setter,
                    null,
                    typeof(string));
            }

            PropertyInfo direct = FindWritableProperty(
                control.GetType(),
                "Value");
            if (direct != null && IsSupportedWritableType(direct.PropertyType))
            {
                return new InputWriteTarget(
                    control,
                    null,
                    direct,
                    direct.PropertyType);
            }

            object slider = GetMemberValue(control, "m_slider");
            PropertyInfo sliderValue = slider == null
                ? null
                : FindWritableProperty(slider.GetType(), "Value");
            if (sliderValue != null
                && IsSupportedWritableType(sliderValue.PropertyType))
            {
                return new InputWriteTarget(
                    slider,
                    null,
                    sliderValue,
                    sliderValue.PropertyType);
            }

            object textBox = GetMemberValue(control, "m_textbox");
            PropertyInfo text = textBox == null
                ? null
                : FindWritableProperty(textBox.GetType(), "Text");
            if (text != null && text.PropertyType == typeof(string))
            {
                return new InputWriteTarget(
                    textBox,
                    null,
                    text,
                    typeof(string));
            }

            return null;
        }

        private static MethodInfo FindStringInputSetter(Type type)
        {
            Type current = type;
            while (current != null)
            {
                MethodInfo[] methods = current.GetMethods(InstanceFlags);
                for (int index = 0; index < methods.Length; index++)
                {
                    MethodInfo method = methods[index];
                    ParameterInfo[] parameters = method.GetParameters();
                    if (string.Equals(
                            method.Name,
                            "SetInputValue",
                            StringComparison.Ordinal)
                        && !method.IsStatic
                        && parameters.Length == 1
                        && parameters[0].ParameterType == typeof(string))
                    {
                        return method;
                    }
                }
                current = current.BaseType;
            }
            return null;
        }

        private static bool TryWriteInputValue(
            InputWriteTarget target,
            string value,
            out string error)
        {
            try
            {
                if (target.Method != null)
                {
                    target.Method.Invoke(target.Target, new object[] { value });
                    error = null;
                    return true;
                }

                object converted;
                if (!TryConvertInputValue(
                        value,
                        target.ValueType,
                        out converted))
                {
                    error = "value-conversion-failed";
                    return false;
                }
                MethodInfo setter = target.Property.GetSetMethod(true);
                setter.Invoke(target.Target, new[] { converted });
                error = null;
                return true;
            }
            catch (TargetInvocationException ex)
            {
                Exception cause = ex.InnerException ?? ex;
                error = "input-write-error: " + cause.Message;
                return false;
            }
            catch (Exception ex)
            {
                error = "input-write-error: " + ex.Message;
                return false;
            }
        }

        private static void TryRestoreInputValue(
            InputWriteTarget target,
            string value)
        {
            string ignored;
            TryWriteInputValue(target, value, out ignored);
        }

        private static bool TryConvertInputValue(
            string value,
            Type destinationType,
            out object converted)
        {
            Type underlying = Nullable.GetUnderlyingType(destinationType)
                ?? destinationType;
            try
            {
                if (underlying == typeof(string))
                {
                    converted = value;
                    return true;
                }
                if (!IsSupportedWritableType(underlying))
                {
                    converted = null;
                    return false;
                }

                if (underlying == typeof(double)
                    || underlying == typeof(float))
                {
                    double numeric;
                    if (!TryParseFiniteDouble(value, out numeric))
                    {
                        converted = null;
                        return false;
                    }
                }
                converted = Convert.ChangeType(
                    value,
                    underlying,
                    CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                converted = null;
                return false;
            }
        }

        private static bool IsSupportedWritableType(Type type)
        {
            Type underlying = Nullable.GetUnderlyingType(type) ?? type;
            return underlying == typeof(string)
                || IsIntegerType(underlying)
                || IsNumericType(underlying);
        }

        private static bool IsIntegerType(Type type)
        {
            return type == typeof(byte)
                || type == typeof(sbyte)
                || type == typeof(short)
                || type == typeof(ushort)
                || type == typeof(int)
                || type == typeof(uint)
                || type == typeof(long)
                || type == typeof(ulong);
        }

        private static bool IsNumericType(Type type)
        {
            return type == typeof(float)
                || type == typeof(double)
                || type == typeof(decimal);
        }

        private object FindOptionControl(string optionId)
        {
            List<ControlBinding> controls = ReadOptionControls();
            MenuDefinitionSnapshot definition = ReadMenuDefinition();
            bool mergeDefinition = definition != null
                && definition.options != null
                && definition.options.Count == controls.Count;
            for (int index = 0; index < controls.Count; index++)
            {
                ControlBinding binding = controls[index];
                string id = binding.OptionId;
                if (FrameworkCompat.IsNullOrWhiteSpace(id) && mergeDefinition)
                {
                    MenuDefinitionOption defined =
                        definition.options[index];
                    if (defined != null)
                    {
                        id = defined.id;
                    }
                }

                if (string.Equals(id, optionId, StringComparison.Ordinal))
                {
                    return binding.Control;
                }
            }

            return null;
        }

        private bool ReadGameRunning()
        {
            bool? value = ReadNullableBoolean(mainWindow, "IsGameRunning");
            return value.HasValue && value.Value;
        }

        private bool? ReadToggledState(object control)
        {
            // Toggled is a Boolean on some generations and an event on others.
            // ReadNullableBoolean deliberately rejects the event form.
            bool? direct = ReadNullableBoolean(control, "Toggled");
            if (direct.HasValue)
            {
                return direct;
            }

            string directMember = uiFramework == UiFramework.Wpf
                ? "IsChecked"
                : "Checked";
            direct = ReadNullableBoolean(control, directMember);
            if (direct.HasValue)
            {
                return direct;
            }

            object toggleButton = GetMemberValue(control, "m_toggle_button");
            bool? checkedValue = ReadNullableBoolean(
                toggleButton,
                "Toggled");
            if (checkedValue.HasValue)
            {
                return checkedValue;
            }

            checkedValue = ReadNullableBoolean(
                toggleButton,
                uiFramework == UiFramework.Wpf ? "IsChecked" : "Checked");
            if (checkedValue.HasValue)
            {
                return checkedValue;
            }

            if (uiFramework == UiFramework.WinForms)
            {
                // Older WinForms controls sometimes encode state only through
                // their PictureBox image. Accept that baseline only when the
                // image is the exact toggle_on/off resource object or has an
                // exact dimension-and-ARGB fingerprint match. Never infer it
                // from color, filename, or another appearance heuristic.
                return ReadStrictWinFormsImageState(toggleButton);
            }

            return null;
        }

        private bool ReadAvailable(object control)
        {
            string preferred = uiFramework == UiFramework.Wpf
                ? "IsEnabled"
                : "Enabled";
            string fallback = uiFramework == UiFramework.Wpf
                ? "Enabled"
                : "IsEnabled";
            bool? value = ReadNullableBoolean(control, preferred);
            if (!value.HasValue)
            {
                value = ReadNullableBoolean(control, fallback);
            }

            return !value.HasValue || value.Value;
        }

        private static string ReadInputValue(object control)
        {
            string confirmed = ReadConfirmedInputValue(control);
            if (confirmed != null)
            {
                return confirmed;
            }

            object valueLabel = GetMemberValue(
                control,
                "m_label_value");
            return ConvertToString(GetMemberValue(valueLabel, "Text"));
        }

        private static string ReadConfirmedInputValue(object control)
        {
            MethodInfo method = FindMethod(control, "GetInputValue", 0);
            if (method != null)
            {
                try
                {
                    string value = ConvertToString(
                        method.Invoke(control, new object[0]));
                    if (value != null)
                    {
                        return value;
                    }
                }
                catch
                {
                }
            }

            object direct = GetMemberValue(control, "Value");
            if (direct == null)
            {
                object textBox = GetMemberValue(control, "m_textbox");
                direct = GetMemberValue(textBox, "Text");
            }
            if (direct == null)
            {
                object slider = GetMemberValue(control, "m_slider");
                direct = GetMemberValue(slider, "Value");
            }

            return ConvertToString(direct);
        }

        private static Dictionary<string, string> ReadLanguageTexts(
            object source,
            string methodName,
            string collectionMember,
            string currentMember)
        {
            Dictionary<string, string> values =
                new Dictionary<string, string>();

            for (int index = 0; index < LanguageKeys.Length; index++)
            {
                string text = null;
                MethodInfo method = FindMethod(source, methodName, 1);
                if (method != null)
                {
                    try
                    {
                        text = ConvertToString(
                            method.Invoke(source, new object[] { index }));
                    }
                    catch
                    {
                        text = null;
                    }
                }

                if (text == null)
                {
                    object collection = GetMemberValue(source, collectionMember);
                    text = ReadIndexedText(collection, index);
                }

                if (!FrameworkCompat.IsNullOrWhiteSpace(text))
                {
                    values[LanguageKeys[index]] = text.Trim();
                }
            }

            if (values.Count == 0 && !FrameworkCompat.IsNullOrWhiteSpace(currentMember))
            {
                string current = ConvertToString(
                    GetMemberValue(source, currentMember));
                if (!FrameworkCompat.IsNullOrWhiteSpace(current))
                {
                    values["current"] = current.Trim();
                }
            }

            return values;
        }

        private static string ReadIndexedText(object collection, int index)
        {
            if (collection == null)
            {
                return null;
            }

            IDictionary dictionary = collection as IDictionary;
            if (dictionary != null && dictionary.Contains(index))
            {
                return ConvertToString(dictionary[index]);
            }

            IList list = collection as IList;
            if (list != null && index >= 0 && index < list.Count)
            {
                return ConvertToString(list[index]);
            }

            PropertyInfo item = FindProperty(collection.GetType(), "Item");
            if (item != null)
            {
                ParameterInfo[] parameters = item.GetIndexParameters();
                if (parameters.Length == 1)
                {
                    try
                    {
                        return ConvertToString(
                            item.GetValue(collection, new object[] { index }));
                    }
                    catch
                    {
                        return null;
                    }
                }
            }

            return null;
        }

        private static Dictionary<string, string> NormalizeTooltips(
            IDictionary<string, string> raw,
            out bool important)
        {
            Dictionary<string, string> normalized =
                new Dictionary<string, string>();
            important = false;

            foreach (KeyValuePair<string, string> pair in raw)
            {
                string value = pair.Value ?? string.Empty;
                if (ImportantMarker.IsMatch(value))
                {
                    important = true;
                    value = ImportantMarker.Replace(value, string.Empty);
                }

                value = value
                    .Replace("\\r\\n", "\n")
                    .Replace("\\n", "\n")
                    .Replace("\\r", "\n")
                    .Replace("\r\n", "\n")
                    .Replace('\r', '\n');
                value = value.Trim();
                if (value.Length > 0)
                {
                    normalized[pair.Key] = value;
                }
            }

            return normalized;
        }

        private static bool HasRedWarningVisual(object control)
        {
            object tooltip = GetMemberValue(control, "m_tooltip");
            if (tooltip == null)
            {
                return false;
            }

            string[] brushMembers =
            {
                "Foreground",
                "Background",
                "BorderBrush",
                "Fill"
            };

            for (int index = 0; index < brushMembers.Length; index++)
            {
                object brush = GetMemberValue(tooltip, brushMembers[index]);
                if (brush != null && LooksRed(brush.ToString()))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool LooksRed(string value)
        {
            if (FrameworkCompat.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            string hex = value.Trim();
            if (!hex.StartsWith("#", StringComparison.Ordinal))
            {
                return hex.IndexOf("red", StringComparison.OrdinalIgnoreCase) >= 0;
            }

            hex = hex.Substring(1);
            if (hex.Length == 8)
            {
                hex = hex.Substring(2);
            }

            if (hex.Length != 6)
            {
                return false;
            }

            int red;
            int green;
            int blue;
            if (!int.TryParse(
                    hex.Substring(0, 2),
                    NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture,
                    out red)
                || !int.TryParse(
                    hex.Substring(2, 2),
                    NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture,
                    out green)
                || !int.TryParse(
                    hex.Substring(4, 2),
                    NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture,
                    out blue))
            {
                return false;
            }

            return red >= 180
                && green <= 110
                && blue <= 110
                && red >= (green * 3) / 2;
        }

        private bool? ReadStrictWinFormsImageState(object toggleButton)
        {
            if (toggleButton == null)
            {
                return null;
            }

            object current = GetMemberValue(toggleButton, "Image");
            if (current == null)
            {
                return null;
            }

            EnsureToggleResources();
            if (toggleOnResource == null
                || toggleOffResource == null
                || object.ReferenceEquals(
                    toggleOnResource,
                    toggleOffResource))
            {
                return null;
            }

            if (object.ReferenceEquals(current, toggleOnResource))
            {
                return true;
            }
            if (object.ReferenceEquals(current, toggleOffResource))
            {
                return false;
            }

            if (toggleOnFingerprint == null
                || toggleOffFingerprint == null
                || string.Equals(
                    toggleOnFingerprint,
                    toggleOffFingerprint,
                    StringComparison.Ordinal))
            {
                return null;
            }

            string currentFingerprint = ComputeImageFingerprint(current);
            if (string.Equals(
                    currentFingerprint,
                    toggleOnFingerprint,
                    StringComparison.Ordinal))
            {
                return true;
            }
            if (string.Equals(
                    currentFingerprint,
                    toggleOffFingerprint,
                    StringComparison.Ordinal))
            {
                return false;
            }

            return null;
        }

        private void EnsureToggleResources()
        {
            if (toggleResourcesLoaded)
            {
                return;
            }

            toggleResourcesLoaded = true;
            toggleOnResource = ReadStaticResource("toggle_on");
            toggleOffResource = ReadStaticResource("toggle_off");
            toggleOnFingerprint = ComputeImageFingerprint(
                toggleOnResource);
            toggleOffFingerprint = ComputeImageFingerprint(
                toggleOffResource);
        }

        private static string ComputeImageFingerprint(object image)
        {
            if (image == null)
            {
                return null;
            }

            try
            {
                object widthValue = GetMemberValue(image, "Width");
                object heightValue = GetMemberValue(image, "Height");
                int width = Convert.ToInt32(
                    widthValue,
                    CultureInfo.InvariantCulture);
                int height = Convert.ToInt32(
                    heightValue,
                    CultureInfo.InvariantCulture);
                if (width <= 0
                    || height <= 0
                    || width > 1024
                    || height > 1024
                    || ((long)width * height) > 1048576L)
                {
                    return null;
                }

                MethodInfo getPixel = FindMethod(image, "GetPixel", 2);
                if (getPixel == null)
                {
                    return null;
                }

                byte[] pixels = new byte[checked(8 + (width * height * 4))];
                WriteInt32(pixels, 0, width);
                WriteInt32(pixels, 4, height);
                int offset = 8;
                for (int y = 0; y < height; y++)
                {
                    for (int x = 0; x < width; x++)
                    {
                        object color = getPixel.Invoke(
                            image,
                            new object[] { x, y });
                        MethodInfo toArgb = FindMethod(
                            color,
                            "ToArgb",
                            0);
                        if (toArgb == null)
                        {
                            return null;
                        }

                        int argb = Convert.ToInt32(
                            toArgb.Invoke(color, new object[0]),
                            CultureInfo.InvariantCulture);
                        WriteInt32(pixels, offset, argb);
                        offset += 4;
                    }
                }

                using (SHA256 sha = SHA256.Create())
                {
                    return Convert.ToBase64String(
                        sha.ComputeHash(pixels));
                }
            }
            catch
            {
                return null;
            }
        }

        private static void WriteInt32(
            byte[] destination,
            int offset,
            int value)
        {
            destination[offset] = (byte)(value & 0xff);
            destination[offset + 1] = (byte)((value >> 8) & 0xff);
            destination[offset + 2] = (byte)((value >> 16) & 0xff);
            destination[offset + 3] = (byte)((value >> 24) & 0xff);
        }

        private object ReadStaticResource(string resourceName)
        {
            try
            {
                Assembly assembly = mainWindow.GetType().Assembly;
                string ownerNamespace = mainWindow.GetType().Namespace
                    ?? string.Empty;
                Type resources = assembly.GetType(
                    ownerNamespace + ".Properties.Resources",
                    false,
                    true);
                if (resources == null)
                {
                    return null;
                }

                PropertyInfo property = resources.GetProperty(
                    resourceName,
                    StaticFlags | BindingFlags.IgnoreCase);
                if (property != null
                    && property.GetIndexParameters().Length == 0)
                {
                    return property.GetValue(null, null);
                }

                FieldInfo field = resources.GetField(
                    resourceName,
                    StaticFlags | BindingFlags.IgnoreCase);
                return field == null ? null : field.GetValue(null);
            }
            catch
            {
                return null;
            }
        }

        private static string DetermineKind(string typeName)
        {
            if (typeName.IndexOf(
                    "SetValue",
                    StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "action";
            }

            if (typeName.IndexOf(
                    "InputAdjustment",
                    StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "toggle_with_input_adjustment";
            }

            if (typeName.IndexOf(
                    "WithInput",
                    StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "toggle_with_input";
            }

            if (string.Equals(
                    typeName,
                    "CheatOption",
                    StringComparison.OrdinalIgnoreCase))
            {
                return "toggle";
            }

            if (typeName.IndexOf(
                    "Input",
                    StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "input";
            }

            return "unknown";
        }

        private static bool IsControllableKind(string kind)
        {
            return string.Equals(kind, "toggle", StringComparison.Ordinal)
                || string.Equals(
                    kind,
                    "toggle_with_input",
                    StringComparison.Ordinal)
                || string.Equals(
                    kind,
                    "toggle_with_input_adjustment",
                    StringComparison.Ordinal);
        }

        private static bool IsValueKind(string kind)
        {
            return string.Equals(kind, "action", StringComparison.Ordinal)
                || string.Equals(kind, "input", StringComparison.Ordinal)
                || string.Equals(
                    kind,
                    "toggle_with_input",
                    StringComparison.Ordinal)
                || string.Equals(
                    kind,
                    "toggle_with_input_adjustment",
                    StringComparison.Ordinal);
        }

        private static string ValueApplyModeForKind(string kind)
        {
            if (string.Equals(kind, "action", StringComparison.Ordinal)
                || string.Equals(kind, "input", StringComparison.Ordinal))
            {
                return "invoke";
            }
            if (string.Equals(
                    kind,
                    "toggle_with_input",
                    StringComparison.Ordinal)
                || string.Equals(
                    kind,
                    "toggle_with_input_adjustment",
                    StringComparison.Ordinal))
            {
                return "stage_then_toggle";
            }
            return "none";
        }

        private static bool IsKnownValueType(string valueType)
        {
            return string.Equals(valueType, "none", StringComparison.Ordinal)
                || string.Equals(
                    valueType,
                    "integer",
                    StringComparison.Ordinal)
                || string.Equals(
                    valueType,
                    "number",
                    StringComparison.Ordinal)
                || string.Equals(valueType, "text", StringComparison.Ordinal);
        }

        private static bool IsKnownValueApplyMode(string applyMode)
        {
            return string.Equals(applyMode, "none", StringComparison.Ordinal)
                || string.Equals(
                    applyMode,
                    "invoke",
                    StringComparison.Ordinal)
                || string.Equals(
                    applyMode,
                    "stage_then_toggle",
                    StringComparison.Ordinal);
        }

        private static MethodInfo FindDispatcherMethod(
            Type dispatcherType,
            string methodName)
        {
            Type current = dispatcherType;
            while (current != null)
            {
                MethodInfo[] methods = current.GetMethods(InstanceFlags);
                for (int index = 0; index < methods.Length; index++)
                {
                    MethodInfo method = methods[index];
                    if (!string.Equals(
                            method.Name,
                            methodName,
                            StringComparison.Ordinal))
                    {
                        continue;
                    }

                    ParameterInfo[] parameters = method.GetParameters();
                    if (parameters.Length == 2
                        && parameters[0].ParameterType == typeof(Delegate)
                        && parameters[1].ParameterType == typeof(object[]))
                    {
                        return method;
                    }
                }

                current = current.BaseType;
            }

            return null;
        }

        private static string ComputeUiFingerprint(Type mainWindowType)
        {
            string identity = mainWindowType.Assembly.FullName
                + "|"
                + mainWindowType.Assembly.ManifestModule.ModuleVersionId
                    .ToString("D");
            byte[] bytes = new UTF8Encoding(false).GetBytes(identity);
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder text = new StringBuilder(hash.Length * 2);
                for (int index = 0; index < hash.Length; index++)
                {
                    text.Append(hash[index].ToString("x2"));
                }

                return text.ToString();
            }
        }

        private static bool? ReadNullableBoolean(object source, string memberName)
        {
            object value = GetMemberValue(source, memberName);
            if (value is bool)
            {
                return (bool)value;
            }

            return null;
        }

        private static double? ReadNullableDouble(object source, string memberName)
        {
            object value = GetMemberValue(source, memberName);
            if (value == null)
            {
                return null;
            }

            try
            {
                double converted = Convert.ToDouble(
                    value,
                    CultureInfo.InvariantCulture);
                return IsFinite(converted) ? (double?)converted : null;
            }
            catch
            {
                return null;
            }
        }

        private static string ConvertToString(object value)
        {
            return value == null
                ? null
                : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static object GetMemberValue(object source, string memberName)
        {
            if (source == null || FrameworkCompat.IsNullOrWhiteSpace(memberName))
            {
                return null;
            }

            Type current = source.GetType();
            while (current != null)
            {
                FieldInfo field = current.GetField(memberName, InstanceFlags);
                if (field != null)
                {
                    try
                    {
                        return field.GetValue(source);
                    }
                    catch
                    {
                        return null;
                    }
                }

                PropertyInfo property = current.GetProperty(
                    memberName,
                    InstanceFlags);
                if (property != null && property.GetIndexParameters().Length == 0)
                {
                    try
                    {
                        return property.GetValue(source, null);
                    }
                    catch
                    {
                        return null;
                    }
                }

                current = current.BaseType;
            }

            return null;
        }

        private static MethodInfo FindMethod(
            object source,
            string methodName,
            int parameterCount)
        {
            return source == null
                ? null
                : FindMethod(source.GetType(), methodName, parameterCount);
        }

        private static MethodInfo FindMethod(
            Type type,
            string methodName,
            int parameterCount)
        {
            Type current = type;
            while (current != null)
            {
                MethodInfo[] methods = current.GetMethods(InstanceFlags);
                for (int index = 0; index < methods.Length; index++)
                {
                    MethodInfo method = methods[index];
                    if (string.Equals(
                            method.Name,
                            methodName,
                            StringComparison.Ordinal)
                        && method.GetParameters().Length == parameterCount)
                    {
                        return method;
                    }
                }

                current = current.BaseType;
            }

            return null;
        }

        private static PropertyInfo FindProperty(Type type, string propertyName)
        {
            Type current = type;
            while (current != null)
            {
                PropertyInfo property = current.GetProperty(
                    propertyName,
                    InstanceFlags);
                if (property != null)
                {
                    return property;
                }

                current = current.BaseType;
            }

            return null;
        }

        private static PropertyInfo FindWritableProperty(
            Type type,
            string propertyName)
        {
            Type current = type;
            while (current != null)
            {
                PropertyInfo property = current.GetProperty(
                    propertyName,
                    InstanceFlags);
                if (property != null
                    && property.GetIndexParameters().Length == 0
                    && property.GetSetMethod(true) != null)
                {
                    return property;
                }
                current = current.BaseType;
            }
            return null;
        }

        private static CommandResult Rejected(string reason)
        {
            return new CommandResult
            {
                status = "rejected",
                error = reason
            };
        }

        private enum UiFramework
        {
            Wpf,
            WinForms
        }

        private sealed class ControlBinding
        {
            public object Control { get; set; }

            public string OptionId { get; set; }

            public Dictionary<string, string> Group { get; set; }
        }

        private sealed class InputWriteTarget
        {
            public InputWriteTarget(
                object target,
                MethodInfo method,
                PropertyInfo property,
                Type valueType)
            {
                Target = target;
                Method = method;
                Property = property;
                ValueType = valueType;
            }

            public object Target { get; private set; }

            public MethodInfo Method { get; private set; }

            public PropertyInfo Property { get; private set; }

            public Type ValueType { get; private set; }
        }
    }
}
