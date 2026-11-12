using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;

namespace BellTeam.App;

// The body of the settings 1Password page (Mac OnePasswordSettingEditor): what is readable, the guide, the service-account token and the one result line.
// The page head (settings-user-flow 4.9b) carries the title and the badge; changed tells it whenever the item was read again.
// Wording and states come from OnePasswordItem / OnePasswordResult; the token is never shown back and is never resent.
internal sealed class OnePasswordView
{
    private static SolidColorBrush Freeze(SolidColorBrush brush) { brush.Freeze(); return brush; }
    private readonly Workspace workspace;
    private readonly CancellationToken token;
    private readonly Action<bool> setBusy;
    private readonly Action<FeatureSetting>? changed;
    private readonly Border connectionCard = new() { Background = Brushes.White, CornerRadius = new CornerRadius(10), Padding = new Thickness(20, 14, 20, 14) };
    private FeatureSetting current;
    private OnePasswordResult result = OnePasswordResult.None;
    private bool enabled = true, guideOpen = true, loaded, loading = true, saving;
    private string? errorText;

    private readonly PasswordBox password = new() { Style = null, FontSize = 13, Foreground = Ink, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(0), VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock hint = Text("", 13, Secondary);
    private readonly TextBlock connection = Text("", 12, Muted, null, new Thickness(0, 6, 0, 0));
    private readonly TextBlock chevron = Glyph("", 11, Muted);
    private readonly StackPanel steps = new() { Margin = new Thickness(18, 10, 0, 4) };
    private readonly Border guideSection = new() { Background = Brushes.White, CornerRadius = new CornerRadius(10), Padding = new Thickness(20, 12, 20, 12), Margin = new Thickness(0, 14, 0, 0) };
    private readonly (Grid Row, System.Windows.Controls.Primitives.ToggleButton Switch) toggleParts = SettingsUi.SwitchRow("1Passwordと連携する");
    private System.Windows.Controls.Primitives.ToggleButton toggle => toggleParts.Switch;
    private readonly Border tokenRow;
    private readonly TextBlock resultLine = Text("", 13, Muted), errorLine = Text("", 12, Red);
    private readonly Button save = Capsule("保存して連携を確かめる", Violet, Brushes.White, 8, 13, new Thickness(18, 8, 18, 8));
    private readonly GroupCard saveGroup = new();
    private readonly Border resultRow, errorRow;
    private readonly StackPanel content = new(), loadFailure = new();
    private readonly TextBlock loadingLine = Text("読み込んでいます…", 13, Secondary, null, new Thickness(0, 10, 0, 0));
    private readonly TextBlock loadErrorLine = Text("", 12, Red, null, new Thickness(0, 6, 0, 0));

    public Task Ready { get; }
    public OnePasswordView(Workspace workspace, FeatureSetting first, Panel form, CancellationToken token, Action<bool> setBusy, Action<FeatureSetting>? changed = null)
    {
        this.workspace = workspace; this.token = token; this.setBusy = setBusy; this.changed = changed; current = first;
        token.Register(ClearToken);
        System.Windows.Automation.AutomationProperties.SetName(password, TokenField?.Label ?? "サービスアカウントのトークン");
        password.PasswordChanged += (_, _) => hint.Visibility = password.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        hint.IsHitTestVisible = false; hint.VerticalAlignment = VerticalAlignment.Center;
        toggle.Checked += (_, _) => enabled = true; toggle.Unchecked += (_, _) => enabled = false;
        save.HorizontalAlignment = HorizontalAlignment.Stretch; save.Click += async (_, _) => await SaveAsync();

        connectionCard.Child = connection;

        var guideHead = new Grid { Background = Brushes.Transparent, Cursor = System.Windows.Input.Cursors.Hand };
        guideHead.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(18) }); guideHead.ColumnDefinitions.Add(new ColumnDefinition());
        guideHead.Children.Add(chevron); var guideTitle = Text("作り方を見る", 13); Grid.SetColumn(guideTitle, 1); guideHead.Children.Add(guideTitle);
        guideHead.MouseLeftButtonUp += (_, _) => { guideOpen = !guideOpen; Refresh(); };
        System.Windows.Automation.AutomationProperties.SetName(guideHead, "作り方を見る");
        guideSection.Child = new StackPanel { Children = { guideHead, steps } };

        var tokenGrid = new Grid(); tokenGrid.Children.Add(password); tokenGrid.Children.Add(hint); tokenRow = Row(tokenGrid, 40);
        var group = new GroupCard(Row(toggleParts.Row, 40), tokenRow, Row(Text("貼ったトークンは保存後、画面には表示されません。会話にも送られません。", 12, Muted), 36));
        resultRow = Row(resultLine, 36); errorRow = Row(errorLine, 30);
        saveGroup.Add(resultRow); saveGroup.Add(Row(save, 46)); saveGroup.Add(errorRow);

        content.Children.Add(connectionCard); content.Children.Add(guideSection);
        content.Children.Add(FormSection("サービスアカウントのトークン", group)); content.Children.Add(new StackPanel { Margin = new Thickness(0, 22, 0, 0), Children = { saveGroup } });
        var reload = Capsule("再読み込み", Fill, Ink, 8, 13, new Thickness(12, 6, 12, 6)); reload.HorizontalAlignment = HorizontalAlignment.Left; reload.Margin = new Thickness(0, 8, 0, 0); reload.FontWeight = FontWeights.Normal;
        reload.Click += async (_, _) => await LoadAsync();
        loadFailure.Children.Add(Text("設定を読み込めませんでした", 15, Ink, FontWeights.SemiBold)); loadFailure.Children.Add(loadErrorLine); loadFailure.Children.Add(reload);
        form.Children.Add(content); form.Children.Add(loadFailure); form.Children.Add(loadingLine);
        Ready = LoadAsync();
    }

    private FeatureField? TokenField => current.Fields.FirstOrDefault(item => item.Key == "token" && item.Secret);
    public bool Saving => saving;
    // The token leaves the screen with the page (and with the window's focus); only the form's own copy exists.
    public void ClearToken() => password.Clear();

    private async Task LoadAsync()
    {
        loading = true; Refresh();
        try
        {
            var item = (await workspace.Planning.FeaturesAsync(token)).FirstOrDefault(feature => feature.Id == OnePasswordItem.Id) ?? throw new BellApiException("1Password連携の設定が見つかりません。");
            token.ThrowIfCancellationRequested();
            current = item; enabled = item.Enabled || item.Status == "unconfigured"; guideOpen = OnePasswordItem.State(item) != OnePasswordState.Connected;
            result = result.Refreshed(item); loaded = true; errorText = null; changed?.Invoke(item);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { errorText = error.Message; }
        loading = false; Refresh();
    }

    private async Task SaveAsync()
    {
        if (saving || loading) return;
        var pasted = password.Password.Trim();
        if (OnePasswordItem.SaveProblem(enabled, pasted, TokenField?.Configured == true) is { } problem) { errorText = problem; Refresh(); return; }
        saving = true; setBusy(true); password.Clear(); errorText = null; result = OnePasswordResult.Checking; Refresh();
        var values = new Dictionary<string, string>(); if (pasted.Length != 0) values["token"] = pasted;
        try
        {
            // One PATCH, never resent. The line is decided by the response's setting; a rejected request clears it and shows the form error.
            var saved = await workspace.Planning.SaveFeatureAsync(OnePasswordItem.Id, enabled, values); // not tied to the page's token: leaving the page must not abort a PATCH that may already be applied
            result = OnePasswordResult.Saved(saved);
        }
        catch (Exception error) { result = OnePasswordResult.None; errorText = error.Message; saving = false; setBusy(false); Refresh(); return; }
        finally { values.Clear(); }
        try
        {
            var item = (await workspace.Planning.FeaturesAsync(token)).FirstOrDefault(feature => feature.Id == OnePasswordItem.Id) ?? throw new BellApiException("1Password連携の設定が見つかりません。");
            // The badge follows the re-read item; the guide opens or folds only when the connection state changes.
            if ((OnePasswordItem.State(item) == OnePasswordState.Connected) != (OnePasswordItem.State(current) == OnePasswordState.Connected)) guideOpen = OnePasswordItem.State(item) != OnePasswordState.Connected;
            current = item; result = result.Refreshed(item); changed?.Invoke(item);
        }
        catch (Exception error) { errorText = "保存しました。表示を更新できませんでした（" + error.Message + "）"; }
        saving = false; setBusy(false); Refresh();
    }

    private void Refresh()
    {
        content.Visibility = loaded ? Visibility.Visible : Visibility.Collapsed;
        loadingLine.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        loadFailure.Visibility = !loaded && !loading && errorText is not null ? Visibility.Visible : Visibility.Collapsed; loadErrorLine.Text = loaded ? "" : errorText ?? "";
        if (!loaded) return;
        connection.Text = OnePasswordItem.ConnectionLine(current) ?? ""; connectionCard.Visibility = connection.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        guideSection.Visibility = current.Guide is null ? Visibility.Collapsed : Visibility.Visible;
        steps.Children.Clear(); chevron.Text = guideOpen ? "" : ""; steps.Visibility = guideOpen ? Visibility.Visible : Visibility.Collapsed;
        if (current.Guide is { } guide)
        {
            foreach (var step in guide.Steps) steps.Children.Add(Text(step, 13, Ink, null, new Thickness(0, 4, 0, 4)));
            if (guide.OpenableLink is { } link) steps.Children.Add(LinkButton(link.Label, link.Url));
        }
        toggle.IsChecked = enabled;
        tokenRow.Visibility = TokenField is null ? Visibility.Collapsed : Visibility.Visible;
        hint.Text = TokenField?.Configured == true ? "登録済み・変更するときだけ入力" : "ops_で始まるトークンを貼る"; hint.Visibility = password.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        // An empty line takes no height.
        resultLine.Text = result.Text; resultLine.Foreground = result.Kind switch { OnePasswordResultKind.Connected => Green, OnePasswordResultKind.Failed => Red, _ => Muted };
        saveGroup.SetVisible(resultRow, result.Kind != OnePasswordResultKind.None);
        errorLine.Text = errorText ?? ""; saveGroup.SetVisible(errorRow, errorText is not null);
        save.Content = saving ? "連携を確かめています…" : "保存して連携を確かめる"; save.IsEnabled = !loading && !saving;
    }

    private Button LinkButton(string label, Uri url)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal }; line.Children.Add(Glyph("", 13, Violet)); line.Children.Add(Text(label, 13, Violet, null, new Thickness(8, 0, 0, 0)));
        var button = Capsule("", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 6, 0, 0)); button.Content = line; button.HorizontalAlignment = HorizontalAlignment.Left;
        System.Windows.Automation.AutomationProperties.SetName(button, label);
        button.Click += (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception error) { errorText = "ページを開けませんでした。" + error.Message; Refresh(); }
        };
        return button;
    }

    // Render seam (checking and success need a PATCH, which the GET-only mock never serves): the line and busy state the PATCH would have produced.
    public void ShowForRender(string scene)
    {
        if (scene == "checking") { saving = true; result = OnePasswordResult.Checking; }
        else if (scene == "success") result = OnePasswordResult.Saved(current);
        Refresh();
    }
}
