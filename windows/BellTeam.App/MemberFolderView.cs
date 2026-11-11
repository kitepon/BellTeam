using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using static BellTeam.App.SettingsUi;
using static BellTeam.App.EditorFormView;

namespace BellTeam.App;

// Member editor section 「端末とフォルダ」 (Mac MemberTerminalSection). It owns the two fields the save carries (TerminalId, ProjectRoot), draws them, and calls
// `edited` when the owner changed one. Every row exists once and is shown or hidden by the state, so no control is rebuilt under its own event.
internal sealed class MemberTerminalSection : IDisposable
{
    private const string Folder = "\uE8B7";
    private readonly TerminalsModel terminals;
    // The member answer carries terminalId (false = this BellTeam predates the member fields).
    private readonly bool memberFieldsAvailable;
    private readonly Func<string> memberName;
    private readonly Action edited;
    private readonly ComboBox picker = Popup("動かす場所", [], "");
    private readonly TextBlock calmText, failure = Text("", 14, Red), missing = Text("", 12, Orange), problem = Text("", 12, Red), folderValue;
    private readonly TextBox otherBox, directBox;
    private readonly TextBlock otherHint, directHint;
    private readonly Border loadingRow, calmRow, failedRow, retryRow, pickerRow, missingRow, folderRow, chooseRow, otherRow, directRow, problemRow, manageRow;
    private string pickerKey = "";
    private string? prefilled;
    private bool updating;
    public GroupCard Card { get; } = new();
    // Set by the editor from FormSection's footer (the text follows the choice).
    public TextBlock Footer { get; set; } = new();
    public string TerminalId { get; private set; }
    public string ProjectRoot { get; private set; }
    internal Expander OtherWays { get; }
    internal ComboBox Picker => picker;
    internal TextBox TypedPath => otherBox;
    internal TextBox DirectPath => directBox;

    public MemberTerminalSection(TerminalsModel terminals, bool memberFieldsAvailable, string terminalId, string projectRoot, Func<string> memberName, Action edited, Action choose)
    {
        this.terminals = terminals; this.memberFieldsAvailable = memberFieldsAvailable; this.memberName = memberName; this.edited = edited; TerminalId = terminalId; ProjectRoot = projectRoot;
        loadingRow = Row(Text("端末の一覧を読み込んでいます…", 13, Secondary));
        var calm = (Grid)TerminalParts.Calm(""); calmText = (TextBlock)calm.Children[1]; calmRow = Row(calm);
        failedRow = Row(failure); retryRow = Row(LinkButton("もう一度読み込む", () => _ = terminals.RefreshAsync()));
        pickerRow = Labeled("動かす場所", picker);
        picker.SelectionChanged += (_, _) => Picked();
        missingRow = Row(missing);
        var value = LabeledRow("フォルダ", ""); folderValue = (TextBlock)value.Children[1]; folderRow = Row(value);
        System.Windows.Automation.AutomationProperties.SetName(folderValue, "フォルダ");
        chooseRow = Row(TerminalParts.IconRow(Folder, "フォルダを選ぶ", Violet, choose));
        // The typed path: inside 「ほかの方法」 once the picker exists, straight under the terminal on a BellTeam without the folders route.
        var other = PathRow("パスを入力"); (otherBox, otherHint) = (other.Box, other.Hint);
        OtherWays = TerminalParts.Disclosure("ほかの方法", other.Line, false, _ => { }); otherRow = Row(OtherWays);
        var direct = PathRow("フォルダ"); (directBox, directHint) = (direct.Box, direct.Hint); directRow = Row(direct.Line);
        problemRow = Row(problem);
        // Mac 「端末を管理」 pushes the terminal list; this editor is its own window, so the main window opens 設定 > 端末 and comes forward.
        manageRow = Row(TerminalParts.IconRow("", "端末を管理", Violet, () => { if (Application.Current.MainWindow is MainWindow main) { main.ShowSettings(SettingsPage.Terminals); if (main.WindowState == WindowState.Minimized) main.WindowState = WindowState.Normal; main.Activate(); } }));
        foreach (var row in new[] { loadingRow, calmRow, failedRow, retryRow, pickerRow, missingRow, folderRow, chooseRow, otherRow, directRow, problemRow, manageRow }) Card.Add(row);
        otherBox.TextChanged += (_, _) => Typed(otherBox, directBox); directBox.TextChanged += (_, _) => Typed(directBox, otherBox);
        terminals.Changed += Render; Render();
    }
    public void Dispose() => terminals.Changed -= Render;

    // The terminal list was read (200) and the member answer has the fields: only then do terminalId and projectRoot travel.
    public bool BindingAvailable => terminals.State == TerminalListState.Supported && memberFieldsAvailable;
    public string Os => terminals.Find(TerminalId)?.Os ?? TerminalOS.Macos;
    private bool SavedMissing => TerminalId.Length != 0 && terminals.Find(TerminalId) is null;

    private (UIElement Line, TextBox Box, TextBlock Hint) PathRow(string label)
    {
        var (field, box) = Field(label, ""); box.TextAlignment = TextAlignment.Right;
        var hint = (TextBlock)field.Children[1]; hint.HorizontalAlignment = HorizontalAlignment.Right;
        var line = new Grid(); line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) }); line.ColumnDefinitions.Add(new ColumnDefinition());
        var caption = Text(label, 13); caption.VerticalAlignment = VerticalAlignment.Center; line.Children.Add(caption); Grid.SetColumn(field, 1); line.Children.Add(field);
        return (line, box, hint);
    }

    // The owner chose another place to run. This BellTeam clears the folder; a terminal fills it in the terminal's own form.
    private void Picked()
    {
        if (updating || picker.SelectedValue is not string next || next == TerminalId) return;
        TerminalId = next;
        if (next.Length == 0) { SetRoot(""); prefilled = null; }
        ApplyPrefill(); edited(); Render();
    }
    private void Typed(TextBox from, TextBox other)
    {
        if (updating) return;
        ProjectRoot = from.Text; updating = true; other.Text = from.Text; updating = false;
        Render(); edited();
    }
    // The folder is read-only text; the picker and the typed fields write it.
    public void SetRoot(string path)
    {
        ProjectRoot = path; updating = true; otherBox.Text = path; directBox.Text = path; updating = false;
        Render();
    }
    // The owner picked it in the folder picker: like a typed value, it is never prefilled over.
    public void Chosen(string path) { SetRoot(path); edited(); }
    // Mac applyPrefill: on a terminal or name change, an empty field (or one still holding the last prefill) gets the terminal's default folder.
    private void ApplyPrefill()
    {
        if (TerminalId.Length == 0 || terminals.Find(TerminalId) is not { User.Length: > 0 } terminal) return;
        if (MemberFolder.Prefill(ProjectRoot, prefilled, terminal.User, memberName(), terminal.Os) is not { } next) return;
        SetRoot(next); prefilled = next;
    }
    public void NameChanged() => ApplyPrefill();

    private void Show(Border row, bool shown) => Card.SetVisible(row, shown);
    public void Render()
    {
        var state = terminals.State; var usable = BindingAvailable; var bound = usable && TerminalId.Length != 0; var typedOnly = terminals.FoldersUnsupported;
        Show(loadingRow, state == TerminalListState.NotLoaded);
        calmText.Text = state == TerminalListState.Unsupported ? "このBellTeamはまだ端末の登録に対応していません" : "このBellTeamはまだメンバーの端末設定に対応していません";
        Show(calmRow, state == TerminalListState.Unsupported || state == TerminalListState.Supported && !memberFieldsAvailable);
        failure.Text = terminals.FailedMessage ?? ""; Show(failedRow, state == TerminalListState.Failed); Show(retryRow, state == TerminalListState.Failed);
        Show(pickerRow, usable); RefreshPicker();
        Show(missingRow, usable && SavedMissing); missing.Text = $"保存されている端末「{TerminalId}」は登録にありません。別の端末を選ぶか、端末を登録し直してください。";
        Show(folderRow, bound && !typedOnly); Show(chooseRow, bound && !typedOnly); Show(otherRow, bound && !typedOnly); Show(directRow, bound && typedOnly);
        folderValue.Text = ProjectRoot.Length == 0 ? "未選択" : ProjectRoot; folderValue.Foreground = ProjectRoot.Length == 0 ? Secondary : Ink;
        var example = Os == TerminalOS.Windows ? @"C:\Users\kite\work\app" : "/Users/kite/work/app"; otherHint.Text = example; directHint.Text = example;
        var wrong = bound && ProjectRoot.Length != 0 ? MemberBinding.Problem(TerminalId, ProjectRoot, Os) : null;
        problem.Text = wrong ?? ""; Show(problemRow, wrong is not null); Show(manageRow, usable);
        Footer.Visibility = usable ? Visibility.Visible : Visibility.Collapsed;
        Footer.Text = TerminalId.Length == 0 ? "このBellTeamの中で動きます（これまでどおり）。" : "選んだ端末の、このフォルダで席が起動します。フォルダは端末の上の絶対パスです。そこにBellTeamのファイルは作りません。";
    }

    // The choices change only when the list does; the combo is never rebuilt under its own SelectionChanged.
    private void RefreshPicker()
    {
        var options = new List<FormOption> { new("", "このBellTeam") };
        options.AddRange(terminals.Terminals.Select(terminal => new FormOption(terminal.TerminalId, $"{terminal.TerminalId}（{terminal.Host}）")));
        if (SavedMissing) options.Add(new(TerminalId, $"{TerminalId}（登録が見つかりません）"));
        var key = string.Join("|", options.Select(option => option.Id + option.Label));
        updating = true;
        if (key != pickerKey) { pickerKey = key; picker.ItemsSource = options.ToArray(); }
        picker.SelectedValue = TerminalId; updating = false;
    }
}

// S6: pick a folder of the terminal on screen (Mac TerminalFolderPickerSheet). It opens at the terminal user's home and only ever reads; the new-folder row is the one write.
internal sealed class FolderPickerView : Border
{
    private const string Up = "\uE74A", Choose = "\uE930", Folder = "\uE8B7", NewFolder = "\uE8F4", Chevron = "\uE76C";
    private static readonly FontFamily Mono = new("Consolas, Yu Gothic UI");
    private readonly TerminalFolderPickerModel model;
    private readonly Action<string> choose;
    private readonly StackPanel body = new() { Margin = new Thickness(20, 4, 20, 28) };
    public TerminalFolderPickerModel Model => model;
    public Button CloseButton { get; }

    public FolderPickerView(TerminalFolderPickerModel model, Action<string> choose, Action close)
    {
        this.model = model; this.choose = choose;
        // The Mac sheet: a 閉じる pill at the left of the title.
        CloseButton = new Button { Content = "閉じる", HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
        CloseButton.SetResourceReference(StyleProperty, "SheetPillButton"); System.Windows.Automation.AutomationProperties.SetName(CloseButton, "閉じる"); CloseButton.Click += (_, _) => close();
        var title = Text("フォルダを選ぶ", 15, Ink, FontWeights.SemiBold); title.HorizontalAlignment = HorizontalAlignment.Center; title.VerticalAlignment = VerticalAlignment.Center;
        var header = new Grid { Height = 52, Background = SettingsUi.Canvas }; header.Children.Add(CloseButton); header.Children.Add(title);
        var dock = new DockPanel();
        DockPanel.SetDock(header, Dock.Top); dock.Children.Add(header);
        var line = new Border { Height = 1, Background = Hairline }; DockPanel.SetDock(line, Dock.Top); dock.Children.Add(line);
        dock.Children.Add(new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
        Child = dock; Width = 560; MinHeight = 360; MaxHeight = 680; Margin = new Thickness(24); Background = SettingsUi.Canvas; CornerRadius = new CornerRadius(14); ClipToBounds = true;
        HorizontalAlignment = HorizontalAlignment.Center; VerticalAlignment = VerticalAlignment.Center;
        Effect = new System.Windows.Media.Effects.DropShadowEffect { Opacity = .25, BlurRadius = 30, ShadowDepth = 8, Direction = 270 };
        System.Windows.Automation.AutomationProperties.SetName(this, "フォルダを選ぶ");
        model.Changed += Render; Render();
    }
    public void Detach() => model.Changed -= Render;

    private void Render()
    {
        body.Children.Clear();
        switch (model.Content)
        {
            case FolderContent.Loading: body.Children.Add(FormSection(null, new GroupCard(Row(Text("読み込んでいます…", 13, Secondary))))); break;
            case FolderContent.Unsupported: body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.Calm(TerminalFolderPicker.UnsupportedText))))); break;
            case FolderContent.Failed: body.Children.Add(FormSection(null, Retry(model.FailedText ?? TerminalFolderPicker.ReadFailedText))); break;
            default: Listed(model.Listed!); break;
        }
    }

    private GroupCard Retry(string text) => new(Row(Text(text, 14, Red)), Row(LinkButton("もう一度", () => _ = model.ReloadAsync())));

    private void Listed(TerminalFolders folders)
    {
        var path = folders.Path ?? model.Requested;
        var here = new GroupCard(); var current = Text(path ?? "ホーム", 12); current.FontFamily = Mono; here.Add(Row(current));
        if (folders.Parent is { } parent) here.Add(Row(TerminalParts.IconRow(Up, "上へ", Violet, () => _ = model.OpenAsync(parent))));
        body.Children.Add(FormSection("いまの場所", here));
        if (folders.Reason is { } reason) { body.Children.Add(FormSection(null, Retry(TerminalFolderPicker.Sentence(reason, folders.Action, model.Os)))); return; }
        if (path is null) return;
        body.Children.Add(FormSection(null, new GroupCard(Row(TerminalParts.IconRow(Choose, "このフォルダにする", Violet, () => choose(path))))));
        var list = new GroupCard();
        var entries = folders.Entries ?? [];
        if (entries.Length == 0) list.Add(Row(Text(TerminalFolderPicker.EmptyText, 13, Secondary)));
        foreach (var entry in entries) list.Add(EntryRow(entry));
        if (folders.Truncated == true) list.Add(Row(Text(TerminalFolderPicker.TruncatedText, 12, Secondary)));
        body.Children.Add(FormSection("フォルダ", list));
        var (field, box) = Field("フォルダ名", model.NewName); box.TextChanged += (_, _) => model.NewName = box.Text;
        var form = new GroupCard(Row(field), Row(TerminalParts.IconRow(NewFolder, "作る", Violet, model.Creating ? null : () => _ = model.CreateFolderAsync())));
        if (model.CreateNote is { } note) form.Add(Row(Text(note, 12, Red)));
        body.Children.Add(FormSection("新しいフォルダ", form));
    }

    private UIElement EntryRow(TerminalFolderEntry entry)
    {
        var grid = new Grid(); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) }); grid.ColumnDefinitions.Add(new ColumnDefinition()); grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(Glyph(Folder, 14, Violet));
        var name = Text(entry.Name, 14, Violet); name.VerticalAlignment = VerticalAlignment.Center; Grid.SetColumn(name, 1); grid.Children.Add(name);
        var chevron = Glyph(Chevron, 12, Secondary); Grid.SetColumn(chevron, 2); grid.Children.Add(chevron);
        return TerminalParts.Clickable(grid, entry.Name, () => _ = model.OpenAsync(entry.Path));
    }
}
