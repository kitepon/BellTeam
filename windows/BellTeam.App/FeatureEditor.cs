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
        SaveButton.IsEnabled = false; Status.Text = "読み込んでいます…";
        try
        {
            var original = (await workspace.Planning.FeaturesAsync(Token)).Single(setting => setting.Id == id); Token.ThrowIfCancellationRequested();
            var enabled = new CheckBox { Content = "有効にする", IsChecked = original.Enabled, Margin = new Thickness(0, 10, 0, 14) }; Body.Children.Add(enabled);
            Body.Children.Add(new TextBlock { Text = "必要な項目を登録してから有効にしてください。秘密の値は会話へ送られません。", TextWrapping = TextWrapping.Wrap });
            if (original.ApplyFailed) Body.Children.Add(new TextBlock { Text = "設定を保存しましたが、反映できませんでした。設定を確認して再度保存してください。", TextWrapping = TextWrapping.Wrap, Foreground = Palette.Get("Danger") });
            Heading("設定");
            foreach (var field in original.Fields)
            {
                if (!field.Secret) { inputs.Add((field, TextField(field.Label, field.Value), null, null)); continue; }
                Body.Children.Add(new TextBlock { Text = field.Label, Margin = new Thickness(0, 10, 0, 5) });
                Body.Children.Add(new TextBlock { Text = field.Configured ? "登録済み・変更するときだけ入力" : "未設定", FontSize = 14 });
                var password = new PasswordBox { Margin = new Thickness(0, 5, 0, 5), Padding = new Thickness(10, 8, 10, 8), FontSize = 16 }; Body.Children.Add(password);
                var remove = new CheckBox { Content = "保存すると登録済みの値を消す", Margin = new Thickness(0, 4, 0, 8) };
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
                    if (updated.ApplyFailed) { Saved = true; Status.Text = "設定を保存しましたが、反映できませんでした。閉じて最新の状態を確認してください。"; return false; }
                    return true;
                }
                finally { values.Clear(); }
            };
            Status.Text = ""; SaveButton.IsEnabled = true;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception) { Status.Text = "追加機能の設定を読み取れませんでした。接続と認証を確認してください。"; }
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
