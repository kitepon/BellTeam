using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using BellTeam.Core;
using Microsoft.Win32;
using static BellTeam.App.SettingsUi;
using static BellTeam.App.EditorFormView;

namespace BellTeam.App;

// Mac BotEditor's AI section: CLI, モデル (CLIの既定 / the catalog / その他 with a モデルID), エフォート, and the ファストモード switch with its reason.
public sealed class ModelPicker : Border
{
    private const string Custom = "__custom__";
    private readonly ModelSelection selection;
    private readonly GroupCard card = new();
    private readonly ComboBox harness, model, effort;
    private readonly TextBox custom;
    private readonly Border cliRow, modelRow, customRow, effortRow, loadingRow, reasonRow;
    private readonly CheckBox fast = new() { Content = "ファストモード", FontSize = 13, VerticalContentAlignment = VerticalAlignment.Center };
    private readonly TextBlock reason = Text("", 12, Red);
    private bool updating, loading = true;
    private string? loadError;
    public event Action? Edited;
    internal CheckBox FastToggle => fast;
    internal TextBlock FastReason => reason;
    public ModelPicker(BotSettings initial)
    {
        selection = new(initial.Harness, initial.Model, initial.ReasoningEffort);
        var harnesses = new List<FormOption> { new("codex", "Codex"), new("claude", "Claude"), new("grok", "Grok"), new("cursor", "Cursor"), new("antigravity", "Antigravity") };
        if (!harnesses.Any(option => option.Id == initial.Harness)) harnesses.Add(new(initial.Harness, initial.Harness + "（現在の設定）"));
        harness = Combo("CLI", harnesses); model = Combo("モデル", []); effort = Combo("エフォート", []);
        var customField = Field("モデルID", ""); custom = customField.Box; custom.CharacterCasing = CharacterCasing.Normal;
        var spinner = new StackPanel { Orientation = Orientation.Horizontal }; spinner.Children.Add(new Spinner { Width = 16, Height = 16, Stroke = Muted, Margin = new Thickness(0, 0, 8, 0) }); spinner.Children.Add(Text(EditorText.LoadingModels, 13, Secondary));
        cliRow = Labeled("CLI", harness); modelRow = Labeled("モデル", model); customRow = Row(customField.Element); effortRow = Labeled("エフォート", effort); loadingRow = Row(spinner);
        var fastRow = Row(fast); var noteRow = Row(Text(EditorText.FastModeNote, 12, Muted)); reasonRow = Row(reason);
        foreach (var row in new UIElement[] { loadingRow, cliRow, modelRow, customRow, effortRow, fastRow, noteRow, reasonRow }) card.Add(row);
        Child = card; CornerRadius = new CornerRadius(10); Background = Palette.Card;
        fast.IsChecked = initial.FastMode; System.Windows.Automation.AutomationProperties.SetName(fast, "ファストモード");
        fast.Checked += (_, _) => { RenderFast(); Edited?.Invoke(); }; fast.Unchecked += (_, _) => { RenderFast(); Edited?.Invoke(); };
        harness.SelectionChanged += (_, _) => { if (updating || harness.SelectedValue is not string id) return; selection.SelectHarness(id); Render(); Edited?.Invoke(); };
        model.SelectionChanged += (_, _) =>
        {
            if (updating || model.SelectedValue is not string id) return;
            selection.SelectModel(id == Custom ? custom.Text : id); RenderEffort(); ShowRows(); Edited?.Invoke();
        };
        custom.TextChanged += (_, _) => { if (updating || !CustomSelected) return; selection.SelectModel(custom.Text); RenderEffort(); Edited?.Invoke(); };
        effort.SelectionChanged += (_, _) => { if (updating || effort.SelectedValue is not string id) return; selection.Effort = id; Edited?.Invoke(); };
        Render();
    }
    private bool CustomSelected => model.SelectedValue as string == Custom;
    private static ComboBox Combo(string label, IEnumerable<FormOption> options) => Popup(label, options, null);
    public async Task LoadAsync(ManagementApi api, CancellationToken token)
    {
        try { selection.SetCatalog((await api.Api.GetAsync<ModelsResponse>("/api/models", token)).Models); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        catch (Exception exception) { loadError = exception.Message; }
        loading = false; Render();
    }
    private void ShowRows()
    {
        card.SetVisible(loadingRow, loading);
        foreach (var row in new[] { cliRow, modelRow, effortRow }) card.SetVisible(row, !loading);
        card.SetVisible(customRow, !loading && CustomSelected);
    }
    private void Render()
    {
        updating = true;
        harness.SelectedValue = selection.Harness;
        var catalog = selection.Catalog.GetValueOrDefault(selection.Harness);
        var options = new List<FormOption> { new("", "CLIの既定") };
        options.AddRange((catalog?.Models ?? []).Select(choice => new FormOption(choice.Id, choice.Id))); options.Add(new(Custom, "その他"));
        model.ItemsSource = options;
        var known = options.Any(option => option.Id == selection.Model);
        model.SelectedValue = known ? selection.Model : Custom;
        custom.Text = known ? "" : selection.Model;
        // Mac .disabled(catalog[harness]?.error != nil): a catalog that reported an error cannot be chosen from.
        model.IsEnabled = effort.IsEnabled = catalog?.Error is null;
        updating = false; ShowRows(); RenderEffort();
    }
    private void RenderEffort()
    {
        updating = true;
        var choices = new List<FormOption> { new("", "CLIの既定") };
        choices.AddRange(selection.Efforts.Where(value => value.Length != 0).Select(value => new FormOption(value, value)));
        if (selection.Effort.Length != 0 && !choices.Any(choice => choice.Id == selection.Effort)) choices.Add(new(selection.Effort, selection.Effort + "（現在の設定）"));
        effort.ItemsSource = choices; effort.SelectedValue = selection.Effort; updating = false;
        RenderFast();
    }
    // Mac fastModeUnavailableReason, in the Mac order: still loading, no catalog, an empty モデルID, then what the catalog says.
    private string? FastReasonText()
    {
        if (loading) return EditorText.FastLoading;
        if (!selection.Catalog.ContainsKey(selection.Harness)) return loadError ?? "モデル候補を読み込めませんでした。";
        if (CustomSelected && string.IsNullOrWhiteSpace(custom.Text)) return EditorText.FastCustomEmpty;
        return selection.FastUnavailableReason;
    }
    private void RenderFast()
    {
        var text = FastReasonText();
        fast.IsEnabled = fast.IsChecked == true || text is null;
        reason.Text = text ?? ""; reason.Visibility = text is null ? Visibility.Collapsed : Visibility.Visible; card.SetVisible(reasonRow, text is not null);
    }
    public void SetSavedFastMode(bool value) => fast.IsChecked = value;
    public BotSettings Apply(BotSettings settings)
    {
        if (CustomSelected && string.IsNullOrWhiteSpace(custom.Text)) throw new ArgumentException(EditorText.FastCustomEmpty);
        return settings with { Harness = selection.Harness, Model = selection.Model, ReasoningEffort = selection.Effort, FastMode = fast.IsChecked == true };
    }
}

// Mac BotEditor: メンバー, 画像 (new member only), AI, プロフィール, and 削除 (edit only), with the save-result lines at the end.
public sealed class MemberEditorView : EditorFormView
{
    private enum Outcome { Saved, Confirmed, Different, Unconfirmed }
    private static Brush Mint => Palette.Get("Mint");
    private readonly Workspace workspace;
    private readonly string? id;
    private BotSettings original = new() { Name = "", Harness = "codex" };
    private Dictionary<string, object?> submitted = [];
    private Outcome? outcome;
    private BotSettings? submittedSettings;
    private Exception? outcomeError;
    private string? errorText;
    private bool deletionUnconfirmed;
    private TextBox name = null!, position = null!, profile = null!, personality = null!, speech = null!, role = null!;
    private ComboBox color = null!;
    private ModelPicker models = null!;
    private AvatarPicker? avatar;
    private BotImageFields? small, large;
    private readonly GroupCard imageCard = new();
    private readonly StackPanel notices = new(), deleteHost = new();
    private readonly List<UIElement> lockable = [];
    private bool canEditImages;
    public Task ModelLoad { get; private set; } = Task.CompletedTask;
    // The large preview in the 画像 section has been decoded (the render waits for it).
    public Task ImagesReady { get; private set; } = Task.CompletedTask;
    public MemberEditorView(Workspace workspace, string? id) : base(workspace)
    {
        this.workspace = workspace; this.id = id;
        workspace.RosterChanged += RosterChanged;
    }
    public override void Dispose() { workspace.RosterChanged -= RosterChanged; base.Dispose(); }
    private bool DeletionPending => id is not null && workspace.BotDeletionPending(id);
    private bool Locked => DeletionPending || deletionUnconfirmed;
    private bool HasSavedResult => outcome is Outcome.Saved or Outcome.Confirmed;
    protected override bool SaveBlocked => Locked;
    public override string CloseLabel => HasSavedResult || Locked ? "閉じる" : "キャンセル";
    internal string NameText => name.Text;
    internal string? ErrorText => errorText;

    public async Task InitializeAsync()
    {
        var loading = Text("読み込んでいます…", 13, Secondary, null, new Thickness(20, 16, 0, 0)); Form.Children.Add(loading);
        try
        {
            var api = workspace.Management;
            if (id is not null) original = (await api.GetBotAsync(id, Token)).Bot;
            Token.ThrowIfCancellationRequested();
            Form.Children.Remove(loading); Build(api); Ready = true; Notify();
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { loading.Text = error.Message; loading.Foreground = Red; }
    }

    private void Build(ManagementApi api)
    {
        var edited = new Action(Edited);
        // メンバー
        var member = new GroupCard();
        var nameField = Field("名前", original.Name); name = nameField.Box; var positionField = Field("役職", original.Position); position = positionField.Box;
        color = Popup("テーマ色", [new("violet", "紫"), new("rose", "ローズ"), new("indigo", "インディゴ")], original.Color);
        if (id is null)
        {
            avatar = new AvatarPicker("", name: "", color: original.Color, changeLabel: "小画像を変更", keepSelection: true) { HorizontalAlignment = HorizontalAlignment.Center };
            avatar.Chosen += chosen => { small = chosen.Selection is { } selection ? BotImageFields.From(AvatarVariant.Small, selection) : small; Edited(); RenderImages(); };
            member.Add(Row(avatar, 0));
        }
        member.Add(Row(nameField.Element)); member.Add(Row(positionField.Element)); member.Add(Labeled("テーマ色", color));
        name.TextChanged += (_, _) => { avatar?.SetIdentity(name.Text, (string?)color.SelectedValue ?? "violet"); Edited(); }; position.TextChanged += (_, _) => Edited();
        color.SelectionChanged += (_, _) => { avatar?.SetIdentity(name.Text, (string?)color.SelectedValue ?? "violet"); Edited(); };
        Form.Children.Add(Section("メンバー", member));
        if (avatar is not null) InitialLoads.Add(avatar.LoadAsync());
        // 画像 (a new member only: an existing member's images are changed from the inspector)
        if (id is null) { canEditImages = workspace.Bots.Any(bot => bot.AvatarLargeVersion is not null); if (avatar is not null) avatar.IsEnabled = canEditImages; RenderImages(); Form.Children.Add(Section("画像", imageCard)); }
        // AI
        models = new ModelPicker(original); models.Edited += edited; ModelLoad = models.LoadAsync(api, Token); InitialLoads.Add(ModelLoad);
        Form.Children.Add(Section("AI", models));
        // プロフィール
        var profileCard = new GroupCard();
        var rows = new[] { Paragraph("背景・見た目・関係性", original.ProfileText), Paragraph("性格・考え方", original.Personality), Paragraph("口調", original.SpeechStyle), Paragraph("担当する仕事", original.Role) };
        foreach (var row in rows) { profileCard.Add(row.Row); row.Box.TextChanged += (_, _) => Edited(); }
        (profile, personality, speech, role) = (rows[0].Box, rows[1].Box, rows[2].Box, rows[3].Box);
        Form.Children.Add(Section("プロフィール", profileCard));
        Form.Children.Add(deleteHost); Form.Children.Add(notices);
        RenderDelete(); RenderNotices(); Lock();
    }
    private StackPanel Section(string header, UIElement group) { var section = FormSection(header, group); lockable.Add(section); return section; }

    // Mac .disabled(deletionPending || deletionResultUnconfirmed) on the メンバー, 画像, AI and プロフィール sections.
    private void Lock() { foreach (var section in lockable) section.IsEnabled = !Locked; Notify(); }
    // Mac onChange(of: settings): editing again drops the old save result and its 保存結果を確認 line.
    private void Edited() { if (outcome is null) return; outcome = null; submitted = []; RenderNotices(); Notify(); }
    private void RosterChanged()
    {
        if (id is null || IsClosing) return;
        if (!workspace.HasBot(id)) { Close(); return; }
        RenderDelete(); Lock();
    }

    // ---- 画像 ----
    private void RenderImages()
    {
        imageCard.Clear();
        if (!canEditImages) imageCard.Add(Row(Text(EditorText.ImagesNeedServerUpdate, 13, Secondary)));
        var smallRender = small?.Render ?? "";
        imageCard.Add(Row(LinkButton("小画像を再調整", () => _ = ReopenAsync(AvatarVariant.Small), smallRender.Length != 0 && canEditImages)));
        if (smallRender.Length != 0 && (small?.Source ?? "").Length == 0) imageCard.Add(Row(Text(EditorText.SmallNoSource, 13, Secondary)));
        var largeRender = large?.Render ?? "";
        var pick = new Button { Padding = new Thickness(0), Margin = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Left, IsEnabled = canEditImages }; pick.SetResourceReference(StyleProperty, "QuietButton");
        var content = new StackPanel(); var preview = new Border { Width = 160, Height = 160, CornerRadius = new CornerRadius(14), HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 8), Visibility = Visibility.Collapsed, ClipToBounds = true };
        content.Children.Add(preview); content.Children.Add(Text("大画像を変更", 13, Violet)); pick.Content = content; pick.Click += async (_, _) => await PickLargeAsync();
        System.Windows.Automation.AutomationProperties.SetName(pick, "大画像を変更");
        imageCard.Add(Row(pick));
        ImagesReady = ShowLargePreviewAsync(preview, largeRender.Length != 0 ? largeRender : smallRender);
        imageCard.Add(Row(LinkButton("大画像を再調整", () => _ = ReopenAsync(AvatarVariant.Large), largeRender.Length != 0 && canEditImages)));
        if (largeRender.Length != 0)
        {
            if ((large?.Source ?? "").Length == 0) imageCard.Add(Row(Text(EditorText.LargeNoSource, 13, Secondary)));
            imageCard.Add(Row(LinkButton("大画像を小画像と同じに戻す", () => { large = BotImageFields.Cleared(AvatarVariant.Large); Edited(); RenderImages(); }, canEditImages)));
        }
    }
    // Mac AvatarPortraitCache.image(for:): the picture shown above 大画像を変更 is the large image, or the small one standing in for it.
    private static async Task ShowLargePreviewAsync(Border preview, string dataUrl)
    {
        if (dataUrl.Length == 0) return;
        try { var bitmap = await AvatarHost.DecodeAsync(dataUrl); preview.Background = new ImageBrush(bitmap) { Stretch = Stretch.UniformToFill }; preview.Visibility = Visibility.Visible; }
        catch (Exception) { /* the picture is a courtesy; the buttons below still work */ }
    }
    private async Task PickLargeAsync()
    {
        var file = new OpenFileDialog { Filter = "画像|*.png;*.jpg;*.jpeg;*.webp;*.gif" };
        var host = AvatarHost.Of(this);
        if ((host?.OwnerWindow is { } owner ? file.ShowDialog(owner) : file.ShowDialog()) != true) return;
        try
        {
            var loaded = await ImageCodec.ReadAsync(file.FileName);
            var chosen = await (host ?? throw new InvalidOperationException("画像の調整画面を開けません。")).CropAsync(loaded.Preview, AvatarVariant.Large, null, true);
            if (chosen?.Selection is not { } selection) return;
            large = BotImageFields.From(AvatarVariant.Large, selection); Edited(); RenderImages();
        }
        catch (Exception) { errorText = EditorText.ImageUnreadable; RenderNotices(); }
    }
    // Mac reopenCrop: the kept source when there is one (with its crop), otherwise the rendered image itself.
    private async Task ReopenAsync(AvatarVariant variant)
    {
        var fields = variant == AvatarVariant.Small ? small : large;
        var source = fields?.Source ?? ""; var render = fields?.Render ?? "";
        try
        {
            var image = await AvatarHost.DecodeAsync(source.Length == 0 ? render : source);
            var chosen = await (AvatarHost.Of(this) ?? throw new InvalidOperationException("画像の調整画面を開けません。")).CropAsync(image, variant, source.Length == 0 ? null : fields!.Crop, true);
            if (chosen?.Selection is not { } selection) return;
            if (variant == AvatarVariant.Small) { small = BotImageFields.From(variant, selection); if (avatar is not null) await avatar.ShowAsync(selection.Render, selection); }
            else large = BotImageFields.From(variant, selection);
            Edited(); RenderImages();
        }
        catch (Exception) { errorText = EditorText.ImageUnreadable; RenderNotices(); }
    }

    // ---- 削除 ----
    private void RenderDelete()
    {
        deleteHost.Children.Clear();
        if (id is null) return;
        var group = new GroupCard();
        if (Locked)
        {
            group.Add(Row(Text(DeletionPending ? EditorText.DeletePending : EditorText.DeleteUnconfirmed, 12, Muted)));
            group.Add(Row(LinkButton("削除結果を確認", () => _ = ConfirmDeletionAsync())));
        }
        else group.Add(Row(LinkButton("メンバーを削除", AskDelete, destructive: true)));
        deleteHost.Children.Add(FormSection(null, group, EditorText.MemberDeleteFooter));
    }
    internal void AskDelete()
    {
        if (id is null || Locked) return;
        var shown = workspace.Conversations.FirstOrDefault(entry => entry.Target == new ChatTarget(id, false))?.Name ?? original.Name;
        ShowAlert(EditorText.MemberDeleteTitle(shown), EditorText.MemberDeleteMessage, new AlertChoice("削除", () => _ = DeleteAsync(), Destructive: true), new AlertChoice("キャンセル", Bold: true));
    }
    // One DELETE, never repeated by this editor. An answer that cannot be told apart from "not sent" leaves the 削除結果を確認 exit.
    internal Task DeleteAsync() => RunAsync(async () =>
    {
        if (id is null || Locked) return;
        errorText = null; outcome = null; submitted = [];
        try { await workspace.RequestBotDeletionAsync(id); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { deletionUnconfirmed = BellApiException.IsResultUnconfirmed(error); errorText = EditorText.Failure(error); }
        RenderDelete(); RenderNotices(); Lock();
    });
    internal Task ConfirmDeletionAsync() => RunAsync(async () =>
    {
        if (id is null) return;
        errorText = null;
        try { if (await workspace.ConfirmBotDeletionAsync(id)) { Close(); return; } errorText = EditorText.DeleteStillListed; }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { errorText = EditorText.DeleteReadFailed(error); }
        RenderDelete(); RenderNotices(); Lock();
    });
    // Render seam: the state a lost DELETE answer leaves.
    internal void ShowDeletionUnconfirmedForRender() { deletionUnconfirmed = true; errorText = EditorText.Failure(new BellApiException("接続が切れました。")); RenderDelete(); RenderNotices(); Lock(); }

    // ---- 保存 ----
    public override async Task SaveAsync()
    {
        if (!CanSave) return;
        await RunAsync(async () =>
        {
            var api = workspace.Management;
            errorText = null; outcome = null; outcomeError = null; submitted = []; RenderNotices();
            if (string.IsNullOrWhiteSpace(name.Text)) { errorText = EditorText.NameRequired; RenderNotices(); return; }
            BotSettings edited;
            try { edited = models.Apply(original with { Name = name.Text, Position = position.Text, ProfileText = profile.Text, Personality = personality.Text, SpeechStyle = speech.Text, Role = role.Text, Color = (string?)color.SelectedValue ?? original.Color }); }
            catch (ArgumentException invalid) { errorText = invalid.Message; RenderNotices(); return; }
            if (id is null) { await CreateAsync(api, edited); return; }
            submitted = edited.ChangesFrom(original); submittedSettings = edited;
            if (submitted.Count == 0) { Close(); return; }
            BotSettingsResponse saved;
            try { saved = await api.SaveBotAsync(id, submitted, Token); }
            catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
            // No answer, or a server error: it may have saved. Read it back (never send again); the read decides what the owner is told.
            catch (Exception error) when (BellApiException.IsResultUnconfirmed(error)) { await ReadBackAsync(api, edited); RenderNotices(); Notify(); return; }
            catch (Exception error) { errorText = error.Message; RenderNotices(); return; }
            models.SetSavedFastMode(saved.Bot.FastMode); original = edited with { FastMode = saved.Bot.FastMode };
            await workspace.RefreshManagementAsync();
            if (saved.Applying) { outcome = Outcome.Saved; RenderNotices(); Notify(); return; }
            Close();
        });
    }
    private async Task CreateAsync(ManagementApi api, BotSettings edited)
    {
        try { await api.CreateBotAsync(edited, new[] { small, large }.OfType<BotImageFields>().ToArray(), Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { errorText = EditorText.Failure(error); RenderNotices(); return; }
        await workspace.RefreshManagementAsync(); Close();
    }
    // A GET only: compares what the server holds with what was submitted. A failed read is "unconfirmed", never a reason to send again.
    private async Task ReadBackAsync(ManagementApi api, BotSettings edited)
    {
        try
        {
            if (await api.ConfirmBotAsync(id!, submitted, Token)) { outcome = Outcome.Confirmed; original = edited; await workspace.RefreshManagementAsync(); }
            else outcome = Outcome.Different;
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { outcome = Outcome.Unconfirmed; outcomeError = error; }
    }
    internal Task ConfirmSaveAsync() => RunAsync(async () =>
    {
        if (id is null || submitted.Count == 0 || submittedSettings is null) return;
        errorText = null; await ReadBackAsync(workspace.Management, submittedSettings);
        RenderNotices(); Notify();
    });

    private void RenderNotices()
    {
        notices.Children.Clear();
        var group = new GroupCard(); var mint = Mint;
        switch (outcome)
        {
            case Outcome.Saved: group.Add(Row(Text(EditorText.Applying, 12, mint))); break;
            case Outcome.Confirmed: group.Add(Row(Text(EditorText.SaveConfirmed, 12, mint))); break;
            case Outcome.Different: group.Add(Row(Text(EditorText.SaveDifferent, 12, Red))); group.Add(Row(LinkButton("保存結果を確認", () => _ = ConfirmSaveAsync()))); break;
            case Outcome.Unconfirmed: group.Add(Row(Text(EditorText.SaveUnconfirmed(outcomeError ?? new BellApiException("")), 12, Red))); group.Add(Row(LinkButton("保存結果を確認", () => _ = ConfirmSaveAsync()))); break;
        }
        if (errorText is not null) group.Add(Row(Text(errorText, 12, Red)));
        if (group.Count == 0) return;
        var holder = new StackPanel { Margin = new Thickness(0, 14, 0, 0) }; holder.Children.Add(group); notices.Children.Add(holder);
    }
}

// Mac RoomEditor: ルーム (photo, name, shared work), メンバー, 代表, and 削除 for an existing room. Failures open the 操作を完了できませんでした alert.
public sealed class RoomEditorView : EditorFormView
{
    private readonly Workspace workspace;
    private readonly string? id;
    private RoomSettings original = new("", "", [], null, "");
    private readonly HashSet<string> members = [];
    private string representative = "";
    private TextBox name = null!, purpose = null!;
    private AvatarPicker avatar = null!;
    private ComboBox picker = null!;
    private readonly List<(Bot Bot, CheckBox Choice)> toggles = [];
    private bool updating;
    public RoomEditorView(Workspace workspace, string? id) : base(workspace) { this.workspace = workspace; this.id = id; }
    internal ComboBox RepresentativePicker => picker;
    internal IReadOnlyList<(Bot Bot, CheckBox Choice)> Members => toggles;
    public async Task InitializeAsync()
    {
        var loading = Text("読み込んでいます…", 13, Secondary, null, new Thickness(20, 16, 0, 0)); Form.Children.Add(loading);
        try
        {
            var api = workspace.Management;
            if (id is not null) original = RoomSettings.From((await api.Api.GetAsync<RoomResponse>(new ChatTarget(id, true).Path, Token)).Room);
            Token.ThrowIfCancellationRequested();
            Form.Children.Remove(loading); Build(); Ready = true; Notify();
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
        catch (Exception error) { loading.Text = error.Message; loading.Foreground = Red; }
    }
    private void Build()
    {
        members.UnionWith(original.MemberIds); representative = original.RepresentativeId ?? "";
        avatar = new AvatarPicker(original.Avatar, name: original.Name, isRoom: true) { HorizontalAlignment = HorizontalAlignment.Center }; InitialLoads.Add(avatar.LoadAsync());
        var nameField = Field("ルーム名", original.Name); name = nameField.Box; var purposeField = Field("この部屋で共有する仕事", original.Purpose, multiline: true, minHeight: 48); purpose = purposeField.Box; purpose.MaxHeight = 150;
        Form.Children.Add(FormSection("ルーム", new GroupCard(Row(avatar, 0), Row(nameField.Element), Row(purposeField.Element))));
        var group = new GroupCard();
        foreach (var bot in workspace.Bots)
        {
            var choice = new CheckBox { Content = bot.DisplayName, IsChecked = members.Contains(bot.Id), FontSize = 13, VerticalContentAlignment = VerticalAlignment.Center };
            choice.Checked += (_, _) => Toggled(bot.Id, true); choice.Unchecked += (_, _) => Toggled(bot.Id, false);
            toggles.Add((bot, choice)); group.Add(Row(choice));
        }
        Form.Children.Add(FormSection("メンバー", group));
        picker = Popup("代表Bot", [], representative); picker.MinWidth = 180;
        picker.SelectionChanged += (_, _) => { if (!updating && picker.SelectedValue is string value) representative = value; };
        Form.Children.Add(FormSection("代表", new GroupCard(Labeled("代表Bot", picker)))); ShowRepresentatives();
        if (id is not null) Form.Children.Add(FormSection(null, new GroupCard(Row(LinkButton("ルームを削除", AskDelete, destructive: true))), EditorText.RoomDeleteFooter));
    }
    // Mac: unchecking the representative clears the choice; the list offers only the members checked now.
    private void Toggled(string botId, bool on)
    {
        if (on) members.Add(botId); else { members.Remove(botId); if (representative == botId) representative = ""; }
        ShowRepresentatives();
    }
    private void ShowRepresentatives()
    {
        updating = true;
        picker.ItemsSource = new[] { new FormOption("", "代表なし") }.Concat(toggles.Where(item => members.Contains(item.Bot.Id)).Select(item => new FormOption(item.Bot.Id, item.Bot.DisplayName))).ToArray();
        picker.SelectedValue = representative; updating = false;
    }
    internal void AskDelete()
    {
        if (id is null) return;
        ShowAlert(EditorText.RoomDeleteTitle(original.Name), EditorText.RoomDeleteMessage, new AlertChoice("削除", () => _ = DeleteAsync(), Destructive: true), new AlertChoice("キャンセル", Bold: true));
    }
    private void Fail(string message) => ShowAlert(EditorText.RoomErrorTitle, message, new AlertChoice("閉じる", Bold: true));
    internal Task DeleteAsync() => RunAsync(async () =>
    {
        if (id is null) return;
        try { await workspace.Management.DeleteRoomAsync(id, Token); }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { Fail(EditorText.Failure(error)); return; }
        await workspace.RefreshManagementAsync(); Close();
    });
    public override Task SaveAsync() => !CanSave ? Task.CompletedTask : RunAsync(async () =>
    {
        if (string.IsNullOrWhiteSpace(name.Text)) { Fail(EditorText.RoomNameRequired); return; }
        var edited = new RoomSettings(name.Text.Trim(), purpose.Text, members.Order(StringComparer.Ordinal).ToArray(), representative.Length == 0 ? null : representative, avatar.Value);
        var api = workspace.Management;
        try
        {
            if (id is null) await api.CreateRoomAsync(edited, Token);
            else { var changes = edited.ChangesFrom(original); if (changes.Count != 0) await api.UpdateRoomAsync(id, changes, Token); }
        }
        catch (OperationCanceledException) when (Token.IsCancellationRequested) { throw; }
        catch (Exception error) { Fail(EditorText.RoomSaveFailure(error)); return; }
        await workspace.RefreshManagementAsync(); Close();
    });
}

// Mac WindowGroup("メンバーを編集"): the edit form in a window of its own (1120x900, at least 600x500) with キャンセル / 保存 at the top.
public sealed class MemberEditorWindow : Window
{
    private readonly MemberEditorView view;
    private readonly Button cancel, save;
    public MemberEditorView View => view;
    public MemberEditorWindow(Workspace workspace, string id)
    {
        SetResourceReference(StyleProperty, typeof(Window)); SetResourceReference(BackgroundProperty, "ConversationBackground");
        Title = "メンバーを編集"; Width = Math.Min(1120, SystemParameters.WorkArea.Width); Height = Math.Min(900, SystemParameters.WorkArea.Height); MinWidth = 600; MinHeight = 500; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        view = new MemberEditorView(workspace, id) { Closer = Close };
        cancel = Capsule("キャンセル", Palette.Card, Ink, 16, 13, new Thickness(14, 6, 14, 6)); save = Capsule("保存", Palette.Card, Ink, 16, 13, new Thickness(14, 6, 14, 6)); save.Margin = new Thickness(8, 0, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(cancel, "キャンセル"); System.Windows.Automation.AutomationProperties.SetName(save, "保存");
        cancel.Click += (_, _) => { if (view.CanClose) Close(); }; save.Click += async (_, _) => await view.SaveAsync();
        var bar = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 8, 14, 8) }; bar.Children.Add(cancel); bar.Children.Add(save);
        var dock = new DockPanel(); DockPanel.SetDock(bar, Dock.Top); dock.Children.Add(bar); dock.Children.Add(view); Content = dock;
        view.CanSaveChanged += Sync; Sync();
        Closing += (_, args) => { if (!view.CanClose && !view.IsClosing) args.Cancel = true; };
        Closed += (_, _) => view.Dispose();
    }
    public Task InitializeAsync() => view.InitializeAsync();
    private void Sync() { cancel.Content = view.CloseLabel; cancel.IsEnabled = view.CanClose; save.IsEnabled = view.CanSave; System.Windows.Automation.AutomationProperties.SetName(cancel, view.CloseLabel); }
}
