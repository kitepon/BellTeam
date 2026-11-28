using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class FeatureEditor : EditorWindow
{
    private readonly LinuxWorkspace workspace;
    private readonly string id;
    private readonly List<(FeatureField Field, TextBox? Text, TextBox? Password, CheckBox? Remove)> inputs = [];
    public FeatureEditor(LinuxWorkspace workspace, string id, string title) : base(title, workspace.ConnectionToken)
    {
        this.workspace = workspace; this.id = id;
        Deactivated += (_, _) => ClearSecrets(); Closed += (_, _) => ClearSecrets(); PageClosed += ClearSecrets;
    }
    public void ClearSecrets() { foreach (var input in inputs) if (input.Password is { } box) box.Text = ""; }
    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false; ShowStatus(LinuxStrings.FeatureEditor_InitializeAsync_1);
        try
        {
            var original = (await workspace.Planning.FeaturesAsync(Token)).Single(setting => setting.Id == id); Token.ThrowIfCancellationRequested();
            var enabled = SettingsUi.Violeted(new CheckBox { Content = LinuxStrings.FeatureEditor_InitializeAsync_2, IsChecked = original.Enabled, Margin = new Thickness(0, 10, 0, 14) }); Body.Children.Add(enabled);
            // A feature with no fields (thinkingDisplay) is the switch alone: nothing to register, so no guide and no empty 設定 heading.
            if (original.Fields.Length > 0) Body.Children.Add(new TextBlock { Text = LinuxStrings.FeatureEditor_InitializeAsync_3, TextWrapping = TextWrapping.Wrap });
            if (original.ApplyFailed) Body.Children.Add(new TextBlock { Text = LinuxStrings.FeatureEditor_InitializeAsync_4, TextWrapping = TextWrapping.Wrap, Foreground = BellTheme.Red });
            if (original.Fields.Length > 0) Heading(LinuxStrings.FeatureEditor_InitializeAsync_5);
            foreach (var field in original.Fields)
            {
                if (!field.Secret) { inputs.Add((field, TextField(field.Label, field.Value), null, null)); continue; }
                Body.Children.Add(new TextBlock { Text = field.Label, Margin = new Thickness(0, 10, 0, 5) });
                Body.Children.Add(new TextBlock { Text = field.Configured ? LinuxStrings.FeatureEditor_InitializeAsync_6 : LinuxStrings.FeatureEditor_InitializeAsync_7, FontSize = 14 });
                var password = new TextBox { PasswordChar = '•', Margin = new Thickness(0, 5), Padding = new Thickness(10, 8), FontSize = 16 }; Body.Children.Add(password);
                var remove = SettingsUi.Violeted(new CheckBox { Content = LinuxStrings.FeatureEditor_InitializeAsync_8, Margin = new Thickness(0, 4, 0, 8) });
                remove.IsCheckedChanged += (_, _) => { if (remove.IsChecked == true) password.Text = ""; password.IsEnabled = remove.IsChecked != true; };
                Body.Children.Add(remove); inputs.Add((field, null, password, remove));
            }
            SaveAction = async () =>
            {
                var values = CollectChanges(); ClearSecrets();
                bool? changedEnabled = (enabled.IsChecked == true) == original.Enabled ? null : enabled.IsChecked == true;
                if (values.Count == 0 && changedEnabled is null) return true;
                try
                {
                    var updated = await workspace.Planning.SaveFeatureAsync(id, changedEnabled, values, Token);
                    if (updated.ApplyFailed) { Saved = true; ShowStatus(LinuxStrings.FeatureEditor_InitializeAsync_9); return false; }
                    return true;
                }
                finally { values.Clear(); }
            };
            ShowStatus(""); SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { ShowStatus(LinuxStrings.FeatureEditor_InitializeAsync_10); }
    }
    public Dictionary<string, string> CollectChanges()
    {
        var values = new Dictionary<string, string>();
        foreach (var input in inputs)
        {
            if (input.Field.Secret)
            {
                if (input.Remove!.IsChecked == true) values[input.Field.Key] = "";
                else if ((input.Password!.Text ?? "").Length != 0) values[input.Field.Key] = input.Password.Text!;
            }
            else if ((input.Text!.Text ?? "") != input.Field.Value) values[input.Field.Key] = input.Text.Text ?? "";
        }
        return values;
    }
}
