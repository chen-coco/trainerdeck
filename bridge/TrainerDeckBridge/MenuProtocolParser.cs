using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TrainerDeckBridge
{
    internal sealed class MenuDefinitionSnapshot
    {
        public MenuDefinitionSnapshot()
        {
            options = new List<MenuDefinitionOption>();
        }

        public List<MenuDefinitionOption> options { get; private set; }
    }

    internal sealed class MenuDefinitionOption
    {
        public MenuDefinitionOption()
        {
            labels = new Dictionary<string, string>();
            tooltips = new Dictionary<string, string>();
            group = new Dictionary<string, string>();
            tooltip_style = "normal";
        }

        public string id { get; set; }

        public string kind { get; set; }

        public string tooltip_style { get; set; }

        public string value { get; set; }

        public string value_type { get; set; }

        public string value_apply_mode { get; set; }

        public bool action_without_input { get; set; }

        public Dictionary<string, string> labels { get; set; }

        public Dictionary<string, string> tooltips { get; set; }

        public Dictionary<string, string> group { get; set; }

        public double? minimum { get; set; }

        public double? maximum { get; set; }

        public double? step { get; set; }
    }

    internal static class MenuProtocolParser
    {
        private const string ChineseKey = "zh_cn";
        private const string EnglishKey = "en";
        private const string OptionDelimiter = " - ";

        private static readonly Regex ImportantMarker = new Regex(
            "\\{important\\}",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly Regex ExplicitIdSuffix = new Regex(
            "(?:^|\\s)--(?<id>[A-Za-z_][A-Za-z0-9_-]*)\\s*$",
            RegexOptions.CultureInvariant);

        public static MenuDefinitionSnapshot Parse(
            string chinese,
            string english)
        {
            string[] chineseLines = NormalizePayload(chinese, "Chinese");
            string[] englishLines = NormalizePayload(english, "English");
            if (chineseLines.Length != englishLines.Length)
            {
                throw new FormatException(
                    string.Format(
                        CultureInfo.InvariantCulture,
                        "Menu language line counts differ: Chinese={0}, "
                            + "English={1}.",
                        chineseLines.Length,
                        englishLines.Length));
            }

            MenuDefinitionSnapshot snapshot = new MenuDefinitionSnapshot();
            Dictionary<string, string> currentGroup =
                new Dictionary<string, string>();
            HashSet<string> explicitIds = new HashSet<string>(
                StringComparer.Ordinal);

            for (int index = 0; index < chineseLines.Length; index++)
            {
                int lineNumber = index + 1;
                string chineseLine = NormalizeLine(chineseLines[index]);
                string englishLine = NormalizeLine(englishLines[index]);
                LineKind chineseKind = ClassifyLine(
                    chineseLine,
                    lineNumber,
                    ChineseKey);
                LineKind englishKind = ClassifyLine(
                    englishLine,
                    lineNumber,
                    EnglishKey);

                if (chineseKind == LineKind.Blank)
                {
                    if (englishKind != LineKind.Blank)
                    {
                        ThrowAlignment(
                            lineNumber,
                            chineseKind,
                            englishKind);
                    }
                    continue;
                }

                if (chineseKind == LineKind.Split)
                {
                    if (englishKind != LineKind.Split
                        && englishKind != LineKind.Blank)
                    {
                        ThrowAlignment(
                            lineNumber,
                            chineseKind,
                            englishKind);
                    }
                    continue;
                }

                if (chineseKind == LineKind.Label)
                {
                    if (englishKind != LineKind.Label
                        && englishKind != LineKind.Option)
                    {
                        ThrowAlignment(
                            lineNumber,
                            chineseKind,
                            englishKind);
                    }

                    LocalizedText chineseGroup = ParseLabelLine(
                        chineseLine,
                        lineNumber,
                        ChineseKey,
                        true);
                    LocalizedText englishGroup = ParseLabelLine(
                        englishLine,
                        lineNumber,
                        EnglishKey,
                        englishKind == LineKind.Label);
                    currentGroup = CreateLocalizedDictionary(
                        chineseGroup.label,
                        englishGroup.label);
                    continue;
                }

                if (chineseKind != LineKind.Option
                    || englishKind == LineKind.Blank
                    || englishKind == LineKind.Split
                    || englishKind == LineKind.Label)
                {
                    ThrowAlignment(lineNumber, chineseKind, englishKind);
                }

                ParsedOption chineseOption = ParseOptionLine(
                    chineseLine,
                    lineNumber,
                    ChineseKey,
                    true);
                ParsedOption englishOption = ParseOptionLine(
                    englishLine,
                    lineNumber,
                    EnglishKey,
                    false);
                ValidateLocalizedOptions(
                    chineseOption,
                    englishOption,
                    lineNumber);

                string id = MergeExplicitIds(
                    chineseOption.id,
                    englishOption.id,
                    lineNumber);
                if (!string.IsNullOrEmpty(id) && !explicitIds.Add(id))
                {
                    throw LineError(
                        lineNumber,
                        "Duplicate explicit option ID '" + id + "'.");
                }

                MenuDefinitionOption option = new MenuDefinitionOption();
                option.id = id;
                option.kind = chineseOption.widget.kind;
                option.labels = CreateLocalizedDictionary(
                    chineseOption.text.label,
                    englishOption.text.label);
                option.group = new Dictionary<string, string>(currentGroup);
                AddLocalizedTooltip(
                    option.tooltips,
                    ChineseKey,
                    chineseOption.text.tooltip);
                AddLocalizedTooltip(
                    option.tooltips,
                    EnglishKey,
                    englishOption.text.tooltip);
                option.tooltip_style =
                    chineseOption.text.important
                    || englishOption.text.important
                        ? "important"
                        : "normal";
                option.value = FirstNonNull(
                    chineseOption.widget.defaultValue,
                    englishOption.widget.defaultValue);
                option.value_type = FirstNonNull(
                    chineseOption.widget.valueType,
                    englishOption.widget.valueType);
                option.value_apply_mode = FirstNonNull(
                    chineseOption.widget.valueApplyMode,
                    englishOption.widget.valueApplyMode);
                option.action_without_input =
                    chineseOption.widget.actionWithoutInput;
                option.minimum = FirstNonNull(
                    chineseOption.widget.minimum,
                    englishOption.widget.minimum);
                option.maximum = FirstNonNull(
                    chineseOption.widget.maximum,
                    englishOption.widget.maximum);
                option.step = FirstNonNull(
                    chineseOption.widget.step,
                    englishOption.widget.step);
                snapshot.options.Add(option);
            }

            if (snapshot.options.Count == 0)
            {
                throw new FormatException(
                    "The menu payload contains no actionable options.");
            }

            return snapshot;
        }

        private static string[] NormalizePayload(
            string payload,
            string language)
        {
            if (payload == null)
            {
                throw new FormatException(
                    language + " menu payload is null.");
            }

            string normalized = payload
                .Replace("\r\n", "\n")
                .Replace('\r', '\n')
                .Trim();
            if (normalized.Length == 0)
            {
                throw new FormatException(
                    language + " menu payload is empty.");
            }

            return normalized.Split(
                new[] { '\n' },
                StringSplitOptions.None);
        }

        private static string NormalizeLine(string line)
        {
            return UnescapeAmpersands(line == null
                ? string.Empty
                : line.Trim());
        }

        private static string UnescapeAmpersands(string value)
        {
            if (value.IndexOf("&&", StringComparison.Ordinal) < 0)
            {
                return value;
            }

            StringBuilder result = new StringBuilder(value.Length);
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                result.Append(current);
                if (current == '&'
                    && index + 1 < value.Length
                    && value[index + 1] == '&')
                {
                    index++;
                }
            }
            return result.ToString();
        }

        private static LineKind ClassifyLine(
            string line,
            int lineNumber,
            string language)
        {
            if (line.Length == 0)
            {
                return LineKind.Blank;
            }

            if (line.StartsWith(
                    "<label>",
                    StringComparison.OrdinalIgnoreCase))
            {
                return LineKind.Label;
            }

            if (line.StartsWith(
                    "<label",
                    StringComparison.OrdinalIgnoreCase))
            {
                throw LineError(
                    lineNumber,
                    language + " menu contains a malformed <label> tag.");
            }

            if (line.StartsWith(
                    "<split",
                    StringComparison.OrdinalIgnoreCase))
            {
                if (!string.Equals(
                        line,
                        "<split>",
                        StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(
                        line,
                        "<split />",
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " menu contains an unknown <split> form.");
                }
                return LineKind.Split;
            }

            return LineKind.Option;
        }

        private static LocalizedText ParseLabelLine(
            string line,
            int lineNumber,
            string language,
            bool tagged)
        {
            string body = tagged
                ? line.Substring("<label>".Length).Trim()
                : line.Trim();
            if (body.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language + " group label is empty.");
            }
            if (body[0] == '<')
            {
                throw LineError(
                    lineNumber,
                    language + " group label contains an unknown tag.");
            }

            return ParseLocalizedText(body, lineNumber, language);
        }

        private static ParsedOption ParseOptionLine(
            string line,
            int lineNumber,
            string language,
            bool requireHeader)
        {
            string normalized = line.Replace(
                " - - ",
                "Minus - ");
            int delimiter = normalized.IndexOf(
                OptionDelimiter,
                StringComparison.Ordinal);
            string header;
            string body;
            if (delimiter < 0)
            {
                if (requireHeader)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " option is missing the hotkey/label delimiter.");
                }

                header = string.Empty;
                body = normalized.Trim();
            }
            else
            {
                header = normalized.Substring(0, delimiter).Trim();
                body = normalized.Substring(
                    delimiter + OptionDelimiter.Length).Trim();
                if (header.Length == 0)
                {
                    throw LineError(
                        lineNumber,
                        language + " option header is empty.");
                }
            }

            if (body.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language + " option label is empty.");
            }

            string headerId = ParseExplicitId(
                header,
                lineNumber,
                language);
            ParsedWidget widget = ParseWidget(
                body,
                lineNumber,
                language);
            LocalizedText text = ParseLocalizedText(
                widget.label,
                lineNumber,
                language);
            string suffixId;
            text = StripExplicitIdSuffix(
                text,
                lineNumber,
                language,
                out suffixId);
            if (!string.IsNullOrEmpty(headerId)
                && !string.IsNullOrEmpty(suffixId)
                && !string.Equals(
                    headerId,
                    suffixId,
                    StringComparison.Ordinal))
            {
                throw LineError(
                    lineNumber,
                    language + " option carries conflicting explicit IDs.");
            }

            return new ParsedOption(
                FirstNonNull(headerId, suffixId),
                widget,
                text);
        }

        private static LocalizedText StripExplicitIdSuffix(
            LocalizedText text,
            int lineNumber,
            string language,
            out string id)
        {
            Match match = ExplicitIdSuffix.Match(text.label);
            if (!match.Success)
            {
                id = null;
                return text;
            }

            id = match.Groups["id"].Value;
            string label = text.label.Substring(0, match.Index).Trim();
            if (label.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language + " option ID has no preceding label.");
            }

            return new LocalizedText(
                label,
                text.tooltip,
                text.important);
        }

        private static string ParseExplicitId(
            string header,
            int lineNumber,
            string language)
        {
            if (header.Length == 0)
            {
                return null;
            }

            int dot = header.IndexOf('.');
            bool markedExplicit = header[0] == '_';
            if (dot <= 0)
            {
                if (markedExplicit)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " option has a malformed explicit ID.");
                }
                return null;
            }

            string candidate = header.Substring(0, dot);
            if (candidate.Length > 0 && candidate[0] == '_')
            {
                candidate = candidate.Substring(1);
            }

            if (!IsValidId(candidate))
            {
                if (markedExplicit)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " option has an invalid explicit ID.");
                }
                return null;
            }

            string hotkey = header.Substring(dot + 1)
                .Replace("Minus", "-")
                .Trim();
            if (hotkey.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language
                        + " option has an explicit ID but no hotkey token.");
            }

            return candidate;
        }

        private static bool IsValidId(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            char first = value[0];
            if (!(first == '_' || IsAsciiLetter(first)))
            {
                return false;
            }

            for (int index = 1; index < value.Length; index++)
            {
                char current = value[index];
                if (!(current == '_'
                    || current == '-'
                    || IsAsciiLetter(current)
                    || char.IsDigit(current)))
                {
                    return false;
                }
            }
            return true;
        }

        private static bool IsAsciiLetter(char value)
        {
            return (value >= 'a' && value <= 'z')
                || (value >= 'A' && value <= 'Z');
        }

        private static ParsedWidget ParseWidget(
            string body,
            int lineNumber,
            string language)
        {
            if (body[0] != '<')
            {
                return ParsedWidget.Toggle(body);
            }

            int close = body.IndexOf('>');
            if (close < 0)
            {
                throw LineError(
                    lineNumber,
                    language + " option contains an unterminated widget tag.");
            }

            string opening = body.Substring(1, close - 1).Trim();
            string label = body.Substring(close + 1).Trim();
            if (label.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language + " widget option label is empty.");
            }

            int separator = FindWhitespace(opening);
            string tagName = separator < 0
                ? opening
                : opening.Substring(0, separator);
            string attributesText = separator < 0
                ? string.Empty
                : opening.Substring(separator).Trim();
            string kind = KindForTag(tagName, lineNumber, language);
            Dictionary<string, string> attributes = ParseAttributes(
                attributesText,
                lineNumber,
                language);

            ValidateBooleanAttribute(
                attributes,
                "numbersonly",
                lineNumber,
                language);
            ValidateBooleanAttribute(
                attributes,
                "integersonly",
                lineNumber,
                language);
            ValidateBooleanAttribute(
                attributes,
                "no_textbox",
                lineNumber,
                language);

            bool numbersOnly = ReadBooleanAttribute(
                attributes,
                "numbersonly");
            bool integersOnly = ReadBooleanAttribute(
                attributes,
                "integersonly");
            double? minimum = ParseNullableDouble(
                attributes,
                "min",
                lineNumber,
                language);
            double? maximum = ParseNullableDouble(
                attributes,
                "max",
                lineNumber,
                language);
            double? step = ParseNullableDouble(
                attributes,
                "step",
                lineNumber,
                language);
            if (minimum.HasValue
                && maximum.HasValue
                && minimum.Value > maximum.Value)
            {
                throw LineError(
                    lineNumber,
                    language + " widget minimum exceeds its maximum.");
            }
            if (step.HasValue && step.Value <= 0.0)
            {
                throw LineError(
                    lineNumber,
                    language + " widget step must be positive.");
            }

            string defaultValue;
            attributes.TryGetValue("default", out defaultValue);
            bool isInputSet = string.Equals(
                    tagName,
                    "input_set",
                    StringComparison.OrdinalIgnoreCase);
            // Match the trainer UI's literal, case-sensitive visibility test.
            // Parsing an input_set tag is not enough to prove that its input is
            // hidden: for example, "<input_set >" still displays a textbox.
            bool actionWithoutInput = isInputSet
                && (body.IndexOf(
                        "<input_set>",
                        StringComparison.Ordinal) >= 0
                    || body.IndexOf(
                        "no_textbox",
                        StringComparison.Ordinal) >= 0);
            string valueType = actionWithoutInput
                ? "none"
                : DetermineWidgetValueType(
                    tagName,
                    defaultValue,
                    minimum,
                    maximum,
                    step,
                    numbersOnly,
                    integersOnly);
            if (string.Equals(valueType, "integer", StringComparison.Ordinal))
            {
                ValidateIntegerDefault(defaultValue, lineNumber, language);
            }
            else if (string.Equals(
                    valueType,
                    "number",
                    StringComparison.Ordinal))
            {
                ValidateNumericDefault(
                    defaultValue,
                    lineNumber,
                    language);
            }

            return new ParsedWidget(
                kind,
                label,
                defaultValue,
                minimum,
                maximum,
                step,
                valueType,
                actionWithoutInput
                    ? "none"
                    : ValueApplyModeForKind(kind),
                actionWithoutInput,
                true);
        }

        private static bool ReadBooleanAttribute(
            IDictionary<string, string> attributes,
            string name)
        {
            string raw;
            bool parsed;
            return attributes.TryGetValue(name, out raw)
                && bool.TryParse(raw, out parsed)
                && parsed;
        }

        private static string DetermineWidgetValueType(
            string tagName,
            string defaultValue,
            double? minimum,
            double? maximum,
            double? step,
            bool numbersOnly,
            bool integersOnly)
        {
            if (integersOnly)
            {
                return "integer";
            }
            if (numbersOnly
                || string.Equals(
                    tagName,
                    "slider",
                    StringComparison.OrdinalIgnoreCase)
                || string.Equals(
                    tagName,
                    "input_adjust",
                    StringComparison.OrdinalIgnoreCase)
                || minimum.HasValue
                || maximum.HasValue
                || step.HasValue)
            {
                return "number";
            }

            double numericDefault;
            return defaultValue != null
                && TryParseFiniteDouble(defaultValue, out numericDefault)
                    ? "number"
                    : "text";
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

        private static int FindWhitespace(string value)
        {
            for (int index = 0; index < value.Length; index++)
            {
                if (char.IsWhiteSpace(value[index]))
                {
                    return index;
                }
            }
            return -1;
        }

        private static string KindForTag(
            string tagName,
            int lineNumber,
            string language)
        {
            if (string.Equals(
                    tagName,
                    "input",
                    StringComparison.OrdinalIgnoreCase))
            {
                return "toggle_with_input";
            }
            if (string.Equals(
                    tagName,
                    "input_set",
                    StringComparison.OrdinalIgnoreCase))
            {
                return "action";
            }
            if (string.Equals(
                    tagName,
                    "slider",
                    StringComparison.OrdinalIgnoreCase)
                || string.Equals(
                    tagName,
                    "input_adjust",
                    StringComparison.OrdinalIgnoreCase))
            {
                return "toggle_with_input_adjustment";
            }

            throw LineError(
                lineNumber,
                language + " menu contains unknown widget <"
                    + tagName + ">.");
        }

        private static Dictionary<string, string> ParseAttributes(
            string text,
            int lineNumber,
            string language)
        {
            Dictionary<string, string> attributes =
                new Dictionary<string, string>(
                    StringComparer.OrdinalIgnoreCase);
            int index = 0;
            while (index < text.Length)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length)
                {
                    break;
                }

                int nameStart = index;
                while (index < text.Length
                    && IsAttributeNameCharacter(text[index]))
                {
                    index++;
                }
                if (nameStart == index)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " widget contains malformed attributes.");
                }

                string name = text.Substring(
                    nameStart,
                    index - nameStart).ToLowerInvariant();
                if (!IsKnownAttribute(name))
                {
                    throw LineError(
                        lineNumber,
                        language + " widget contains unknown attribute '"
                            + name + "'.");
                }
                if (attributes.ContainsKey(name))
                {
                    throw LineError(
                        lineNumber,
                        language + " widget repeats attribute '"
                            + name + "'.");
                }

                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '=')
                {
                    if (!string.Equals(
                            name,
                            "no_textbox",
                            StringComparison.Ordinal))
                    {
                        throw LineError(
                            lineNumber,
                            language + " widget attribute '" + name
                                + "' has no value.");
                    }
                    attributes[name] = "true";
                    continue;
                }

                index++;
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"')
                {
                    throw LineError(
                        lineNumber,
                        language + " widget attribute '" + name
                            + "' must use double quotes.");
                }

                index++;
                int valueStart = index;
                int quote = text.IndexOf('"', valueStart);
                if (quote < 0)
                {
                    throw LineError(
                        lineNumber,
                        language + " widget attribute '" + name
                            + "' has an unterminated value.");
                }

                attributes[name] = text.Substring(
                    valueStart,
                    quote - valueStart);
                index = quote + 1;
                if (index < text.Length
                    && !char.IsWhiteSpace(text[index]))
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " widget attributes are not separated.");
                }
            }
            return attributes;
        }

        private static void SkipWhitespace(string value, ref int index)
        {
            while (index < value.Length
                && char.IsWhiteSpace(value[index]))
            {
                index++;
            }
        }

        private static bool IsAttributeNameCharacter(char value)
        {
            return value == '_'
                || value == '-'
                || IsAsciiLetter(value)
                || char.IsDigit(value);
        }

        private static bool IsKnownAttribute(string name)
        {
            return string.Equals(name, "default", StringComparison.Ordinal)
                || string.Equals(name, "min", StringComparison.Ordinal)
                || string.Equals(name, "max", StringComparison.Ordinal)
                || string.Equals(name, "step", StringComparison.Ordinal)
                || string.Equals(
                    name,
                    "numbersonly",
                    StringComparison.Ordinal)
                || string.Equals(
                    name,
                    "integersonly",
                    StringComparison.Ordinal)
                || string.Equals(
                    name,
                    "no_textbox",
                    StringComparison.Ordinal);
        }

        private static void ValidateBooleanAttribute(
            IDictionary<string, string> attributes,
            string name,
            int lineNumber,
            string language)
        {
            string value;
            bool parsed;
            if (attributes.TryGetValue(name, out value)
                && !bool.TryParse(value, out parsed))
            {
                throw LineError(
                    lineNumber,
                    language + " widget attribute '" + name
                        + "' is not a Boolean.");
            }
        }

        private static double? ParseNullableDouble(
            IDictionary<string, string> attributes,
            string name,
            int lineNumber,
            string language)
        {
            string raw;
            if (!attributes.TryGetValue(name, out raw))
            {
                return null;
            }

            double value;
            if (!TryParseFiniteDouble(raw, out value))
            {
                throw LineError(
                    lineNumber,
                    language + " widget attribute '" + name
                        + "' is not a finite number.");
            }
            return value;
        }

        private static void ValidateNumericDefault(
            string value,
            int lineNumber,
            string language)
        {
            if (value == null)
            {
                return;
            }

            double parsed;
            if (!TryParseFiniteDouble(value, out parsed))
            {
                throw LineError(
                    lineNumber,
                    language
                        + " numeric widget default is not a finite number.");
            }
        }

        private static void ValidateIntegerDefault(
            string value,
            int lineNumber,
            string language)
        {
            if (value == null)
            {
                return;
            }

            long parsed;
            if (!long.TryParse(
                    value,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out parsed))
            {
                throw LineError(
                    lineNumber,
                    language
                        + " integer widget default is not an integer.");
            }
        }

        private static bool TryParseFiniteDouble(
            string value,
            out double parsed)
        {
            return double.TryParse(
                    value,
                    NumberStyles.Float | NumberStyles.AllowThousands,
                    CultureInfo.InvariantCulture,
                    out parsed)
                && !double.IsNaN(parsed)
                && !double.IsInfinity(parsed);
        }

        private static LocalizedText ParseLocalizedText(
            string value,
            int lineNumber,
            string language)
        {
            int marker = value.LastIndexOf(
                "**",
                StringComparison.Ordinal);
            string label = value;
            string tooltip = null;
            bool important = false;
            if (marker >= 0)
            {
                if (marker == 0)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " tooltip marker has no preceding label.");
                }

                label = value.Substring(0, marker).Trim();
                tooltip = value.Substring(marker + 2).Trim();
                if (tooltip.Length == 0)
                {
                    throw LineError(
                        lineNumber,
                        language + " tooltip marker has no text.");
                }

                important = ImportantMarker.IsMatch(tooltip);
                tooltip = ImportantMarker.Replace(
                    tooltip,
                    string.Empty).Trim();
                if (tooltip.Length == 0)
                {
                    throw LineError(
                        lineNumber,
                        language
                            + " tooltip only contains an importance marker.");
                }
            }

            if (label.Length == 0)
            {
                throw LineError(
                    lineNumber,
                    language + " option label is empty.");
            }

            return new LocalizedText(
                label,
                tooltip,
                important);
        }

        private static void ValidateLocalizedOptions(
            ParsedOption chinese,
            ParsedOption english,
            int lineNumber)
        {
            // Some FLiNG English payloads intentionally omit the widget DSL
            // while the paired Chinese line still carries the authoritative
            // <input> metadata. In that case the English parser produces a
            // plain toggle placeholder, so none of its widget fields are
            // comparable.
            if (!english.widget.hasWidget)
            {
                return;
            }

            if (!string.Equals(
                    chinese.widget.kind,
                    english.widget.kind,
                    StringComparison.Ordinal))
            {
                throw LineError(
                    lineNumber,
                    "Chinese and English widget kinds differ.");
            }
            if (chinese.widget.actionWithoutInput
                != english.widget.actionWithoutInput)
            {
                throw LineError(
                    lineNumber,
                    "Chinese and English action input visibility differs.");
            }

            ValidateEquivalent(
                chinese.widget.defaultValue,
                english.widget.defaultValue,
                "default",
                lineNumber);
            ValidateEquivalent(
                chinese.widget.minimum,
                english.widget.minimum,
                "minimum",
                lineNumber);
            ValidateEquivalent(
                chinese.widget.maximum,
                english.widget.maximum,
                "maximum",
                lineNumber);
            ValidateEquivalent(
                chinese.widget.step,
                english.widget.step,
                "step",
                lineNumber);
            ValidateEquivalent(
                chinese.widget.valueType,
                english.widget.valueType,
                "value type",
                lineNumber);
            ValidateEquivalent(
                chinese.widget.valueApplyMode,
                english.widget.valueApplyMode,
                "value apply mode",
                lineNumber);
        }

        private static void ValidateEquivalent(
            string chinese,
            string english,
            string field,
            int lineNumber)
        {
            if (chinese != null
                && english != null
                && !string.Equals(
                    chinese,
                    english,
                    StringComparison.Ordinal))
            {
                throw LineError(
                    lineNumber,
                    "Chinese and English widget " + field
                        + " values differ.");
            }
        }

        private static void ValidateEquivalent(
            double? chinese,
            double? english,
            string field,
            int lineNumber)
        {
            if (chinese.HasValue
                && english.HasValue
                && chinese.Value != english.Value)
            {
                throw LineError(
                    lineNumber,
                    "Chinese and English widget " + field
                        + " values differ.");
            }
        }

        private static string MergeExplicitIds(
            string chinese,
            string english,
            int lineNumber)
        {
            if (!string.IsNullOrEmpty(chinese)
                && !string.IsNullOrEmpty(english)
                && !string.Equals(
                    chinese,
                    english,
                    StringComparison.Ordinal))
            {
                throw LineError(
                    lineNumber,
                    "Chinese and English explicit option IDs differ.");
            }
            return FirstNonNull(chinese, english);
        }

        private static Dictionary<string, string>
            CreateLocalizedDictionary(
                string chinese,
                string english)
        {
            Dictionary<string, string> values =
                new Dictionary<string, string>();
            values[ChineseKey] = chinese;
            values[EnglishKey] = english;
            return values;
        }

        private static void AddLocalizedTooltip(
            IDictionary<string, string> tooltips,
            string language,
            string value)
        {
            if (!FrameworkCompat.IsNullOrWhiteSpace(value))
            {
                tooltips[language] = value;
            }
        }

        private static T FirstNonNull<T>(T first, T second)
            where T : class
        {
            return first ?? second;
        }

        private static double? FirstNonNull(
            double? first,
            double? second)
        {
            return first.HasValue ? first : second;
        }

        private static void ThrowAlignment(
            int lineNumber,
            LineKind chinese,
            LineKind english)
        {
            throw LineError(
                lineNumber,
                "Chinese/English menu structures differ ("
                    + chinese + " versus " + english + ").");
        }

        private static FormatException LineError(
            int lineNumber,
            string message)
        {
            return new FormatException(
                string.Format(
                    CultureInfo.InvariantCulture,
                    "Menu line {0}: {1}",
                    lineNumber,
                    message));
        }

        private enum LineKind
        {
            Blank,
            Split,
            Label,
            Option
        }

        private sealed class LocalizedText
        {
            public LocalizedText(
                string label,
                string tooltip,
                bool important)
            {
                this.label = label;
                this.tooltip = tooltip;
                this.important = important;
            }

            public string label { get; private set; }

            public string tooltip { get; private set; }

            public bool important { get; private set; }
        }

        private sealed class ParsedOption
        {
            public ParsedOption(
                string id,
                ParsedWidget widget,
                LocalizedText text)
            {
                this.id = id;
                this.widget = widget;
                this.text = text;
            }

            public string id { get; private set; }

            public ParsedWidget widget { get; private set; }

            public LocalizedText text { get; private set; }
        }

        private sealed class ParsedWidget
        {
            public ParsedWidget(
                string kind,
                string label,
                string defaultValue,
                double? minimum,
                double? maximum,
                double? step,
                string valueType,
                string valueApplyMode,
                bool actionWithoutInput,
                bool hasWidget)
            {
                this.kind = kind;
                this.label = label;
                this.defaultValue = defaultValue;
                this.minimum = minimum;
                this.maximum = maximum;
                this.step = step;
                this.valueType = valueType;
                this.valueApplyMode = valueApplyMode;
                this.actionWithoutInput = actionWithoutInput;
                this.hasWidget = hasWidget;
            }

            public string kind { get; private set; }

            public string label { get; private set; }

            public string defaultValue { get; private set; }

            public double? minimum { get; private set; }

            public double? maximum { get; private set; }

            public double? step { get; private set; }

            public string valueType { get; private set; }

            public string valueApplyMode { get; private set; }

            public bool actionWithoutInput { get; private set; }

            public bool hasWidget { get; private set; }

            public static ParsedWidget Toggle(string label)
            {
                return new ParsedWidget(
                    "toggle",
                    label,
                    null,
                    null,
                    null,
                    null,
                    "none",
                    "none",
                    false,
                    false);
            }
        }
    }
}
