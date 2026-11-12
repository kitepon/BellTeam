using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;

namespace BellTeam.App;

// Mac SecretRequestCard / OwnerQuestionCard: a white card with a violet title line; the parts are spaced 12 apart.
public sealed class SecretCard(Workspace workspace, string author) : StackPanel
{
    private SecretRequest? current;
    private string currentAuthor = author;
    public void Update(SecretRequest request) => Update(request, currentAuthor);
    public void Update(SecretRequest request, string sender)
    {
        if (current == request && currentAuthor == sender) return;
        current = request; currentAuthor = sender; Children.Clear();
        Children.Add(CardTitle("\uE72E", currentAuthor + " · 秘密情報の入力"));
        Children.Add(CardBody(request.Message));
        // The label names what is asked; the tool ID is an internal key and stays out of sight.
        Children.Add(KeyLine(request.Label));
        if (request.Status == "pending")
        {
            var open = new Button { Content = "安全な入力欄を開く", FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 9, 16, 9), Margin = new Thickness(0, 12, 0, 0) };
            open.SetResourceReference(StyleProperty, "PrimaryButton");
            open.Click += (_, _) => Open(request);
            Children.Add(open);
        }
        else if (request.Status == "submitted") Children.Add(StatusBadge("登録済み", SettingsTone.Green, "\uEC61"));
        else if (request.Status == "cancelled") Children.Add(StatusBadge("入力を取り消しました", SettingsTone.Gray, "\uEB90"));
        else Children.Add(CardText("不明な入力状態: " + request.Status, error: true));
        if (request.Notification == "failed") Children.Add(CardText("AIへの通知に失敗しました。チャットで完了を知らせてください。", size: 14, error: true));
    }
    internal SecretInputWindow CreateInput(SecretRequest request) => new(request, submission => workspace.FinishSecretAsync(request.Id, submission), () => workspace.SecretKeysAsync(request.Id), Update) { Owner = Window.GetWindow(this) };
    private void Open(SecretRequest request) => CreateInput(request).ShowDialog();
    private static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");
    // Mac BellBadge: the state is a tinted capsule, not a bare line.
    private static FrameworkElement StatusBadge(string text, SettingsTone tone, string glyph) { var badge = SettingsUi.Badge(text, tone, glyph); badge.HorizontalAlignment = HorizontalAlignment.Left; badge.Margin = new Thickness(0, 12, 0, 0); return badge; }
    private static FrameworkElement KeyLine(string label) => new StackPanel
    {
        Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0),
        Children = { new TextBlock { Text = "\uE8D7", FontFamily = Icons, FontSize = 13, Foreground = MutedInk, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) }, new TextBlock { Text = label, FontSize = 14, Foreground = MutedInk, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap } }
    };
    internal static FrameworkElement CardTitle(string glyph, string text) => new StackPanel
    {
        Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12),
        Children = { new TextBlock { Text = glyph, FontFamily = Icons, FontSize = 14, Foreground = Violet, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, new TextBlock { Text = text, FontSize = 15, FontWeight = FontWeights.SemiBold, Foreground = Violet, VerticalAlignment = VerticalAlignment.Center } }
    };
    internal static FrameworkElement CardStatus(string glyph, string text, bool strong = false) => new StackPanel
    {
        Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0),
        Children = { new TextBlock { Text = glyph, FontFamily = Icons, FontSize = 14, Foreground = strong ? Violet : Ink, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) }, new TextBlock { Text = text, FontSize = 15, FontWeight = strong ? FontWeights.SemiBold : FontWeights.Normal, Foreground = strong ? Violet : Ink, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap } }
    };
    private static readonly Brush Violet = Frozen(Color.FromRgb(97, 71, 212)), Ink = Frozen(Color.FromRgb(33, 41, 61)), MutedInk = Frozen(Color.FromRgb(120, 125, 145)), Red = Frozen(Color.FromRgb(255, 59, 48));
    internal static Brush Frozen(Color color) { var brush = new SolidColorBrush(color); brush.Freeze(); return brush; }
    internal static TextBlock CardText(string text, bool bold = false, bool error = false, double size = 16, bool muted = false) => new() { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = error ? Red : muted ? MutedInk : Ink, Margin = new Thickness(0, 12, 0, 0) };
    internal static TextBox CardBody(string text) => new() { Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 18, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), Margin = new Thickness(0) };
}

// Mac SecretInputSheet: a grouped form. The message and the note, the input method, the field or the 1Password list, then the buttons.
// All the parts exist from the start and only their visibility changes, so focus and typing survive a change of method.
public sealed class SecretInputWindow : Window
{
    private readonly SecretInputModel model;
    private readonly Func<SecretSubmission?, Task<SecretRequest>> finish;
    private readonly Func<Task<OnePasswordKey[]?>> loadKeys;
    private readonly Action<SecretRequest> completed;
    internal PasswordBox Input { get; } = new() { Style = null, BorderThickness = new Thickness(0), Background = Brushes.Transparent, Padding = new Thickness(0), FontSize = 16, Foreground = SettingsUi.Ink, VerticalAlignment = VerticalAlignment.Center };
    internal TextBox Paste { get; }
    internal TextBox Reference { get; }
    internal TextBox Search { get; }
    internal TextBlock ErrorText { get; } = SettingsUi.Text("", 14, SettingsUi.Red);
    internal Task KeysReady { get; private set; } = Task.CompletedTask;
    private readonly Grid inputField = new(), pasteField, referenceField, searchField;
    private readonly TextBlock note = SettingsUi.Text("", 14, SettingsUi.Secondary), unsupported = SettingsUi.Text("", 14, SettingsUi.Secondary), pickerStatus = SettingsUi.Text("", 16, SettingsUi.Muted), count = SettingsUi.Text("", 14, SettingsUi.Secondary);
    private readonly UIElement unsupportedRow, errorRow;
    private readonly GroupCard top, buttons;
    private readonly FrameworkElement statusRow, searchRow, countRow, retryRow, choices;
    private readonly Border pickerCard, referenceCard, pasteCard, passwordCard;
    private readonly RadioButton onePasswordChoice = ChoiceButton(), inputChoice = ChoiceButton();
    private readonly StackPanel keysHost = new();
    private readonly Button submit = RowButton("", SettingsUi.Violet), decline = RowButton("入力を断る", SettingsUi.Red), close = new() { Content = "閉じる" };
    private bool sending, syncing;
    public SecretInputWindow(SecretRequest request, Func<SecretSubmission?, Task<SecretRequest>> finish, Func<Task<OnePasswordKey[]?>> loadKeys, Action<SecretRequest> completed)
    {
        this.finish = finish; this.loadKeys = loadKeys; this.completed = completed; model = new SecretInputModel(request);
        Title = request.Label; Width = 720; SizeToContent = SizeToContent.Height; MaxHeight = SystemParameters.WorkArea.Height; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = SettingsUi.Canvas;
        (searchField, Search) = BigField("名前や保管庫で絞り込む");
        (referenceField, Reference) = BigField("op://保管庫/アイテム/フィールド");
        // The Mac TextEditor has no hint; the box keeps its own name for screen readers.
        (pasteField, Paste) = SettingsUi.Field("", "", multiline: true, minHeight: 120); Paste.FontFamily = new FontFamily("Consolas, Yu Gothic UI"); System.Windows.Automation.AutomationProperties.SetName(Paste, request.Label);
        // The Mac SecureField: the label is the hint.
        var hint = SettingsUi.Text(request.Label, 16, SettingsUi.Secondary); hint.IsHitTestVisible = false; hint.VerticalAlignment = VerticalAlignment.Center;
        System.Windows.Automation.AutomationProperties.SetName(Input, request.Label);
        inputField.Children.Add(Input); inputField.Children.Add(hint);
        Input.PasswordChanged += (_, _) => { hint.Visibility = Input.Password.Length == 0 ? Visibility.Visible : Visibility.Collapsed; UpdateButtons(); };
        Paste.TextChanged += (_, _) => UpdateButtons();
        Reference.TextChanged += (_, _) => { model.Reference = Reference.Text; UpdateButtons(); };
        Search.TextChanged += (_, _) => { model.SetSearch(Search.Text); RefreshKeys(); UpdateButtons(); };

        var message = request.Message.Length == 0 || request.IsLoginPassword ? null : SecretCard.CardBody(request.Message); // a login card shows the message as its note (purpose, not wording)
        if (message is not null) message.Margin = new Thickness(-2, 0, 0, 0);
        top = new GroupCard(); if (message is not null) top.Add(SettingsUi.Row(message, 50)); top.Add(SettingsUi.Row(note, 46));
        unsupportedRow = SettingsUi.Row(unsupported); top.Add(unsupportedRow);
        onePasswordChoice.GroupName = inputChoice.GroupName = "source";
        onePasswordChoice.Checked += (_, _) => ChooseSource(true); inputChoice.Checked += (_, _) => ChooseSource(false);
        choices = SettingsUi.FormSection("入力方法", new GroupCard(onePasswordChoice, inputChoice));

        statusRow = SettingsUi.Row(pickerStatus); searchRow = SettingsUi.Row(searchField);
        retryRow = Divided(SettingsUi.Row(EditorFormView.LinkButton("もう一度読み込む", () => KeysReady = LoadKeysAsync()))); countRow = Divided(SettingsUi.Row(count));
        pickerCard = Card(statusRow, retryRow, searchRow, countRow, keysHost); referenceCard = Card(SettingsUi.Row(referenceField)); pasteCard = Card(SettingsUi.Row(pasteField)); passwordCard = Card(SettingsUi.Row(inputField));
        var value = new StackPanel { Children = { pickerCard, referenceCard, pasteCard, passwordCard } };

        errorRow = SettingsUi.Row(ErrorText);
        submit.Click += async (_, _) => await SubmitAsync(true); decline.Click += async (_, _) => await SubmitAsync(false);
        buttons = new GroupCard(submit, decline, errorRow);
        var form = new StackPanel { Margin = new Thickness(20, 4, 20, 28), Children = { top, choices, SettingsUi.FormSection(request.Label, value), SettingsUi.FormSection(null, buttons) } };

        close.SetResourceReference(StyleProperty, "SheetPillButton"); close.HorizontalAlignment = HorizontalAlignment.Left; close.VerticalAlignment = VerticalAlignment.Center; close.Margin = new Thickness(12, 0, 0, 0);
        close.Click += (_, _) => Close();
        var heading = SettingsUi.Text(request.Label, 15, SettingsUi.Ink, FontWeights.SemiBold); heading.HorizontalAlignment = HorizontalAlignment.Center; heading.VerticalAlignment = VerticalAlignment.Center;
        var header = new Grid { Height = 52, Children = { heading, close } }; DockPanel.SetDock(header, Dock.Top);
        Content = new DockPanel { Children = { header, new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } } };

        Deactivated += (_, _) => ClearFields();
        Closed += (_, _) => ClearFields();
        Closing += (_, args) => { if (sending) args.Cancel = true; };
        Refresh();
        if (model.Picker) KeysReady = LoadKeysAsync();
    }

    private static StackPanel Divided(UIElement row) => new() { Children = { Divider(), row } };
    private static Border Divider() => new() { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 0, 0, 0) };
    // The Mac Form field at body size.
    private static (Grid, TextBox) BigField(string hint)
    {
        var (grid, box) = SettingsUi.Field(hint, ""); box.FontSize = 16; ((TextBlock)grid.Children[1]).FontSize = 16; grid.Margin = new Thickness(-2, 0, 0, 0); return (grid, box);
    }
    private static Border Card(params UIElement[] rows) { var stack = new StackPanel(); foreach (var row in rows) stack.Children.Add(row); return new Border { Child = stack, Background = Brushes.White, CornerRadius = new CornerRadius(10) }; }

    // The value as typed: a pasted key keeps its newlines and nothing is trimmed.
    internal string Value => model.Multiline ? Paste.Text : Input.Password;
    private void ClearFields()
    {
        Input.Clear(); Paste.Clear(); Reference.Clear(); model.Reference = "";
        RefreshKeys(); UpdateButtons();
    }
    private void ChooseSource(bool onePassword)
    {
        if (syncing || model.UseOnePassword == onePassword) return;
        model.UseOnePassword = onePassword; ClearFields(); Refresh();
    }

    private async Task LoadKeysAsync()
    {
        model.Loading(); Refresh();
        try { model.KeysLoaded(await loadKeys()); }
        catch (Exception) { model.KeysFailed(); }
        Refresh();
    }

    // Brings every part in line with the model.
    private void Refresh()
    {
        syncing = true;
        note.Text = model.Note;
        unsupported.Text = model.UnsupportedLine ?? ""; top.SetVisible(unsupportedRow, model.UnsupportedLine is not null);
        choices.Visibility = model.ChoicesShown ? Visibility.Visible : Visibility.Collapsed;
        onePasswordChoice.Content = model.OnePasswordChoice; inputChoice.Content = model.InputChoice;
        onePasswordChoice.IsChecked = model.UseOnePassword; inputChoice.IsChecked = !model.UseOnePassword;
        syncing = false;
        pickerCard.Visibility = model.UseOnePassword && model.Picker ? Visibility.Visible : Visibility.Collapsed;
        referenceCard.Visibility = model.UseOnePassword && !model.Picker ? Visibility.Visible : Visibility.Collapsed;
        pasteCard.Visibility = !model.UseOnePassword && model.Multiline ? Visibility.Visible : Visibility.Collapsed;
        passwordCard.Visibility = !model.UseOnePassword && !model.Multiline ? Visibility.Visible : Visibility.Collapsed;
        var list = model.Keys;
        statusRow.Visibility = list == KeyListState.Loaded && model.HasKeys ? Visibility.Collapsed : Visibility.Visible;
        pickerStatus.Text = list switch { KeyListState.Loading => model.LoadingLine, KeyListState.Failed => model.FailedLine, _ => model.EmptyLine };
        pickerStatus.Foreground = list == KeyListState.Failed ? SettingsUi.Red : SettingsUi.Muted;
        retryRow.Visibility = list == KeyListState.Failed ? Visibility.Visible : Visibility.Collapsed;
        searchRow.Visibility = countRow.Visibility = keysHost.Visibility = model.HasKeys ? Visibility.Visible : Visibility.Collapsed;
        RefreshKeys(); UpdateButtons();
    }
    private void RefreshKeys()
    {
        keysHost.Children.Clear();
        if (!model.HasKeys) return;
        count.Text = model.CountLine;
        foreach (var key in model.Shown)
        {
            var title = SettingsUi.Text(key.Title, 16); var content = new StackPanel { Children = { title } };
            if (!string.IsNullOrEmpty(key.Vault)) content.Children.Add(SettingsUi.Text(key.Vault, 13, SettingsUi.Secondary, null, new Thickness(0, 2, 0, 0)));
            var choice = ChoiceButton(); choice.GroupName = "keys"; choice.Content = content; choice.IsChecked = model.Reference == key.Reference;
            System.Windows.Automation.AutomationProperties.SetName(choice, key.Title + (string.IsNullOrEmpty(key.Vault) ? "" : "（" + key.Vault + "）"));
            choice.Checked += (_, _) => { model.Reference = key.Reference; UpdateButtons(); };
            keysHost.Children.Add(new StackPanel { Children = { new Border { Height = 1, Background = SettingsUi.Hairline, Margin = new Thickness(20, 0, 0, 0) }, choice } });
        }
    }
    private void UpdateButtons()
    {
        submit.Content = model.SubmitLabel; System.Windows.Automation.AutomationProperties.SetName(submit, model.SubmitLabel);
        submit.IsEnabled = !sending && model.Ready(Value); decline.IsEnabled = !sending;
        // The Mac Form button: a greyed label when it cannot be used.
        submit.Foreground = submit.IsEnabled ? SettingsUi.Violet : DisabledGrey; decline.Foreground = decline.IsEnabled ? SettingsUi.Red : DisabledGrey;
        buttons.SetVisible(errorRow, ErrorText.Text.Length != 0);
    }

    internal async Task SubmitAsync(bool register)
    {
        if (sending) return;
        SecretSubmission? submission = null;
        if (register)
        {
            var value = Value;
            if (!model.Ready(value)) return;
            if (model.UseOnePassword && SecretSubmission.ReferenceProblem(model.Reference) is { } problem) { ErrorText.Text = problem; UpdateButtons(); return; }
            submission = model.UseOnePassword ? SecretSubmission.OnePassword(model.Reference) : SecretSubmission.Value(value);
        }
        sending = true; close.IsEnabled = false; ErrorText.Text = "";
        foreach (var field in new UIElement[] { Input, Paste, Reference, Search, inputChoice, onePasswordChoice, keysHost }) field.IsEnabled = false;
        ClearFields();
        SecretRequest result;
        try { result = await finish(submission); }
        catch (Exception)
        {
            // 入力値を含み得る例外の本文・スタックを画面やログへ渡さない。
            ErrorText.Text = "登録結果を確認できませんでした。閉じて最新の状態を確認してください。";
            return;
        }
        finally
        {
            sending = false; close.IsEnabled = true;
            foreach (var field in new UIElement[] { Input, Paste, Reference, Search, inputChoice, onePasswordChoice, keysHost }) field.IsEnabled = true;
            UpdateButtons();
        }
        completed(result); Close();
    }

    // Render seam: the text typed into the search box.
    internal void SearchForRender(string text) => Search.Text = text;

    internal static RadioButton ChoiceButton()
    {
        var choice = new RadioButton { Template = ChoiceTemplate, FontSize = 16, Foreground = SettingsUi.Ink, Cursor = System.Windows.Input.Cursors.Hand, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        return choice;
    }
    private static readonly Brush DisabledGrey = new SolidColorBrush(Color.FromRgb(0xC7, 0xC7, 0xCC));
    private static Button RowButton(string label, Brush color) => new() { Content = label, Template = RowButtonTemplate, Foreground = color, FontSize = 16, Cursor = System.Windows.Input.Cursors.Hand };
    private const string Presentation = "xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\"";
    // A selectable row of a grouped list: the content on the left and a violet check on the right when chosen (Mac checkmark rows).
    private static readonly ControlTemplate ChoiceTemplate = (ControlTemplate)System.Windows.Markup.XamlReader.Parse(
        $"<ControlTemplate {Presentation} TargetType=\"RadioButton\"><Border x:Name=\"Chrome\" Background=\"Transparent\" Padding=\"20,11\"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width=\"*\"/><ColumnDefinition Width=\"Auto\"/></Grid.ColumnDefinitions>"
        + "<ContentPresenter VerticalAlignment=\"Center\"/><TextBlock x:Name=\"Mark\" Grid.Column=\"1\" Text=\"&#xE73E;\" FontFamily=\"Segoe Fluent Icons, Segoe MDL2 Assets\" FontSize=\"16\" Foreground=\"#6147D4\" VerticalAlignment=\"Center\" Visibility=\"Collapsed\"/></Grid></Border>"
        + "<ControlTemplate.Triggers><Trigger Property=\"IsChecked\" Value=\"True\"><Setter TargetName=\"Mark\" Property=\"Visibility\" Value=\"Visible\"/></Trigger><Trigger Property=\"IsKeyboardFocused\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#146147D4\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
    // A plain text row of a grouped list (Mac Form Button): a coloured label that fades when disabled.
    private static readonly ControlTemplate RowButtonTemplate = (ControlTemplate)System.Windows.Markup.XamlReader.Parse(
        $"<ControlTemplate {Presentation} TargetType=\"Button\"><Border x:Name=\"Chrome\" Background=\"Transparent\" Padding=\"20,12\"><ContentPresenter HorizontalAlignment=\"Left\" VerticalAlignment=\"Center\"/></Border>"
        + "<ControlTemplate.Triggers><Trigger Property=\"IsKeyboardFocused\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#146147D4\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
}

public sealed class QuestionCard(Workspace workspace, string author) : StackPanel
{
    private OwnerQuestion? current;
    private string currentAuthor = author;
    private bool sending;
    private readonly List<Control> inputs = [];
    private readonly TextBlock error = new() { TextWrapping = TextWrapping.Wrap, FontSize = 14, Foreground = new SolidColorBrush(Color.FromRgb(255, 59, 48)), VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid errorLine = new() { Margin = new Thickness(0, 12, 0, 0) };
    private TextBlock? title;
    public void Update(OwnerQuestion question) => Update(question, currentAuthor);
    public void Update(OwnerQuestion question, string sender)
    {
        if (current is { } old && old.Id == question.Id && old.Status == question.Status && old.Question == question.Question && old.AllowOther == question.AllowOther && old.Answer == question.Answer && old.Options.SequenceEqual(question.Options))
        {
            current = question; currentAuthor = sender;
            title!.Text = currentAuthor + " · 選んでほしいこと";
            return;
        }
        current = question; currentAuthor = sender; Children.Clear(); inputs.Clear();
        var header = (StackPanel)SecretCard.CardTitle("\uE8FD", currentAuthor + " · 選んでほしいこと"); title = (TextBlock)header.Children[1];
        Children.Add(header);
        Children.Add(SecretCard.CardBody(question.Question));
        if (question.Status == "answered") { Children.Add(SecretCard.CardStatus("\uE73E", "回答: " + question.Answer, strong: true)); return; }
        if (question.Status != "open") { Children.Add(SecretCard.CardText("不明な回答状態: " + question.Status, error: true)); return; }
        // Mac ChoiceButtons: one choice per line, full width, its number icon first; a long choice wraps and shows in full.
        var choices = new StackPanel { Margin = new Thickness(0, 12, 0, 0) }; var template = ChoiceTemplate();
        for (var index = 0; index < question.Options.Length; index++)
        {
            var option = question.Options[index];
            var button = new Button { Content = ChoiceContent(index, option), Template = template, HorizontalContentAlignment = HorizontalAlignment.Stretch, IsEnabled = !sending, Margin = new Thickness(0, 0, 0, 8), Cursor = System.Windows.Input.Cursors.Hand };
            System.Windows.Automation.AutomationProperties.SetName(button, option);
            button.Click += async (_, _) => await AnswerAsync(question.Id, option, null);
            choices.Children.Add(button); inputs.Add(button);
        }
        Children.Add(choices);
        if (question.AllowOther)
        {
            var other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, IsEnabled = !sending, FontSize = 14, Padding = new Thickness(8, 6, 8, 6) };
            var placeholder = new TextBlock { Text = "その他（文章で答える）", FontSize = 14, Foreground = new SolidColorBrush(Color.FromRgb(120, 125, 145)), Margin = new Thickness(9, 7, 0, 0), IsHitTestVisible = false, VerticalAlignment = VerticalAlignment.Top };
            var send = new Button { Content = "送る", FontWeight = FontWeights.SemiBold, Padding = new Thickness(16, 6, 16, 6), VerticalAlignment = VerticalAlignment.Bottom, IsEnabled = false, Margin = new Thickness(8, 0, 0, 0) }; send.SetResourceReference(StyleProperty, "PrimaryButton");
            other.TextChanged += (_, _) => { placeholder.Visibility = other.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed; send.IsEnabled = !sending && !string.IsNullOrWhiteSpace(other.Text); };
            send.Click += async (_, _) => { if (!string.IsNullOrWhiteSpace(other.Text)) await AnswerAsync(question.Id, null, other.Text); };
            DockPanel.SetDock(send, Dock.Right);
            var row = new DockPanel { Margin = new Thickness(0, 4, 0, 0) }; var field = new Grid(); field.Children.Add(other); field.Children.Add(placeholder);
            row.Children.Add(send); row.Children.Add(field);
            inputs.Add(other); Children.Add(row);
            SendOther = send; OtherInput = other;
        }
        else { SendOther = null; OtherInput = null; }
        if (errorLine.Children.Count == 0)
        {
            // Mac: the error line carries a warning icon.
            errorLine.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); errorLine.ColumnDefinitions.Add(new ColumnDefinition());
            errorLine.Children.Add(new TextBlock { Text = "\uE7BA", FontFamily = new FontFamily("Segoe Fluent Icons, Segoe MDL2 Assets"), FontSize = 14, Foreground = error.Foreground, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 8, 0) });
            Grid.SetColumn(error, 1); errorLine.Children.Add(error);
        }
        errorLine.Visibility = error.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        Children.Add(errorLine);
    }
    private static FrameworkElement ChoiceContent(int index, string option)
    {
        var row = new Grid(); row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); row.ColumnDefinitions.Add(new ColumnDefinition());
        var number = new Grid { Width = 20, Height = 20, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 1, 10, 0) };
        number.Children.Add(new System.Windows.Shapes.Ellipse { Fill = ChoiceViolet });
        if (index < 50) number.Children.Add(new TextBlock { Text = (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), FontSize = 11, FontWeight = FontWeights.Bold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(number);
        var text = new TextBlock { Text = option, FontSize = 15, FontWeight = FontWeights.Medium, TextWrapping = TextWrapping.Wrap, Foreground = ChoiceInk }; Grid.SetColumn(text, 1); row.Children.Add(text);
        return row;
    }
    private static readonly Brush ChoiceViolet = SecretCard.Frozen(Color.FromRgb(97, 71, 212)), ChoiceInk = SecretCard.Frozen(Color.FromRgb(33, 41, 61));
    // A template belongs to the thread that parsed it, so each card parses its own.
    private static ControlTemplate ChoiceTemplate() => (ControlTemplate)System.Windows.Markup.XamlReader.Parse(
        "<ControlTemplate xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\" xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\" TargetType=\"Button\"><Border x:Name=\"Chrome\" Background=\"#126147D4\" BorderBrush=\"#386147D4\" BorderThickness=\"1\" CornerRadius=\"12\" Padding=\"14,11\"><ContentPresenter/></Border>"
        + "<ControlTemplate.Triggers><Trigger Property=\"IsMouseOver\" Value=\"True\"><Setter TargetName=\"Chrome\" Property=\"Background\" Value=\"#206147D4\"/></Trigger><Trigger Property=\"IsEnabled\" Value=\"False\"><Setter TargetName=\"Chrome\" Property=\"Opacity\" Value=\"0.5\"/></Trigger></ControlTemplate.Triggers></ControlTemplate>");
    private Button? SendOther; private TextBox? OtherInput;
    private async Task AnswerAsync(string id, string? choice, string? text)
    {
        if (sending) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; if (SendOther is not null) SendOther.IsEnabled = false; error.Text = ""; errorLine.Visibility = Visibility.Collapsed;
        try { Update(await workspace.AnswerAsync(id, choice, text)); }
        catch (Exception exception) { error.Text = "操作の結果を確認できませんでした。現在の状態を更新して確認してください。\n" + exception.Message; errorLine.Visibility = Visibility.Visible; }
        finally { sending = false; foreach (var control in inputs) control.IsEnabled = true; if (SendOther is not null) SendOther.IsEnabled = !string.IsNullOrWhiteSpace(OtherInput?.Text); }
    }
}
