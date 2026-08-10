using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;

namespace TrainerDeckBridge
{
    internal static class JsonCodec
    {
        private const int MaximumDepth = 64;

        public static object DeserializeObject(string json)
        {
            if (json == null)
            {
                throw new ArgumentNullException("json");
            }

            return new Parser(json).Parse();
        }

        public static T Deserialize<T>(string json)
        {
            object decoded = DeserializeObject(json);
            object converted = ConvertValue(decoded, typeof(T), 0);
            return converted == null ? default(T) : (T)converted;
        }

        public static string Serialize(object value)
        {
            StringBuilder output = new StringBuilder();
            WriteValue(output, value, 0);
            return output.ToString();
        }

        private static object ConvertValue(
            object value,
            Type targetType,
            int depth)
        {
            if (depth > MaximumDepth)
            {
                throw new FormatException(
                    "JSON object graph exceeds the maximum depth.");
            }

            Type nullableType = Nullable.GetUnderlyingType(targetType);
            if (value == null)
            {
                if (!targetType.IsValueType || nullableType != null)
                {
                    return null;
                }

                throw new FormatException(
                    "JSON null cannot be assigned to "
                    + targetType.FullName
                    + ".");
            }

            Type effectiveType = nullableType ?? targetType;
            if (effectiveType.IsInstanceOfType(value))
            {
                return value;
            }

            if (effectiveType == typeof(string))
            {
                string text = value as string;
                if (text == null)
                {
                    throw new FormatException("JSON value must be a string.");
                }
                return text;
            }

            if (effectiveType == typeof(bool))
            {
                if (!(value is bool))
                {
                    throw new FormatException("JSON value must be a boolean.");
                }
                return value;
            }

            if (IsNumericType(effectiveType))
            {
                try
                {
                    return Convert.ChangeType(
                        value,
                        effectiveType,
                        CultureInfo.InvariantCulture);
                }
                catch (Exception error)
                {
                    throw new FormatException(
                        "JSON number is outside the range of "
                        + effectiveType.FullName
                        + ".",
                        error);
                }
            }

            IDictionary<string, object> values =
                value as IDictionary<string, object>;
            if (values == null)
            {
                throw new FormatException(
                    "JSON value cannot be converted to "
                    + effectiveType.FullName
                    + ".");
            }

            object instance;
            try
            {
                instance = Activator.CreateInstance(effectiveType, true);
            }
            catch (Exception error)
            {
                throw new FormatException(
                    "JSON target type cannot be constructed: "
                    + effectiveType.FullName
                    + ".",
                    error);
            }

            PropertyInfo[] properties = effectiveType.GetProperties(
                BindingFlags.Instance | BindingFlags.Public);
            for (int index = 0; index < properties.Length; index++)
            {
                PropertyInfo property = properties[index];
                if (!property.CanWrite
                    || property.GetIndexParameters().Length != 0)
                {
                    continue;
                }

                object propertyValue;
                if (!values.TryGetValue(property.Name, out propertyValue))
                {
                    continue;
                }

                object converted = ConvertValue(
                    propertyValue,
                    property.PropertyType,
                    depth + 1);
                property.SetValue(instance, converted, null);
            }

            return instance;
        }

        private static bool IsNumericType(Type type)
        {
            TypeCode code = Type.GetTypeCode(type);
            return code == TypeCode.Byte
                || code == TypeCode.SByte
                || code == TypeCode.Int16
                || code == TypeCode.UInt16
                || code == TypeCode.Int32
                || code == TypeCode.UInt32
                || code == TypeCode.Int64
                || code == TypeCode.UInt64
                || code == TypeCode.Single
                || code == TypeCode.Double
                || code == TypeCode.Decimal;
        }

        private static void WriteValue(
            StringBuilder output,
            object value,
            int depth)
        {
            if (depth > MaximumDepth)
            {
                throw new InvalidOperationException(
                    "JSON object graph exceeds the maximum depth.");
            }

            if (value == null)
            {
                output.Append("null");
                return;
            }

            string text = value as string;
            if (text != null)
            {
                WriteString(output, text);
                return;
            }

            if (value is bool)
            {
                output.Append((bool)value ? "true" : "false");
                return;
            }

            if (value is char)
            {
                WriteString(output, value.ToString());
                return;
            }

            Type valueType = value.GetType();
            if (IsNumericType(valueType))
            {
                WriteNumber(output, value, valueType);
                return;
            }

            IDictionary dictionary = value as IDictionary;
            if (dictionary != null)
            {
                WriteDictionary(output, dictionary, depth + 1);
                return;
            }

            IEnumerable sequence = value as IEnumerable;
            if (sequence != null)
            {
                WriteSequence(output, sequence, depth + 1);
                return;
            }

            WriteProperties(output, value, depth + 1);
        }

        private static void WriteNumber(
            StringBuilder output,
            object value,
            Type valueType)
        {
            if (valueType == typeof(double))
            {
                double number = (double)value;
                if (double.IsNaN(number) || double.IsInfinity(number))
                {
                    throw new InvalidOperationException(
                        "JSON cannot represent a non-finite double.");
                }
                output.Append(number.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            if (valueType == typeof(float))
            {
                float number = (float)value;
                if (float.IsNaN(number) || float.IsInfinity(number))
                {
                    throw new InvalidOperationException(
                        "JSON cannot represent a non-finite float.");
                }
                output.Append(number.ToString("R", CultureInfo.InvariantCulture));
                return;
            }

            output.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteDictionary(
            StringBuilder output,
            IDictionary values,
            int depth)
        {
            output.Append('{');
            bool first = true;
            foreach (DictionaryEntry entry in values)
            {
                string key = entry.Key as string;
                if (key == null)
                {
                    throw new InvalidOperationException(
                        "JSON object keys must be strings.");
                }

                if (!first)
                {
                    output.Append(',');
                }
                first = false;
                WriteString(output, key);
                output.Append(':');
                WriteValue(output, entry.Value, depth);
            }
            output.Append('}');
        }

        private static void WriteSequence(
            StringBuilder output,
            IEnumerable values,
            int depth)
        {
            output.Append('[');
            bool first = true;
            foreach (object value in values)
            {
                if (!first)
                {
                    output.Append(',');
                }
                first = false;
                WriteValue(output, value, depth);
            }
            output.Append(']');
        }

        private static void WriteProperties(
            StringBuilder output,
            object value,
            int depth)
        {
            output.Append('{');
            bool first = true;
            PropertyInfo[] properties = value.GetType().GetProperties(
                BindingFlags.Instance | BindingFlags.Public);
            for (int index = 0; index < properties.Length; index++)
            {
                PropertyInfo property = properties[index];
                if (!property.CanRead
                    || property.GetIndexParameters().Length != 0)
                {
                    continue;
                }

                object propertyValue = property.GetValue(value, null);
                if (!first)
                {
                    output.Append(',');
                }
                first = false;
                WriteString(output, property.Name);
                output.Append(':');
                WriteValue(output, propertyValue, depth);
            }
            output.Append('}');
        }

        private static void WriteString(StringBuilder output, string value)
        {
            output.Append('"');
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                switch (character)
                {
                    case '"':
                        output.Append("\\\"");
                        break;
                    case '\\':
                        output.Append("\\\\");
                        break;
                    case '\b':
                        output.Append("\\b");
                        break;
                    case '\f':
                        output.Append("\\f");
                        break;
                    case '\n':
                        output.Append("\\n");
                        break;
                    case '\r':
                        output.Append("\\r");
                        break;
                    case '\t':
                        output.Append("\\t");
                        break;
                    default:
                        if (character < 0x20)
                        {
                            output.Append("\\u");
                            output.Append(
                                ((int)character).ToString(
                                    "x4",
                                    CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            output.Append(character);
                        }
                        break;
                }
            }
            output.Append('"');
        }

        private sealed class Parser
        {
            private readonly string json;
            private int position;

            public Parser(string json)
            {
                this.json = json;
            }

            public object Parse()
            {
                SkipWhitespace();
                object value = ParseValue(0);
                SkipWhitespace();
                if (position != json.Length)
                {
                    throw Error("Unexpected trailing JSON content.");
                }
                return value;
            }

            private object ParseValue(int depth)
            {
                if (depth > MaximumDepth)
                {
                    throw Error("JSON exceeds the maximum depth.");
                }
                if (position >= json.Length)
                {
                    throw Error("Unexpected end of JSON.");
                }

                char character = json[position];
                if (character == '{')
                {
                    return ParseObject(depth + 1);
                }
                if (character == '[')
                {
                    return ParseArray(depth + 1);
                }
                if (character == '"')
                {
                    return ParseString();
                }
                if (character == 't')
                {
                    ReadLiteral("true");
                    return true;
                }
                if (character == 'f')
                {
                    ReadLiteral("false");
                    return false;
                }
                if (character == 'n')
                {
                    ReadLiteral("null");
                    return null;
                }
                if (character == '-' || (character >= '0' && character <= '9'))
                {
                    return ParseNumber();
                }

                throw Error("Unexpected JSON token.");
            }

            private Dictionary<string, object> ParseObject(int depth)
            {
                Dictionary<string, object> result =
                    new Dictionary<string, object>(StringComparer.Ordinal);
                position++;
                SkipWhitespace();
                if (Consume('}'))
                {
                    return result;
                }

                while (true)
                {
                    if (position >= json.Length || json[position] != '"')
                    {
                        throw Error("JSON object key must be a string.");
                    }
                    string key = ParseString();
                    SkipWhitespace();
                    Require(':');
                    SkipWhitespace();
                    object value = ParseValue(depth);
                    if (result.ContainsKey(key))
                    {
                        throw Error("JSON object contains a duplicate key.");
                    }
                    result.Add(key, value);
                    SkipWhitespace();
                    if (Consume('}'))
                    {
                        return result;
                    }
                    Require(',');
                    SkipWhitespace();
                }
            }

            private List<object> ParseArray(int depth)
            {
                List<object> result = new List<object>();
                position++;
                SkipWhitespace();
                if (Consume(']'))
                {
                    return result;
                }

                while (true)
                {
                    result.Add(ParseValue(depth));
                    SkipWhitespace();
                    if (Consume(']'))
                    {
                        return result;
                    }
                    Require(',');
                    SkipWhitespace();
                }
            }

            private string ParseString()
            {
                Require('"');
                StringBuilder result = new StringBuilder();
                while (position < json.Length)
                {
                    char character = json[position++];
                    if (character == '"')
                    {
                        return result.ToString();
                    }
                    if (character < 0x20)
                    {
                        throw Error("JSON string contains a control character.");
                    }
                    if (character != '\\')
                    {
                        result.Append(character);
                        continue;
                    }
                    if (position >= json.Length)
                    {
                        throw Error("JSON string ends after an escape prefix.");
                    }

                    char escaped = json[position++];
                    switch (escaped)
                    {
                        case '"':
                        case '\\':
                        case '/':
                            result.Append(escaped);
                            break;
                        case 'b':
                            result.Append('\b');
                            break;
                        case 'f':
                            result.Append('\f');
                            break;
                        case 'n':
                            result.Append('\n');
                            break;
                        case 'r':
                            result.Append('\r');
                            break;
                        case 't':
                            result.Append('\t');
                            break;
                        case 'u':
                            result.Append(ParseUnicodeEscape());
                            break;
                        default:
                            throw Error("JSON string contains an invalid escape.");
                    }
                }

                throw Error("JSON string is not terminated.");
            }

            private char ParseUnicodeEscape()
            {
                if (position > json.Length - 4)
                {
                    throw Error("JSON unicode escape is incomplete.");
                }

                int value = 0;
                for (int index = 0; index < 4; index++)
                {
                    char digit = json[position++];
                    value <<= 4;
                    if (digit >= '0' && digit <= '9')
                    {
                        value += digit - '0';
                    }
                    else if (digit >= 'a' && digit <= 'f')
                    {
                        value += digit - 'a' + 10;
                    }
                    else if (digit >= 'A' && digit <= 'F')
                    {
                        value += digit - 'A' + 10;
                    }
                    else
                    {
                        throw Error("JSON unicode escape contains a non-hex digit.");
                    }
                }
                return (char)value;
            }

            private object ParseNumber()
            {
                int start = position;
                if (Consume('-') && position >= json.Length)
                {
                    throw Error("JSON number ends after its sign.");
                }

                if (Consume('0'))
                {
                    if (position < json.Length
                        && json[position] >= '0'
                        && json[position] <= '9')
                    {
                        throw Error("JSON number has a leading zero.");
                    }
                }
                else
                {
                    ReadDigits("JSON number requires an integer part.");
                }

                bool floatingPoint = false;
                if (Consume('.'))
                {
                    floatingPoint = true;
                    ReadDigits("JSON fraction requires at least one digit.");
                }
                if (position < json.Length
                    && (json[position] == 'e' || json[position] == 'E'))
                {
                    floatingPoint = true;
                    position++;
                    if (position < json.Length
                        && (json[position] == '+' || json[position] == '-'))
                    {
                        position++;
                    }
                    ReadDigits("JSON exponent requires at least one digit.");
                }

                string token = json.Substring(start, position - start);
                long integer;
                if (!floatingPoint
                    && long.TryParse(
                        token,
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out integer))
                {
                    return integer;
                }

                double number;
                if (!double.TryParse(
                        token,
                        NumberStyles.Float,
                        CultureInfo.InvariantCulture,
                        out number)
                    || double.IsNaN(number)
                    || double.IsInfinity(number))
                {
                    throw Error("JSON number is invalid or out of range.");
                }
                return number;
            }

            private void ReadDigits(string errorMessage)
            {
                int start = position;
                while (position < json.Length
                    && json[position] >= '0'
                    && json[position] <= '9')
                {
                    position++;
                }
                if (position == start)
                {
                    throw Error(errorMessage);
                }
            }

            private void ReadLiteral(string literal)
            {
                if (position > json.Length - literal.Length
                    || string.CompareOrdinal(
                        json,
                        position,
                        literal,
                        0,
                        literal.Length) != 0)
                {
                    throw Error("JSON literal is invalid.");
                }
                position += literal.Length;
            }

            private bool Consume(char expected)
            {
                if (position < json.Length && json[position] == expected)
                {
                    position++;
                    return true;
                }
                return false;
            }

            private void Require(char expected)
            {
                if (!Consume(expected))
                {
                    throw Error("Expected '" + expected + "'.");
                }
            }

            private void SkipWhitespace()
            {
                while (position < json.Length)
                {
                    char character = json[position];
                    if (character != ' '
                        && character != '\t'
                        && character != '\r'
                        && character != '\n')
                    {
                        return;
                    }
                    position++;
                }
            }

            private FormatException Error(string message)
            {
                return new FormatException(
                    message + " Position=" + position + ".");
            }
        }
    }
}
