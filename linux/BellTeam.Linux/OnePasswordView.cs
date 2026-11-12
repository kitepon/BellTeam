using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;
using static BellTeam.Linux.SettingsUi;

namespace BellTeam.Linux;

// The 1Password連携 page of the settings (Mac OnePasswordSettingEditor): badge, guide, the service-account token and the one result line.
// Wording and states come from OnePasswordItem / OnePasswordResult; the token is never shown back and is never resent.
internal sealed class OnePasswordView
{
    private static readonly IBrush Grey = new Avalonia.Media.Immutable.ImmutableSolidColorBrush(Color.FromRgb(0x8E, 0x8E, 0x93));
    private readonly LinuxWorkspace workspace;
    private readonly CancellationToken token;
    private readonly Action<bool> setBusy;
    private FeatureSetting current;
    private OnePasswordResult result = OnePasswordResult.None;
    private bool enabled = true, guideOpen = true, loaded, loading = true, saving;
    private string? errorText;

    private readonly TextBox password = SecretBox("");
    private readonly ContentControl badgeHost = new() { HorizontalAlignment = HorizontalAlignment.Right };
    private readonly TextBlock connection = Text("", 12, Muted, null, new Thickness(0, 6, 0, 0));
    private readonly Control chevron = Glyph(Icons.ChevronDown, 12, Muted);
    private readonly ContentControl chevronHost = new() { Width = 18, VerticalAlignment = VerticalAlignment.Center };
    private readonly StackPanel steps = new() { Margin = new Thickness(18, 10, 0, 4) };
    private readonly Border guideSection = new() { Background = Brushes.White, CornerRadius = new CornerRadius(10), Padding = new Thickness(20, 12), Margin = new Thickness(0, 14, 0, 0) };
    private readonly CheckBox toggle = Violeted(new CheckBox { Content = "1Passwordと連携する", FontSize = 13, VerticalContentAlignment = VerticalAlignment.Center });
    private readonly Border tokenRow;
    private readonly TextBlock resultLine = Text("", 13, Muted), errorLine = Text("", 12, Red);
    private readonly Button save = Capsule("保存して連携を確かめる", Violet, Brushes.White, 8, 13, new Thickness(18, 8));
    private readonly GroupCard saveGroup = new();
    private readonly Border resultRow, errorRow;
    private readonly StackPanel content = new(), loadFailure = new();
    private readonly TextBlock loadingLine = Text("読み込んでいます…", 13, Secondary, null, new Thickness(0, 10, 0, 0));
    private readonly TextBlock loadErrorLine = Text("", 12, Red, null, new Thickness(0, 6, 0, 0));

    public Task Ready { get; }
    public OnePasswordView(LinuxWorkspace workspace, FeatureSetting first, Panel form, CancellationToken token, Action<bool> setBusy)
    {
        this.workspace = workspace; this.token = token; this.setBusy = setBusy; current = first;
        token.Register(ClearToken);
        AutomationProperties.SetName(password, TokenField?.Label ?? "サービスアカウントのトークン");
        toggle.IsCheckedChanged += (_, _) => enabled = toggle.IsChecked == true;
        save.HorizontalAlignment = HorizontalAlignment.Stretch; save.Click += async (_, _) => await SaveAsync();

        var header = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*") };
        var title = Text(first.Title, 15, Ink, FontWeight.SemiBold, new Thickness(12, 0, 0, 0)); title.VerticalAlignment = VerticalAlignment.Center;
        header.Children.Add(Glyph(SettingsIcons.Key, 22, Violet)); Grid.SetColumn(title, 1); header.Children.Add(title); Grid.SetColumn(badgeHost, 1); header.Children.Add(badgeHost);
        var headerCard = new Border { Background = Brushes.White, CornerRadius = new CornerRadius(10), Padding = new Thickness(20, 14), Child = new StackPanel { Children = { header, connection } } };

        var guideHead = new Grid { Background = Brushes.Transparent, Cursor = Hand, ColumnDefinitions = new ColumnDefinitions("18,*") };
        chevronHost.Content = chevron; guideHead.Children.Add(chevronHost); var guideTitle = Text("作り方を見る", 13); Grid.SetColumn(guideTitle, 1); guideHead.Children.Add(guideTitle);
        guideHead.PointerReleased += (_, args) => { if (args.InitialPressMouseButton == MouseButton.Left) { guideOpen = !guideOpen; Refresh(); } };
        AutomationProperties.SetName(guideHead, "作り方を見る");
        guideSection.Child = new StackPanel { Children = { guideHead, steps } };

        tokenRow = Row(password, 40);
        var group = new GroupCard(Row(toggle, 40), tokenRow, Row(Text("貼ったトークンは保存後、画面には表示されません。会話にも送られません。", 12, Muted), 36));
        resultRow = Row(resultLine, 36); errorRow = Row(errorLine, 30);
        saveGroup.Add(resultRow); saveGroup.Add(Row(save, 46)); saveGroup.Add(errorRow);

        content.Children.Add(headerCard); content.Children.Add(guideSection);
        content.Children.Add(FormSection("サービスアカウントのトークン", group)); content.Children.Add(new StackPanel { Margin = new Thickness(0, 22, 0, 0), Children = { saveGroup } });
        var reload = Capsule("再読み込み", Fill, Ink, 8, 13, new Thickness(12, 6)); reload.HorizontalAlignment = HorizontalAlignment.Left; reload.Margin = new Thickness(0, 8, 0, 0); reload.FontWeight = FontWeight.Normal;
        reload.Click += async (_, _) => await LoadAsync();
        loadFailure.Children.Add(Text("設定を読み込めませんでした", 15, Ink, FontWeight.SemiBold)); loadFailure.Children.Add(loadErrorLine); loadFailure.Children.Add(reload);
        form.Children.Add(content); form.Children.Add(loadFailure); form.Children.Add(loadingLine);
        Ready = LoadAsync();
    }

    private FeatureField? TokenField => current.Fields.FirstOrDefault(item => item.Key == "token" && item.Secret);
    public bool Saving => saving;
    // The token leaves the screen with the page (and with the window's focus); only the form's own copy exists.
    public void ClearToken() => password.Text = "";

    private async Task LoadAsync()
    {
        loading = true; Refresh();
        try
        {
            var item = (await workspace.Planning.FeaturesAsync(token)).FirstOrDefault(feature => feature.Id == OnePasswordItem.Id) ?? throw new BellApiException("1Password連携の設定が見つかりません。");
            token.ThrowIfCancellationRequested();
            current = item; enabled = item.Enabled || item.Status == "unconfigured"; guideOpen = OnePasswordItem.State(item) != OnePasswordState.Connected;
            result = result.Refreshed(item); loaded = true; errorText = null;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception error) { errorText = error.Message; }
        loading = false; Refresh();
    }

    private async Task SaveAsync()
    {
        if (saving || loading) return;
        var pasted = (password.Text ?? "").Trim();
        if (OnePasswordItem.SaveProblem(enabled, pasted, TokenField?.Configured == true) is { } problem) { errorText = problem; Refresh(); return; }
        saving = true; setBusy(true); password.Text = ""; errorText = null; result = OnePasswordResult.Checking; Refresh();
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
            current = item; result = result.Refreshed(item);
        }
        catch (Exception error) { errorText = "保存しました。表示を更新できませんでした（" + error.Message + "）"; }
        saving = false; setBusy(false); Refresh();
    }

    private void Refresh()
    {
        content.IsVisible = loaded;
        loadingLine.IsVisible = loading;
        loadFailure.IsVisible = !loaded && !loading && errorText is not null; loadErrorLine.Text = loaded ? "" : errorText ?? "";
        if (!loaded) return;
        var state = OnePasswordItem.State(current);
        badgeHost.Content = Badge(state);
        connection.Text = OnePasswordItem.ConnectionLine(current) ?? ""; connection.IsVisible = connection.Text.Length != 0;
        guideSection.IsVisible = current.Guide is not null;
        steps.Children.Clear(); chevronHost.Content = Glyph(guideOpen ? Icons.ChevronDown : Icons.ChevronRight, 12, Muted); steps.IsVisible = guideOpen;
        if (current.Guide is { } guide)
        {
            foreach (var step in guide.Steps) steps.Children.Add(Text(step, 13, Ink, null, new Thickness(0, 4)));
            if (guide.OpenableLink is { } link) steps.Children.Add(LinkButton(link.Label, link.Url));
        }
        toggle.IsChecked = enabled;
        tokenRow.IsVisible = TokenField is not null;
        password.PlaceholderText = TokenField?.Configured == true ? "登録済み・変更するときだけ入力" : "ops_で始まるトークンを貼る"; password.PlaceholderForeground = Secondary;
        // An empty line takes no height.
        resultLine.Text = result.Text; resultLine.Foreground = result.Kind switch { OnePasswordResultKind.Connected => Green, OnePasswordResultKind.Failed => Red, _ => Muted };
        saveGroup.SetVisible(resultRow, result.Kind != OnePasswordResultKind.None);
        errorLine.Text = errorText ?? ""; saveGroup.SetVisible(errorRow, errorText is not null);
        save.Content = saving ? "連携を確かめています…" : "保存して連携を確かめる"; save.IsEnabled = !loading && !saving;
    }

    private Button LinkButton(string label, Uri url)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 }; line.Children.Add(Glyph(Icons.Link, 15, Violet)); var text = Text(label, 13, Violet); text.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(text);
        var button = Capsule("", Brushes.Transparent, Violet, 8, 13, new Thickness(0, 6)); button.Content = line; button.HorizontalAlignment = HorizontalAlignment.Left;
        AutomationProperties.SetName(button, label);
        button.Click += (_, _) => OpenExternal(url.AbsoluteUri, message => { errorText = message; Refresh(); });
        return button;
    }

    // The tinted capsule of the list row and the page header: 連携中 green, 未連携 grey, 失敗 red.
    public static Control Badge(OnePasswordState state)
    {
        var tint = state switch { OnePasswordState.Connected => Green, OnePasswordState.Off => Grey, _ => Red };
        var color = ((ISolidColorBrush)tint).Color;
        Control icon = state switch
        {
            OnePasswordState.Failed => Glyph(Icons.Warning, 15, tint),
            _ => new Grid { Width = 15, Height = 15, Children = { new Avalonia.Controls.Shapes.Ellipse { Fill = tint }, state == OnePasswordState.Connected ? Glyph(Icons.Check, 9, Brushes.White) : new Border { Width = 7, Height = 1.8, Background = Brushes.White, CornerRadius = new CornerRadius(1), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } } }
        };
        var label = Text(OnePasswordItem.BadgeText(state), 13, tint, FontWeight.SemiBold); label.VerticalAlignment = VerticalAlignment.Center;
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, Children = { icon, label } };
        var badge = new Border { Child = line, Background = new SolidColorBrush(Color.FromArgb(0x1F, color.R, color.G, color.B)), CornerRadius = new CornerRadius(13), Padding = new Thickness(10, 4, 12, 4), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(badge, OnePasswordItem.BadgeText(state));
        return badge;
    }

    // Render seam (checking and success need a PATCH, which the GET-only mock never serves): the line and busy state the PATCH would have produced.
    public void ShowForRender(string scene)
    {
        if (scene == "checking") { saving = true; result = OnePasswordResult.Checking; }
        else if (scene == "success") result = OnePasswordResult.Saved(current);
        Refresh();
    }
}
