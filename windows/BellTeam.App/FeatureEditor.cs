using System.Windows;
using System.Windows.Controls;
using BellTeam.Core;

namespace BellTeam.App;

public sealed class FeatureEditor : EditorWindow
{
    private readonly Workspace workspace;
    private readonly string id;
    private readonly List<(FeatureField Field, TextBox? Text, PasswordBox? Password, CheckBox? Remove)> inputs = [];
    public FeatureEditor(Workspace workspace, string id, string title) : base(title, workspace.ConnectionToken)
    {
        this.workspace = workspace; this.id = id;
        Deactivated += (_, _) => ClearSecrets(); Closed += (_, _) => ClearSecrets();
    }
    public void ClearSecrets() { foreach (var input in inputs) input.Password?.Clear(); }
    public async Task InitializeAsync()
    {
        SaveButton.IsEnabled = false; Status.Text = AppStrings.FeatureEditor_InitializeAsync_1;
        try
        {
            var original = (await workspace.Planning.FeaturesAsync(Token)).Single(setting => setting.Id == id); Token.ThrowIfCancellationRequested();
            var (switchRow, enabled) = SettingsUi.SwitchRow(AppStrings.FeatureEditor_InitializeAsync_2); enabled.IsChecked = original.Enabled; switchRow.Margin = new Thickness(0, 10, 0, 14); Body.Children.Add(switchRow);
            // A feature with no fields (thinkingDisplay) is only this switch: nothing to register, no empty 設定 heading.
            if (original.Fields.Length != 0) Body.Children.Add(new TextBlock { Text = AppStrings.FeatureEditor_InitializeAsync_3, TextWrapping = TextWrapping.Wrap });
            if (original.ApplyFailed) Body.Children.Add(new TextBlock { Text = AppStrings.FeatureEditor_InitializeAsync_4, TextWrapping = TextWrapping.Wrap, Foreground = System.Windows.Media.Brushes.Firebrick });
            if (original.Fields.Length != 0) Heading(AppStrings.FeatureEditor_InitializeAsync_5);
            foreach (var field in original.Fields)
            {
                if (!field.Secret) { inputs.Add((field, TextField(field.Label, field.Value), null, null)); continue; }
                Body.Children.Add(new TextBlock { Text = field.Label, Margin = new Thickness(0, 10, 0, 5) });
                Body.Children.Add(new TextBlock { Text = field.Configured ? AppStrings.FeatureEditor_InitializeAsync_6 : AppStrings.FeatureEditor_InitializeAsync_7, FontSize = 14 });
                var password = new PasswordBox { Margin = new Thickness(0, 5, 0, 5), Padding = new Thickness(10, 8, 10, 8), FontSize = 16 }; Body.Children.Add(password);
                var remove = new CheckBox { Content = AppStrings.FeatureEditor_InitializeAsync_8, Margin = new Thickness(0, 4, 0, 8) };
                remove.Checked += (_, _) => { password.Clear(); password.IsEnabled = false; }; remove.Unchecked += (_, _) => password.IsEnabled = true;
                Body.Children.Add(remove); inputs.Add((field, null, password, remove));
            }
            SaveAction = async () =>
            {
                var values = CollectChanges(); ClearSecrets();
                bool? changedEnabled = enabled.IsChecked == original.Enabled ? null : enabled.IsChecked == true;
                if (values.Count == 0 && changedEnabled is null) return true;
                try
                {
                    var updated = await workspace.Planning.SaveFeatureAsync(id, changedEnabled, values, Token);
                    if (updated.ApplyFailed) { Saved = true; Status.Text = AppStrings.FeatureEditor_InitializeAsync_9; return false; }
                    return true;
                }
                finally { values.Clear(); }
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { Status.Text = AppStrings.FeatureEditor_InitializeAsync_10; }
    }
    public Dictionary<string, string> CollectChanges()
    {
        var values = new Dictionary<string, string>();
        foreach (var input in inputs)
        {
            if (input.Field.Secret)
            {
                if (input.Remove!.IsChecked == true) values[input.Field.Key] = "";
                else if (input.Password!.Password.Length != 0) values[input.Field.Key] = input.Password.Password;
            }
            else if (input.Text!.Text != input.Field.Value) values[input.Field.Key] = input.Text.Text;
        }
        return values;
    }
}
