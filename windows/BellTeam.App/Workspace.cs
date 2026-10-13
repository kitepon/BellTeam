using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using BellTeam.Core;
using System.IO;
using System.Windows.Media.Imaging;

namespace BellTeam.App;

public sealed record ConversationEntry(ChatTarget Target, string Name, string Subtitle, DateTimeOffset RecentAt, Bot? Bot, Room? Room, string? Origin = null, bool Working = false)
{
    public string Group => Target.IsRoom ? "ルーム" : "メンバー";
    public string Initial => Name.Length == 0 ? "?" : System.Globalization.StringInfo.GetNextTextElement(Name);
    public string Presence => Bot is { Online: true } ? "●" : "";
    public bool FastMode => Bot?.FastMode == true;
    public bool IsMember => Bot is not null;
    public string PreviewText => TextContent.Normalize(Subtitle).Replace('\n', ' ');
    public System.Windows.Media.Brush PresenceBrush => Working ? System.Windows.Media.Brushes.IndianRed : Bot?.Online == true ? System.Windows.Media.Brushes.MediumAquamarine : System.Windows.Media.Brushes.LightSlateGray;
    public string? AvatarUrl => Origin is not null && (Bot?.AvatarVersion ?? Room?.AvatarVersion ?? "").Length != 0 ? Origin + $"api/{(Target.IsRoom ? "rooms" : "bots")}/{Uri.EscapeDataString(Target.Id)}/avatar?v={Bot?.AvatarVersion ?? Room!.AvatarVersion}" : null;
}

public sealed class Workspace : INotifyPropertyChanged, IDisposable
{
    private readonly Func<Uri, BellApi> apiFactory;
    private readonly Func<Uri, Task>? prepareConnection;
    public Workspace(Func<Uri, BellApi>? apiFactory = null, Func<Uri, Task>? prepareConnection = null) { this.apiFactory = apiFactory ?? (origin => new BellApi(origin)); this.prepareConnection = prepareConnection; }
    private BellApi? api;
    private CancellationTokenSource? connection;
    private CancellationTokenSource? selection;
    private readonly Dictionary<(string, ChatTarget), ConversationDraft> drafts = [];
    private readonly SemaphoreSlim refreshLock = new(1);
    private List<ConversationEntry> all = [];
    private QueueItem[] queue = [];
    private string search = "";
    private string? connectionError;
    private bool needsLogin;
    private string connectionStatus = "接続先を設定してください。";
    public string OwnerName { get; private set; } = "あなた";
    public string AuthMode { get; private set; } = "local";
    private ConversationEntry? selected;
    private bool hasMore;
    private bool loading;
    private bool preview;
    private bool ready;
    private readonly Dictionary<ImageAttachment, BitmapSource> attachmentPreviews = [];
    private CancellationTokenSource? screenCancellation;
    private bool screenVisible;
    private string screen = "";
    private string screenStatus = "";
    private string? actionError;
    private readonly Dictionary<string, Task<BitmapSource>> avatars = [];
    public ObservableCollection<ConversationEntry> Entries { get; } = [];
    public ObservableCollection<MessageItem> Messages { get; } = [];
    public CancellationToken ViewToken => selection?.Token ?? connection?.Token ?? CancellationToken.None;
    public CancellationToken ConnectionToken => connection?.Token ?? CancellationToken.None;
    public ManagementApi Management => new(api ?? throw new BellApiException("接続先を設定してください。"));
    public PlanningApi Planning => new(api ?? throw new BellApiException("接続先を設定してください。"));
    public event Action? ServerChanged;
    public ConversationEntry[] Conversations => all.ToArray();
    public Bot[] Bots => all.Where(entry => entry.Bot is not null).Select(entry => entry.Bot!).ToArray();
    public string? ActionError { get => actionError; private set { actionError = value; Changed(); } }
    public bool ScreenVisible { get => screenVisible; private set { screenVisible = value; Changed(); Changed(nameof(ProfileVisible)); } }
    public bool ProfileVisible => !ScreenVisible;
    public string Screen { get => screen; private set { screen = value; Changed(); } }
    public string ScreenStatus { get => screenStatus; private set { screenStatus = value; Changed(); } }
    public bool CanShowScreen => selected is { Target.IsRoom: false };
    public AttachmentPreview[] Attachments => Draft?.Attachments.Select(image => new AttachmentPreview(image, attachmentPreviews[image])).ToArray() ?? [];
    public string Search { get => search; set { search = value; Changed(); Filter(); } }
    public string? ConnectionError { get => connectionError; private set { connectionError = value; Changed(); } }
    public bool NeedsLogin { get => needsLogin; private set { needsLogin = value; Changed(); } }
    public string ConnectionStatus { get => connectionStatus; private set { connectionStatus = value; Changed(); } }
    public ConversationEntry? Selected => selected;
    public bool HasSelection => selected is not null;
    public bool Connected => ready;
    public string EditLabel => IsRoom ? "ルームを編集" : "メンバーを編集";
    public bool CanAttach => HasSelection && Draft is { Attaching: false };
    public bool IsRoom => selected?.Target.IsRoom == true;
    public string Title => selected?.Name ?? "チームと、同じデスクで。";
    public string OnlineSummary => $"{all.Count(entry => entry.Bot?.Online == true)}人オンライン";
    public string ConversationSubtitle => selected?.Bot is { } bot ? bot.Online ? "オンライン" : "次のメッセージで起動します" : selected?.Room is { } room ? $"{room.MemberIds.Length}人のメンバー" : "";
    public string ActivityText => selected is { } entry ? string.Join('\n', QueueItem.DisplayItems(queue.Where(item => entry.Target.IsRoom ? item.Context == "room" && item.ContextId == entry.Target.Id : item.BotId == entry.Target.Id)).Select(item => $"◌  {item.BotName ?? entry.Name} · {(item.Status == "queued" ? "送信待ち" : "処理中")}")) : "";
    public bool HasActivity => ActivityText.Length != 0;
    public string Server => api?.Origin.AbsoluteUri ?? "";
    public bool HasMore { get => hasMore; private set { hasMore = value; Changed(); } }
    public bool Loading { get => loading; private set { loading = value; Changed(); Changed(nameof(CanSend)); } }
    private ConversationDraft? Draft => selected is null ? null : drafts.GetValueOrDefault((Server, selected.Target));
    public string DraftText { get => Draft?.Text ?? ""; set { if (Draft is { } draft) draft.Text = value; Changed(); Changed(nameof(CanSend)); } }
    public string? SendError => Draft?.Error;
    public string SendLabel => Draft?.Attaching == true ? "画像を読込中…" : Draft?.Sending == true ? "送信中…" : "送信";
    public bool CanSend => api is not null && selected is not null && !Loading && Draft is { Sending: false, Attaching: false, HasContent: true };
    public ObservableCollection<MemberChoice> ReplyMembers { get; } = [];
    public string Profile => selected?.Bot is { } bot
        ? $"{bot.DisplayName}\n{(bot.Online ? "オンライン" : "オフライン")}\n\nプロフィール\n\n役職\n{Empty(bot.Position)}\n\n背景・見た目・関係性\n{Empty(bot.ProfileText)}\n\n性格・考え方\n{Empty(bot.Personality)}\n\n口調\n{Empty(bot.SpeechStyle)}\n\n担当する仕事\n{Empty(bot.Role)}\n\nAI\nハーネス: {bot.Harness}\nモデル: {Empty(bot.Model, "既定")}"
        : selected?.Room is { } room ? $"{room.Name}\n\nこの部屋で共有する仕事\n{Empty(room.Purpose)}\n\n参加メンバー\n{string.Join('\n', room.MemberIds.Select(id => all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id))}" : "左のメンバーやルームを選んで、会話を始めましょう。";
    private static string Empty(string value, string replacement = "未設定") => string.IsNullOrWhiteSpace(value) ? replacement : value;
    public event PropertyChangedEventHandler? PropertyChanged;
    public event Action<bool>? ScrollToBottom;
    private void Changed([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    private void DraftChanged() { Changed(nameof(DraftText)); Changed(nameof(SendError)); Changed(nameof(SendLabel)); Changed(nameof(CanSend)); Changed(nameof(CanAttach)); Changed(nameof(Attachments)); }

    public async Task ConnectAsync(string address, bool listen = true)
    {
        var origin = ServerOrigin.Parse(address);
        ready = false;
        SaveReplyMembers();
        ReturnToProfile();
        connection?.Cancel();
        selection?.Cancel();
        api?.Dispose();
        connection?.Dispose();
        api = apiFactory(origin);
        avatars.Clear();
        connection = new CancellationTokenSource();
        selected = null;
        all.Clear(); queue = []; OwnerName = "あなた"; AuthMode = "local"; Entries.Clear(); Messages.Clear(); ReplyMembers.Clear();
        Changed(nameof(OwnerName)); Changed(nameof(AuthMode)); Changed(nameof(OnlineSummary));
        HasMore = false;
        Loading = false;
        Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(Connected)); Changed(nameof(EditLabel)); Changed(nameof(CanShowScreen)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(Server)); DraftChanged();
        ConnectionError = null;
        NeedsLogin = false;
        ActionError = null;
        ConnectionStatus = "接続を確認しています…";
        var current = api;
        current.AuthenticationRequired += () => { if (api == current) NeedsLogin = true; };
        var token = connection.Token;
        try
        {
            if (prepareConnection is not null) await prepareConnection(origin);
            token.ThrowIfCancellationRequested();
            var session = await current.GetAsync<SessionInfo>("/api/session", token);
            AuthMode = session.AuthMode; Changed(nameof(AuthMode));
            if (!session.Authenticated) { NeedsLogin = session.AuthMode == "cloudflare"; throw new BellApiException(NeedsLogin ? "Cloudflare Accessへログインしてください。" : "接続先が認証を拒否しました。サーバーの設定を確認してください。"); }
            await RefreshAsync(current, token);
            ready = true; Changed(nameof(Connected));
            ConnectionStatus = "接続済み";
            if (listen) _ = ListenAsync(current, token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) { ConnectionError = error.Message; ConnectionStatus = "接続できませんでした。"; } }
    }

    private async Task ListenAsync(BellApi current, CancellationToken token)
    {
        try
        {
            await foreach (var item in current.EventsAsync(token))
            {
                ConnectionStatus = "接続済み・新着を受信中";
                if (item.EnumerateObject().Any()) { await RefreshAsync(current, token); ServerChanged?.Invoke(); }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) { ConnectionError = error.Message; ConnectionStatus = "新着の受信が停止しました。"; } }
    }

    private async Task RefreshAsync(BellApi current, CancellationToken token)
    {
        await refreshLock.WaitAsync(token);
        try
        {
            var bots = await current.GetAsync<BotsResponse>("/api/bots?avatar=omit", token);
            var rooms = await current.GetAsync<RoomsResponse>("/api/rooms?avatar=omit", token);
            var activity = await current.GetAsync<QueueResponse>("/api/queue", token);
            var owner = await current.GetAsync<OwnerResponse>("/api/owner?avatar=omit", token);
            token.ThrowIfCancellationRequested();
            OwnerName = owner.Owner.Name; Changed(nameof(OwnerName));
            queue = activity.Items; var working = queue.Where(item => item.Status == "running").Select(item => item.BotId).ToHashSet();
            all = bots.Bots.Select(bot => new ConversationEntry(new(bot.Id, false), bot.DisplayName, bot.Recent?.Preview ?? bot.Position, bot.Recent?.At ?? DateTimeOffset.MinValue, bot, null, Server, working.Contains(bot.Id)))
                .Concat(rooms.Rooms.Select(room => new ConversationEntry(new(room.Id, true), room.Name, room.Recent?.Preview ?? room.Purpose, room.Recent?.At ?? DateTimeOffset.MinValue, null, room, Server))).ToList();
            var usedAvatars = all.Select(entry => entry.AvatarUrl).ToHashSet(); foreach (var key in avatars.Keys.Where(key => !usedAvatars.Contains(key)).ToArray()) avatars.Remove(key);
            var known = all.Select(entry => entry.Target).ToHashSet();
            foreach (var key in drafts.Keys.Where(key => key.Item1 == Server && !known.Contains(key.Item2)).ToArray())
            {
                foreach (var image in drafts[key].Attachments) attachmentPreviews.Remove(image);
                drafts.Remove(key);
            }
            Filter();
            Changed(nameof(OnlineSummary)); Changed(nameof(ConversationSubtitle));
            Changed(nameof(ActivityText)); Changed(nameof(HasActivity));
            if (selected is { } active)
            {
                selected = all.FirstOrDefault(item => item.Target == active.Target);
                Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(EditLabel)); Changed(nameof(CanShowScreen)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile));
                if (selected is not null) await RefreshMessagesAsync(current, selected.Target, token);
                else { ReturnToProfile(); selection?.Cancel(); Messages.Clear(); ReplyMembers.Clear(); HasMore = false; DraftChanged(); }
            }
        }
        finally { refreshLock.Release(); }
    }

    private void Filter()
    {
        Entries.Clear();
        foreach (var entry in all.Where(item => item.Name.Contains(search, StringComparison.CurrentCultureIgnoreCase))
            .OrderByDescending(item => item.Target.IsRoom).ThenByDescending(item => item.RecentAt)) Entries.Add(entry);
    }

    public async Task SelectAsync(ConversationEntry entry)
    {
        SaveReplyMembers();
        ReturnToProfile();
        selection?.Cancel(); selection?.Dispose();
        selection = connection is null ? new CancellationTokenSource() : CancellationTokenSource.CreateLinkedTokenSource(connection.Token);
        var token = selection.Token;
        selected = entry;
        Changed(nameof(ConversationSubtitle));
        Changed(nameof(ActivityText)); Changed(nameof(HasActivity));
        if (!drafts.ContainsKey((Server, entry.Target))) drafts[(Server, entry.Target)] = new ConversationDraft();
        Messages.Clear(); HasMore = false;
        ReplyMembers.Clear();
        foreach (var id in entry.Room?.MemberIds ?? [])
            ReplyMembers.Add(new MemberChoice(id, all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id, Draft!.Targets.Contains(id)));
        ActionError = null;
        Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(EditLabel)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(CanShowScreen)); DraftChanged();
        if (preview) { foreach (var item in PreviewMessages()) Messages.Add(new(item)); return; }
        if (api is null) return;
        Loading = true;
        try
        {
            var page = await api.GetAsync<MessagePage>(entry.Target.Path + "/messages?limit=30", token);
            token.ThrowIfCancellationRequested();
            foreach (var message in page.Items) Messages.Add(new(message));
            HasMore = page.HasMore;
            ScrollToBottom?.Invoke(true);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) ConnectionError = error.Message; }
        finally { if (!token.IsCancellationRequested) Loading = false; }
    }

    private async Task RefreshMessagesAsync(BellApi current, ChatTarget target, CancellationToken token)
    {
        var activeSelection = selection;
        var last = Messages.LastOrDefault()?.Message.Id;
        var page = await current.GetAsync<MessagePage>(target.Path + "/messages?limit=30", token);
        var after = last is null ? Array.Empty<TimelineMessage>()
            : (await current.GetAsync<MessagePage>(target.Path + "/messages?after=" + Uri.EscapeDataString(last), token)).Items;
        if (selected?.Target != target || Loading || api != current || selection != activeSelection) return;
        var merged = Timeline.Merge(Messages.Select(item => item.Message), page.Items.Concat(after));
        for (var index = 0; index < merged.Length; index++)
        {
            if (index == Messages.Count) Messages.Add(new(merged[index]));
            else Messages[index].Update(merged[index]);
        }
        if (last is null) HasMore = page.HasMore;
            if (page.Items.Length != 0 && (last is null || merged.LastOrDefault()?.Id != last)) ScrollToBottom?.Invoke(false);
    }

    public async Task LoadOlderAsync()
    {
        if (api is null || selected is null || Messages.FirstOrDefault()?.Message is not { } first || Loading) return;
        var target = selected.Target;
        var token = selection!.Token;
        Loading = true;
        try
        {
            var page = await api.GetAsync<MessagePage>(target.Path + "/messages?limit=30&before=" + Uri.EscapeDataString(first.Id), token);
            token.ThrowIfCancellationRequested();
            var existing = Messages.Select(item => item.Message.Id).ToHashSet();
            for (var index = page.Items.Length - 1; index >= 0; index--) if (existing.Add(page.Items[index].Id)) Messages.Insert(0, new(page.Items[index]));
            HasMore = page.HasMore;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) ConnectionError = error.Message; }
        finally { if (!token.IsCancellationRequested) Loading = false; }
    }

    public async Task SendAsync()
    {
        if (!CanSend) return;
        var current = api!;
        var target = selected!.Target;
        var draft = Draft!;
        draft.Targets = ReplyMembers.Where(item => item.Selected).Select(item => item.Id).ToArray();
        var content = draft.BeginSendContent(); DraftChanged();
        var token = connection!.Token;
        try
        {
            await current.SendAsync(target, content.Text, content.Images, target.IsRoom && content.Targets.Length != 0 ? content.Targets : null, token);
            foreach (var image in content.Images) attachmentPreviews.Remove(image);
            draft.CompleteSend(); DraftChanged();
            if (selected?.Target == target && api == current) ScrollToBottom?.Invoke(true);
        }
        catch (Exception error)
        {
            var uncertain = error is not BellApiException { Status: not null } || (int)((error as BellApiException)?.Status ?? 0) >= 500;
            draft.FailSend(content, (uncertain ? "操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\n" : "") + error.Message);
            DraftChanged();
            return;
        }
        try { await RefreshAsync(current, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) ConnectionError = "送信は受け付けられました。会話の更新に失敗しました。" + error.Message; }
    }

    public void SaveReplyMembers()
    {
        if (Draft is { } draft) draft.Targets = ReplyMembers.Where(item => item.Selected).Select(item => item.Id).ToArray();
    }

    public void ReportActionError(string? message) => ActionError = message;
    public async Task RefreshManagementAsync()
    {
        if (api is null || connection is null) return;
        try { await RefreshAsync(api, connection.Token); }
        catch (Exception error) { ActionError = "保存は受け付けられましたが、一覧の更新を確認できませんでした。" + error.Message; }
    }
    public Task<BitmapSource> AvatarAsync(string url)
    {
        if (avatars.TryGetValue(url, out var existing)) return existing;
        async Task<BitmapSource> Load() => await ImageCodec.DecodeAsync(await (api ?? throw new BellApiException("接続先を設定してください。")).ImageAsync(url, ConnectionToken));
        var task = Load(); avatars[url] = task; return task;
    }
    public async Task AttachFilesAsync(string[] paths)
    {
        if (Draft is not { } draft) return;
        if (draft.Attaching) { ActionError = "画像の読み込みが終わってから追加してください。"; return; }
        var key = (Server, selected!.Target);
        draft.Attaching = true; ActionError = null; DraftChanged();
        try
        {
            var loaded = new List<(ImageAttachment Data, BitmapSource Preview)>();
            foreach (var path in paths) loaded.Add(await ImageCodec.ReadAsync(path));
            if (!drafts.TryGetValue(key, out var current) || current != draft) return;
            foreach (var image in loaded) { attachmentPreviews[image.Data] = image.Preview; draft.Attachments.Add(image.Data); }
        }
        catch (Exception error) { ActionError = "画像を読み込めませんでした。" + error.Message; }
        finally { draft.Attaching = false; DraftChanged(); }
    }
    public void AttachClipboardImage(BitmapSource bitmap)
    {
        if (Draft is not { } draft) return;
        if (draft.Attaching) { ActionError = "画像の読み込みが終わってから追加してください。"; return; }
        var data = new ImageAttachment("貼り付けた画像.png", "image/png", ImageCodec.Png(bitmap));
        var previewImage = bitmap.Clone(); previewImage.Freeze();
        attachmentPreviews[data] = previewImage; draft.Attachments.Add(data); DraftChanged();
    }
    public void RemoveAttachment(ImageAttachment image)
    {
        if (Draft?.Attachments.Remove(image) == true) attachmentPreviews.Remove(image);
        DraftChanged();
    }
    public async Task ExportAsync(string path)
    {
        if (api is null || selected is null) return;
        ActionError = null;
        try { var bytes = await api.ExportAsync(selected.Target, connection!.Token); await File.WriteAllBytesAsync(path, bytes); }
        catch (Exception error) { ActionError = "書き出せませんでした（" + error.Message + "）"; }
    }
    public async Task<byte[]> ImageAsync(string path, CancellationToken token)
    {
        if (preview)
        {
            var bitmap = BitmapSource.Create(2, 2, 96, 96, System.Windows.Media.PixelFormats.Bgra32, null, new byte[] { 180, 150, 230, 255, 210, 190, 150, 255, 210, 190, 150, 255, 180, 150, 230, 255 }, 8);
            return ImageCodec.Png(bitmap);
        }
        return await (api ?? throw new BellApiException("接続先を設定してください。")).ImageAsync(path, token);
    }
    public async Task<SecretRequest> FinishSecretAsync(string id, string? value) => await (api ?? throw new BellApiException("接続先を設定してください。")).FinishSecretAsync(id, value, connection!.Token);
    public async Task<OwnerQuestion> AnswerAsync(string id, string? choice, string? text) => await (api ?? throw new BellApiException("接続先を設定してください。")).AnswerAsync(id, choice, text, connection!.Token);
    public void ReturnToProfile()
    {
        screenCancellation?.Cancel(); screenCancellation?.Dispose(); screenCancellation = null; ScreenVisible = false;
    }
    public async Task OpenScreenAsync()
    {
        ReturnToProfile();
        if (selected is not { Target.IsRoom: false } entry || api is null) return;
        var current = api;
        screenCancellation = CancellationTokenSource.CreateLinkedTokenSource(ViewToken);
        var token = screenCancellation.Token;
        ScreenVisible = true; Screen = ""; ScreenStatus = "画面を読み込んでいます…";
        try
        {
            while (!token.IsCancellationRequested)
            {
                var result = await current.GetAsync<ScreenResponse>(entry.Target.Path + "/screen", token);
                token.ThrowIfCancellationRequested();
                Screen = result.Screen.Length != 0 ? result.Screen : result.Online ? "画面は空です" : "次のメッセージで起動します";
                ScreenStatus = result.Online ? "2秒ごとに更新" : "停止中";
                await Task.Delay(TimeSpan.FromSeconds(2), token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) ScreenStatus = error.Message; }
    }

    public async Task ReconnectAsync() { if (api is not null) await ConnectAsync(Server); }
    public void LoadPreview()
    {
        preview = true;
        all = [new(new("preview", false), "ベル", "Windowsアプリを確認しています", DateTimeOffset.Now,
            new Bot { Id = "preview", Name = "ベル", DisplayName = "ベル", Online = true, Position = "技術パートナー", ProfileText = "これは表示確認用の人工データです。", Role = "Windowsアプリの開発" }, null)];
        Filter(); ConnectionStatus = "表示確認用の人工データ";
    }
    private static TimelineMessage[] PreviewMessages() => [
        new() { Id = "preview1", At = DateTimeOffset.Now, Direction = "outgoing", Message = "Windows版でも、会話を読みやすくしたい。" },
        new() { Id = "preview2", At = DateTimeOffset.Now, Direction = "incoming", Message = "**画像・カードの表示確認です。**", Image = true, ImageUrls = ["/api/message-images/user/preview.png"] },
        new() { Id = "preview-secret", At = DateTimeOffset.Now, SecretRequest = new() { Id = "preview-secret", BotId = "preview", ToolId = "test", Label = "確認用の入力", Message = "これは表示確認用の人工データです。", Status = "pending" } },
        new() { Id = "preview-question", At = DateTimeOffset.Now, OwnerQuestion = new() { Id = "preview-question", BotId = "preview", Question = "どちらから始めましょうか。", Options = ["画像を確認", "会話を書き出す"], AllowOther = true, Status = "open" } }
    ];
    public void Dispose() { ReturnToProfile(); connection?.Cancel(); selection?.Cancel(); connection?.Dispose(); selection?.Dispose(); api?.Dispose(); attachmentPreviews.Clear(); avatars.Clear(); drafts.Clear(); }
}

public sealed record AttachmentPreview(ImageAttachment Data, BitmapSource Preview) { public string Name => Data.Name; }

public sealed class MemberChoice(string id, string name, bool selected)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public bool Selected { get; set; } = selected;
}
