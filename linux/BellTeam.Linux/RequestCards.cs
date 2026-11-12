using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using BellTeam.Core;

namespace BellTeam.Linux;

// Mac SecretRequestCard / OwnerQuestionCard: a white card with a violet title line; the parts are spaced 12 apart.
public sealed class SecretCard(LinuxWorkspace workspace, string author) : StackPanel
{
    private SecretRequest? current;
    private string currentAuthor = author;
    public void Update(SecretRequest request) => Update(request, currentAuthor);
    public void Update(SecretRequest request, string sender)
    {
        if (current == request && currentAuthor == sender) return;
        current = request; currentAuthor = sender; Children.Clear();
        Children.Add(CardTitle(Icons.Lock, currentAuthor + " · 秘密情報の入力"));
        Children.Add(CardBody(request.Message));
        Children.Add(CardText(request.Label + " / " + request.ToolId, size: 14, muted: true));
        if (request.Status == "pending")
        {
            var open = MacUi.Bordered("安全な入力欄を開く", () => Open(request)); open.Margin = new Thickness(0, 12, 0, 0);
            Children.Add(open);
        }
        else if (request.Status == "submitted") Children.Add(CardStatus(Icons.Check, "登録済み"));
        else if (request.Status == "cancelled") Children.Add(CardStatus(Icons.Close, "入力を取り消しました"));
        else Children.Add(CardText("不明な入力状態: " + request.Status, error: true));
        if (request.Notification == "failed") Children.Add(CardText("AIへの通知に失敗しました。チャットで完了を知らせてください。", size: 14, error: true));
    }
    internal SecretInputWindow CreateInput(SecretRequest request) => new(request, submission => workspace.FinishSecretAsync(request.Id, submission), () => workspace.SecretKeysAsync(request.Id), Update);
    private void Open(SecretRequest request)
    {
        var input = CreateInput(request);
        if (TopLevel.GetTopLevel(this) is Window owner) _ = input.ShowDialog(owner); else input.Show();
    }
    internal static Control CardTitle(string icon, string text)
    {
        var title = new TextBlock { Text = text, FontSize = 15, FontWeight = FontWeight.SemiBold, Foreground = BellTheme.Violet, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
        var mark = Icons.Draw(icon, 15, BellTheme.Violet, thickness: 2); mark.Margin = new Thickness(0, 0, 8, 0);
        return new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12), Children = { mark, title } };
    }
    internal static Control CardStatus(string icon, string text, bool strong = false)
    {
        var brush = strong ? BellTheme.Violet : BellTheme.Ink;
        var mark = Icons.Draw(icon, 15, brush, thickness: 2); mark.Margin = new Thickness(0, 0, 8, 0);
        return new StackPanel
        {
            Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0),
            Children = { mark, new TextBlock { Text = text, FontSize = 15, FontWeight = strong ? FontWeight.SemiBold : FontWeight.Normal, Foreground = brush, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap } }
        };
    }
    internal static TextBlock CardText(string text, bool bold = false, bool error = false, double size = 16, bool muted = false)
        => BellTheme.Text(text, size, error ? BellTheme.Red : muted ? BellTheme.Muted : BellTheme.Ink, bold ? FontWeight.SemiBold : FontWeight.Normal, new Thickness(0, 12, 0, 0));
    internal static TextBox CardBody(string text) => new() { Classes = { "bare" }, Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontSize = 18, Foreground = BellTheme.Ink, BorderThickness = default, Background = Brushes.Transparent, Padding = default };
}

// A selectable row of a grouped list: the content on the left and a violet check on the right when chosen (Mac checkmark rows).
internal sealed class ChoiceRow : RadioButton
{
    private readonly ContentControl body = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly Control mark = Icons.Draw(Icons.Check, 18, BellTheme.Violet, thickness: 2);
    public ChoiceRow()
    {
        FontSize = 16; Foreground = BellTheme.Ink; Cursor = new Cursor(StandardCursorType.Hand); HorizontalAlignment = HorizontalAlignment.Stretch; HorizontalContentAlignment = HorizontalAlignment.Stretch; mark.IsVisible = false; mark.HorizontalAlignment = HorizontalAlignment.Right;
        Template = new FuncControlTemplate<ChoiceRow>((_, _) => new Border { Background = Brushes.Transparent, Padding = new Thickness(20, 11), Child = new Grid { Children = { body, mark } } });
    }
    protected override Type StyleKeyOverride => typeof(RadioButton);
    public Control? Caption { set => body.Content = value; }
    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == IsCheckedProperty) mark.IsVisible = IsChecked == true;
    }
}

// A plain text row of a grouped list (Mac Form Button): a coloured label that goes grey when disabled.
internal sealed class RowButton : Button
{
    private readonly TextBlock label = new() { FontSize = 16, VerticalAlignment = VerticalAlignment.Center };
    private readonly IBrush color;
    public RowButton(string text, IBrush color)
    {
        this.color = color; label.Text = text; Cursor = new Cursor(StandardCursorType.Hand); HorizontalContentAlignment = HorizontalAlignment.Stretch; HorizontalAlignment = HorizontalAlignment.Stretch;
        Template = new FuncControlTemplate<RowButton>((_, _) => new Border { Background = Brushes.Transparent, Padding = new Thickness(20, 12), Child = label });
        Sync();
    }
    protected override Type StyleKeyOverride => typeof(Button);
    public string Label { get => label.Text ?? ""; set { label.Text = value; AutomationProperties.SetName(this, value); } }
    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change) { base.OnPropertyChanged(change); if (change.Property == IsEnabledProperty) Sync(); }
    // Mac Form button: a greyed label when it cannot be used (the control's own disabled fade stays off).
    private void Sync() => label.Foreground = IsEnabled ? color : FormKit.DisabledGrey;
}

// Mac SecretInputSheet: a grouped form. The message and the note, the input method, the field or the 1Password list, then the buttons.
// All the parts exist from the start and only their visibility changes, so focus and typing survive a change of method.
public sealed class SecretInputWindow : Window
{
    private readonly SecretInputModel model;
    private readonly Func<SecretSubmission?, Task<SecretRequest>> finish;
    private readonly Func<Task<OnePasswordKey[]?>> loadKeys;
    private readonly Action<SecretRequest> completed;
    internal TextBox Input { get; } = new() { Classes = { "bare" }, PasswordChar = '●', FontSize = 16, Foreground = BellTheme.Ink, VerticalAlignment = VerticalAlignment.Center };
    internal TextBox Paste { get; }
    internal TextBox Reference { get; }
    internal TextBox Search { get; }
    internal TextBlock ErrorText { get; } = FormKit.Text("", 14, BellTheme.Red);
    internal Task KeysReady { get; private set; } = Task.CompletedTask;
    private readonly TextBlock note = FormKit.Text("", 14, BellTheme.Secondary), unsupported = FormKit.Text("", 14, BellTheme.Secondary), pickerStatus = FormKit.Text("", 16, BellTheme.Muted), count = FormKit.Text("", 14, BellTheme.Secondary);
    private readonly Control unsupportedRow, errorRow;
    private readonly FormGroup top, buttons;
    private readonly Control statusRow, searchRow, countRow, retryRow, choices;
    private readonly Border pickerCard, referenceCard, pasteCard, passwordCard;
    private readonly ChoiceRow onePasswordChoice = new(), inputChoice = new();
    private readonly StackPanel keysHost = new();
    private readonly RowButton submit = new("", BellTheme.Violet), decline = new("入力を断る", BellTheme.Red);
    private readonly Button close;
    private bool sending, syncing;

    // The signature of the Windows window; SecretInputWindow.ShowAsync opens it modally over an owner.
    public SecretInputWindow(SecretRequest request, Func<SecretSubmission?, Task<SecretRequest>> finish, Func<Task<OnePasswordKey[]?>> loadKeys, Action<SecretRequest> completed)
    {
        this.finish = finish; this.loadKeys = loadKeys; this.completed = completed; model = new SecretInputModel(request);
        Title = request.Label; Width = 720; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.CenterOwner; Background = FormKit.Canvas;
        Opened += (_, _) => { if (Screens.ScreenFromWindow(this) is { } screen) MaxHeight = screen.WorkingArea.Height / screen.Scaling; };
        Search = BigField("名前や保管庫で絞り込む");
        Reference = BigField("op://保管庫/アイテム/フィールド");
        // The Mac TextEditor has no hint; the box keeps its own name for screen readers.
        Paste = FormKit.Field("", "", multiline: true, minHeight: 120, fontSize: 16); Paste.FontFamily = BellTheme.Mono; AutomationProperties.SetName(Paste, request.Label);
        // The Mac SecureField: the label is the hint.
        Input.PlaceholderText = request.Label; Input.PlaceholderForeground = BellTheme.Secondary; AutomationProperties.SetName(Input, request.Label);
        Input.OnText(() => UpdateButtons());
        Paste.OnText(() => UpdateButtons());
        Reference.OnText(() => { model.Reference = Reference.Text ?? ""; UpdateButtons(); });
        Search.OnText(() => { model.SetSearch(Search.Text ?? ""); RefreshKeys(); UpdateButtons(); });

        var message = request.Message.Length == 0 || request.IsLoginPassword ? null : SecretCard.CardBody(request.Message); // a login card shows the message as its note (purpose, not wording)
        top = new FormGroup(); if (message is not null) top.Add(FormKit.Row(message, 50)); top.Add(FormKit.Row(note, 46));
        unsupportedRow = FormKit.Row(unsupported); top.Add(unsupportedRow);
        onePasswordChoice.GroupName = inputChoice.GroupName = "source";
        onePasswordChoice.IsCheckedChanged += (_, _) => { if (onePasswordChoice.IsChecked == true) ChooseSource(true); }; inputChoice.IsCheckedChanged += (_, _) => { if (inputChoice.IsChecked == true) ChooseSource(false); };
        choices = FormKit.Section("入力方法", new FormGroup(onePasswordChoice, inputChoice));

        statusRow = FormKit.Row(pickerStatus); searchRow = FormKit.Row(Search);
        retryRow = Divided(FormKit.Row(FormKit.LinkButton("もう一度読み込む", () => KeysReady = LoadKeysAsync()))); countRow = Divided(FormKit.Row(count));
        pickerCard = Card(statusRow, retryRow, searchRow, countRow, keysHost); referenceCard = Card(FormKit.Row(Reference)); pasteCard = Card(FormKit.Row(Paste)); passwordCard = Card(FormKit.Row(Input));
        var value = new StackPanel { Children = { pickerCard, referenceCard, pasteCard, passwordCard } };

        errorRow = FormKit.Row(ErrorText);
        submit.Click += async (_, _) => await SubmitAsync(true); decline.Click += async (_, _) => await SubmitAsync(false);
        buttons = new FormGroup(submit, decline, errorRow);
        var form = new StackPanel { Margin = new Thickness(20, 4, 20, 28), Children = { top, choices, FormKit.Section(request.Label, value), FormKit.Section(null, buttons) } };

        close = new Button
        {
            Classes = { "plain" }, Content = "閉じる", Padding = new Thickness(16, 7), CornerRadius = new CornerRadius(99), FontWeight = FontWeight.Normal, Foreground = BellTheme.Ink, Background = new SolidColorBrush(Color.Parse("#80FFFFFF")),
            BorderBrush = new SolidColorBrush(Color.Parse("#C9C4DE")), BorderThickness = new Thickness(1), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0)
        };
        AutomationProperties.SetName(close, "閉じる"); close.Click += (_, _) => Close();
        var heading = FormKit.Text(request.Label, 15, BellTheme.Ink, FontWeight.SemiBold); heading.HorizontalAlignment = HorizontalAlignment.Center; heading.VerticalAlignment = VerticalAlignment.Center;
        var header = new Grid { Height = 52, Children = { heading, close } }; DockPanel.SetDock(header, Dock.Top);
        Content = new DockPanel { Children = { header, new ScrollViewer { Content = form, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled } } };

        Deactivated += (_, _) => ClearFields();
        Closed += (_, _) => ClearFields();
        Closing += (_, args) => { if (sending) args.Cancel = true; };
        Refresh();
        if (model.Picker) KeysReady = LoadKeysAsync();
    }

    // Opens the input over its owner and returns when it closes (Windows ShowDialog).
    public static Task ShowAsync(Window owner, SecretRequest request, Func<SecretSubmission?, Task<SecretRequest>> finish, Func<Task<OnePasswordKey[]?>> loadKeys, Action<SecretRequest> completed)
        => new SecretInputWindow(request, finish, loadKeys, completed).ShowDialog(owner);

    private static StackPanel Divided(Control row) => new() { Children = { Divider(), row } };
    private static Border Divider() => new() { Height = 1, Background = FormKit.Hairline, Margin = new Thickness(20, 0, 0, 0) };
    // The Mac Form field at body size.
    private static TextBox BigField(string hint) => FormKit.Field(hint, "", fontSize: 16);
    private static Border Card(params Control[] rows) { var stack = new StackPanel(); foreach (var row in rows) stack.Children.Add(row); return new Border { Child = stack, Background = Brushes.White, CornerRadius = new CornerRadius(10) }; }

    // The value as typed: a pasted key keeps its newlines and nothing is trimmed.
    internal string Value => (model.Multiline ? Paste.Text : Input.Text) ?? "";
    private void ClearFields()
    {
        Input.Text = ""; Paste.Text = ""; Reference.Text = ""; model.Reference = "";
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
        choices.IsVisible = model.ChoicesShown;
        onePasswordChoice.Caption = new TextBlock { Text = model.OnePasswordChoice, FontSize = 16 }; inputChoice.Caption = new TextBlock { Text = model.InputChoice, FontSize = 16 };
        AutomationProperties.SetName(onePasswordChoice, model.OnePasswordChoice); AutomationProperties.SetName(inputChoice, model.InputChoice);
        onePasswordChoice.IsChecked = model.UseOnePassword; inputChoice.IsChecked = !model.UseOnePassword;
        syncing = false;
        pickerCard.IsVisible = model.UseOnePassword && model.Picker;
        referenceCard.IsVisible = model.UseOnePassword && !model.Picker;
        pasteCard.IsVisible = !model.UseOnePassword && model.Multiline;
        passwordCard.IsVisible = !model.UseOnePassword && !model.Multiline;
        var list = model.Keys;
        statusRow.IsVisible = !(list == KeyListState.Loaded && model.HasKeys);
        pickerStatus.Text = list switch { KeyListState.Loading => model.LoadingLine, KeyListState.Failed => model.FailedLine, _ => model.EmptyLine };
        pickerStatus.Foreground = list == KeyListState.Failed ? BellTheme.Red : BellTheme.Muted;
        retryRow.IsVisible = list == KeyListState.Failed;
        searchRow.IsVisible = countRow.IsVisible = keysHost.IsVisible = model.HasKeys;
        RefreshKeys(); UpdateButtons();
    }
    private void RefreshKeys()
    {
        keysHost.Children.Clear();
        if (!model.HasKeys) return;
        count.Text = model.CountLine;
        foreach (var key in model.Shown)
        {
            var content = new StackPanel { Children = { new TextBlock { Text = key.Title, FontSize = 16 } } };
            if (!string.IsNullOrEmpty(key.Vault)) content.Children.Add(FormKit.Text(key.Vault, 13, BellTheme.Secondary, margin: new Thickness(0, 2, 0, 0)));
            var choice = new ChoiceRow { GroupName = "keys", Caption = content, IsChecked = model.Reference == key.Reference };
            AutomationProperties.SetName(choice, key.Title + (string.IsNullOrEmpty(key.Vault) ? "" : "（" + key.Vault + "）"));
            choice.IsCheckedChanged += (_, _) => { if (choice.IsChecked != true) return; model.Reference = key.Reference; UpdateButtons(); };
            keysHost.Children.Add(new StackPanel { Children = { Divider(), choice } });
        }
    }
    private void UpdateButtons()
    {
        submit.Label = model.SubmitLabel;
        submit.IsEnabled = !sending && model.Ready(Value); decline.IsEnabled = !sending;
        buttons.SetVisible(errorRow, (ErrorText.Text ?? "").Length != 0);
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
        foreach (var field in new Control[] { Input, Paste, Reference, Search, inputChoice, onePasswordChoice, keysHost }) field.IsEnabled = false;
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
            foreach (var field in new Control[] { Input, Paste, Reference, Search, inputChoice, onePasswordChoice, keysHost }) field.IsEnabled = true;
            UpdateButtons();
        }
        completed(result); Close();
    }

    // Render seam: the text typed into the search box.
    internal void SearchForRender(string text) => Search.Text = text;

    // A selectable row of a grouped list (used by the terminal editor's owner choice too).
    internal static RadioButton ChoiceButton() => new ChoiceRow();
}

public sealed class QuestionCard(LinuxWorkspace workspace, string author) : StackPanel
{
    private OwnerQuestion? current;
    private string currentAuthor = author;
    private bool sending;
    private readonly List<Control> inputs = [];
    private readonly TextBlock error = SecretCard.CardText("", size: 14, error: true);
    private TextBlock? title;
    private Button? sendOther;
    private TextBox? otherInput;
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
        var header = (StackPanel)SecretCard.CardTitle(RequestIcons.List, currentAuthor + " · 選んでほしいこと"); title = (TextBlock)header.Children[1];
        Children.Add(header);
        Children.Add(SecretCard.CardBody(question.Question));
        if (question.Status == "answered") { Children.Add(SecretCard.CardStatus(Icons.Check, "回答: " + question.Answer, strong: true)); return; }
        if (question.Status != "open") { Children.Add(SecretCard.CardText("不明な回答状態: " + question.Status, error: true)); return; }
        var choices = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        foreach (var option in question.Options)
        {
            var button = MacUi.Bordered(option, () => _ = AnswerAsync(question.Id, option, null)); button.IsEnabled = !sending; button.Margin = new Thickness(0, 0, 8, 8);
            choices.Children.Add(button); inputs.Add(button);
        }
        Children.Add(choices);
        if (question.AllowOther)
        {
            var other = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxHeight = 110, IsEnabled = !sending, FontSize = 14, Padding = new Thickness(8, 6), PlaceholderText = "その他（文章で答える）", PlaceholderForeground = BellTheme.Muted, Background = Brushes.White, BorderBrush = BellTheme.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8) };
            ScrollViewer.SetVerticalScrollBarVisibility(other, ScrollBarVisibility.Auto);
            var send = MacUi.Bordered("送る", () => { if (!string.IsNullOrWhiteSpace(other.Text)) _ = AnswerAsync(question.Id, null, other.Text); }); send.VerticalAlignment = VerticalAlignment.Bottom; send.IsEnabled = false; send.Margin = new Thickness(8, 0, 0, 0);
            other.OnText(() => send.IsEnabled = !sending && !string.IsNullOrWhiteSpace(other.Text));
            DockPanel.SetDock(send, Dock.Right);
            var row = new DockPanel { Margin = new Thickness(0, 4, 0, 0), Children = { send, other } };
            inputs.Add(other); Children.Add(row);
            sendOther = send; otherInput = other;
        }
        else { sendOther = null; otherInput = null; }
        error.IsVisible = (error.Text ?? "").Length != 0;
        Children.Add(error);
    }
    private async Task AnswerAsync(string id, string? choice, string? text)
    {
        if (sending) return;
        sending = true; foreach (var control in inputs) control.IsEnabled = false; if (sendOther is not null) sendOther.IsEnabled = false; error.Text = ""; error.IsVisible = false;
        try { Update(await workspace.AnswerAsync(id, choice, text)); }
        catch (Exception exception) { error.Text = "操作の結果を確認できませんでした。現在の状態を更新して確認してください。\n" + exception.Message; error.IsVisible = true; }
        finally { sending = false; foreach (var control in inputs) control.IsEnabled = true; if (sendOther is not null) sendOther.IsEnabled = !string.IsNullOrWhiteSpace(otherInput?.Text); }
    }
}
