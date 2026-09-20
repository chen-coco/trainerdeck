using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Resources;
using System.Windows;
using System.Windows.Controls;

// Real WPF controls exercise visibility and selection semantics even without a
// downloaded trainer. An optional UI assembly runs the same checks on FLiNG.
internal sealed class TestCombo
{
    public ComboBox m_box = new ComboBox { IsEditable = true };
}
internal sealed class CheatOptionSetComboBox : UserControl
{
    public string ID = "";
    public TestCombo m_combobox = new TestCombo();
    public string GetInputValue() { return m_combobox.m_box.Text; }
    public void SetInputValue(string value) { m_combobox.m_box.Text = value; }
}
internal sealed class CheatOptionSetValue : UserControl
{
    public string ID = "";
    public TextBox m_textbox = new TextBox();
    public string GetInputValue() { return m_textbox.Text; }
    public void SetInputValue(string value) { m_textbox.Text = value; }
}
internal sealed class SelectionWindow : Window
{
    public WrapPanel m_cheat_options_area = new WrapPanel();
    public bool IsGameRunning = true;
    public Action<string, string> ExecuteTrainerCommand;
}

internal static class BridgeSelectionHarness
{
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private const string Chinese = "Alt+数字键 / - <combobox default=\"1\" group=\"1\" group_owner>保存位置 --save_location\n"
        + "Alt+数字键 * - <combobox default=\"1\" group=\"1\">瞬间转移 --teleport\n"
        + "Alt+数字键 - - <input_set>瞬移到标记位置 --teleport_to_waypoint";
    private const string English = "Alt+Num / - Save Location\nAlt+Num * - Teleport\nAlt+Num - - Teleport to Marker Location";
    private static int checks;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Assembly bridge = Assembly.LoadFrom(Path.GetFullPath(args[0]));
            Type readerType = bridge.GetType("TrainerDeckBridge.ReflectionMenuReader", true);
            Type parser = bridge.GetType("TrainerDeckBridge.MenuProtocolParser", true);
            object definition = parser.GetMethod("Parse", Any).Invoke(null, new object[] { Chinese, English });
            IList definitions = (IList)Get(definition, "options");
            Check((string)Get(definitions[0], "kind") == "select", "combo DSL is a selection");
            Check((string)Get(definitions[0], "value_type") == "text", "numeric-looking names stay text");
            Check((bool)Get(definitions[2], "action_without_input"), "bare input_set is a pure action");

            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            Assembly ui = args.Length > 1 ? Assembly.LoadFrom(Path.GetFullPath(args[1])) : null;
            if (ui != null) LoadThemes(app, ui);
            SelectionWindow window = new SelectionWindow();
            object save = Create(ui, true, "save_location");
            object teleport = Create(ui, true, "teleport");
            object marker = Create(ui, false, "teleport_to_waypoint");
            ComboBox saveBox = (ComboBox)Get(Get(save, "m_combobox"), "m_box");
            ComboBox teleportBox = (ComboBox)Get(Get(teleport, "m_combobox"), "m_box");
            Check(saveBox.IsEditable && !saveBox.IsReadOnly, "original save dropdown accepts typed input");
            Check(teleportBox.IsEditable && !teleportBox.IsReadOnly, "original teleport dropdown accepts typed input");
            foreach (ComboBox box in new[] { saveBox, teleportBox })
            {
                box.Items.Add("1");
                box.Items.Add("2");
                box.Items.Add("01");
            }
            Call(save, "SetInputValue", "1");
            Call(teleport, "SetInputValue", "1");
            ((UIElement)Get(marker, "m_textbox")).Visibility = Visibility.Collapsed;
            foreach (object control in new[] { save, teleport, marker })
                window.m_cheat_options_area.Children.Add((UIElement)control);

            int calls = 0;
            string invokedId = null;
            string invokedValue = null;
            window.ExecuteTrainerCommand = delegate(string id, string arguments)
            {
                Check(arguments == "", "normal option preserves empty args ABI");
                calls++;
                invokedId = id;
                object control = id == "save_location" ? save : id == "teleport" ? teleport : marker;
                invokedValue = (string)Call(control, "GetInputValue");
                // Simulate a native acknowledgement updating the original UI.
                if (id == "save_location")
                {
                    if (invokedValue.EndsWith("!!", StringComparison.Ordinal))
                    {
                        string deleted = invokedValue.Substring(0, invokedValue.Length - 2);
                        saveBox.Items.Remove(deleted);
                        teleportBox.Items.Remove(deleted);
                        Call(save, "SetInputValue", "");
                    }
                    else
                    {
                        if (!saveBox.Items.Contains(invokedValue)) saveBox.Items.Add(invokedValue);
                        if (!teleportBox.Items.Contains(invokedValue)) teleportBox.Items.Add(invokedValue);
                    }
                }
            };
            object reader = Activator.CreateInstance(readerType, Any, null, new object[] { window }, null);
            string chinese = args.Length > 2 ? File.ReadAllText(args[2]) : Chinese;
            string english = args.Length > 3 ? File.ReadAllText(args[3]) : English;
            Call(reader, "ReportMenuPayload", chinese, english);
            CheckMenu(reader);

            object result = Call(reader, "ExecuteValueOnUiThread", "save_location", "山谷营地", "1");
            Check((string)Get(result, "status") == "applied" && calls == 1, "save invokes once");
            Check(invokedId == "save_location" && invokedValue == "山谷营地", "native reads the new name");
            object snapshot = Call(reader, "Capture");
            Check(((IList)Get(Option(snapshot, "teleport"), "choices")).Contains("山谷营地"), "new native list is republished");

            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "山谷营地", "1");
            Check((string)Get(result, "status") == "applied" && calls == 2 && invokedValue == "山谷营地", "select and teleport");
            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "山谷营地", "山谷营地");
            Check((string)Get(result, "status") == "applied" && calls == 3, "unchanged selection still invokes");
            // Exercise a genuinely selection-only control separately, without
            // overriding the original trainer's editable defaults above.
            teleportBox.IsEditable = false;
            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "不存在的位置", "山谷营地");
            Check((string)Get(result, "error") == "choice-unavailable" && calls == 3, "reject unlisted read-only selection");
            teleportBox.IsEditable = true;
            Call(teleport, "SetInputValue", "2");
            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "1", "山谷营地");
            Check((string)Get(result, "error") == "expected-value-changed" && calls == 3, "reject stale selection");

            result = Call(reader, "ExecuteActionOnUiThread", "teleport_to_waypoint");
            Check((string)Get(result, "status") == "applied" && calls == 4 && invokedId == "teleport_to_waypoint", "marker action needs no input");
            result = Call(reader, "ExecuteValueOnUiThread", "save_location", "山谷营地!!", "山谷营地");
            Check((string)Get(result, "status") == "applied" && calls == 5, "native selection reset after deletion is accepted");
            Check((string)Call(save, "GetInputValue") == "" && !saveBox.Items.Contains("山谷营地"), "deletion is not rolled back");
            snapshot = Call(reader, "Capture");
            Check(!((IList)Get(Option(snapshot, "teleport"), "choices")).Contains("山谷营地"), "removed choices are republished");

            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "12", "2");
            Check((string)Get(result, "status") == "applied" && calls == 6 && invokedValue == "12", "editable teleport accepts a typed number outside the list");
            result = Call(reader, "ExecuteValueOnUiThread", "teleport", "0012", "12");
            Check((string)Get(result, "status") == "applied" && calls == 7 && invokedValue == "0012", "typed numeric names preserve leading zeros");

            window.m_cheat_options_area.Children.Clear();
            foreach (object control in new[] { marker, save, teleport }) window.m_cheat_options_area.Children.Add((UIElement)control);
            CheckMenu(reader); // IDs, not enumeration order, must bind definitions.

            object future = Create(ui, false, "future");
            window.m_cheat_options_area.Children.Add((UIElement)future);
            Call(reader, "ReportMenuPayload", Chinese + "\nF1 - <future_widget strange_flag>未来控件 --future", English + "\nF1 - Future control");
            snapshot = Call(reader, "Capture");
            Check((string)Get(Option(snapshot, "future"), "kind") == "unknown", "unknown widget is isolated");
            Check(!(bool)Get(Option(snapshot, "future"), "value_controllable"), "unknown widget never gains a value command");
            CheckMenu(reader);

            Call(reader, "ReportMenuPayload", "broken menu", "");
            CheckMenu(reader); // Real visibility and combo reflection survive parse failure.
            window.IsGameRunning = false;
            result = Call(reader, "ExecuteActionOnUiThread", "teleport_to_waypoint");
            Check((string)Get(result, "error") == "game-not-running" && calls == 7, "missing game still rejects actions");
            app.Shutdown();
            Console.WriteLine("PASS " + checks + " selection/visibility/command checks; " + (ui == null ? "WPF fixture" : ui.FullName));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void CheckMenu(object reader)
    {
        object snapshot = Call(reader, "Capture");
        foreach (string id in new[] { "save_location", "teleport" })
        {
            object option = Option(snapshot, id);
            Check((string)Get(option, "kind") == "select", id + " remains a select");
            Check((bool)Get(option, "value_controllable") && !(bool)Get(option, "action_controllable"), id + " supports a choice action");
            Check((string)Get(option, "value_type") == "text", id + " keeps text names");
            Check((bool)Get(option, "choice_editable"), id + " retains original editable behavior");
        }
        object marker = Option(snapshot, "teleport_to_waypoint");
        Check((bool)Get(marker, "action_controllable") && !(bool)Get(marker, "value_controllable"), "marker remains a pure action");
    }

    private static object Create(Assembly ui, bool combo, string id)
    {
        string name = combo ? "CheatOptionSetComboBox" : "CheatOptionSetValue";
        Type type = ui == null ? typeof(BridgeSelectionHarness).Assembly.GetType(name, true)
            : ui.GetType("FLiNGTrainerGUI_WPF.Controls." + name, true);
        object control = Activator.CreateInstance(type);
        for (Type current = type; current != null; current = current.BaseType)
        {
            FieldInfo field = current.GetField("ID", Any | BindingFlags.DeclaredOnly);
            if (field != null) { field.SetValue(control, id); break; }
        }
        return control;
    }

    private static object Option(object snapshot, string id)
    {
        foreach (object option in (IEnumerable)Get(snapshot, "options"))
            if ((string)Get(option, "id") == id) return option;
        throw new Exception("Missing option: " + id);
    }

    private static object Get(object target, string name)
    {
        for (Type type = target.GetType(); type != null; type = type.BaseType)
        {
            PropertyInfo property = type.GetProperty(name, Any | BindingFlags.DeclaredOnly);
            if (property != null) return property.GetValue(target, null);
            FieldInfo field = type.GetField(name, Any | BindingFlags.DeclaredOnly);
            if (field != null) return field.GetValue(target);
        }
        throw new Exception("Missing member: " + name);
    }
    private static object Call(object target, string name, params object[] arguments)
    {
        return target.GetType().GetMethod(name, Any).Invoke(target, arguments);
    }
    private static void Check(bool condition, string label)
    {
        if (!condition) throw new Exception("FAIL " + label);
        checks++;
    }
    private static void LoadThemes(Application app, Assembly ui)
    {
        foreach (string name in ui.GetManifestResourceNames())
        {
            if (!name.EndsWith(".g.resources")) continue;
            using (ResourceReader resources = new ResourceReader(ui.GetManifestResourceStream(name)))
            {
                foreach (DictionaryEntry entry in resources)
                {
                    string key = (string)entry.Key;
                    if (!key.StartsWith("themes/") || !key.EndsWith(".baml")) continue;
                    string uri = "/" + ui.GetName().Name + ";component/" + key.Replace(".baml", ".xaml");
                    app.Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri(uri, UriKind.Relative) });
                }
            }
        }
    }
}
