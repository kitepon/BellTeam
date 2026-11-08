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
    // Mac BotPresenceDot: red (pulsing in the row template) while working, mint when online, the line colour when offline.
    public System.Windows.Media.Brush PresenceBrush => Working ? WorkingBrush : Bot?.Online == true ? OnlineBrush : OfflineBrush;
    public string PresenceLabel => Working ? "仕事中" : Bot?.Online == true ? "オンライン・待機中" : "オフライン";
    public string FastModeBadge => FastMode ? "  ⚡ ファスト" : "";
    private static readonly System.Windows.Media.Brush WorkingBrush = Frozen(0xFF, 0x3B, 0x30), OnlineBrush = Frozen(0x2E, 0xB3, 0x9E), OfflineBrush = Frozen(0xE5, 0xE3, 0xF0);
    private static System.Windows.Media.Brush Frozen(byte r, byte g, byte b) { var brush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(r, g, b)); brush.Freeze(); return brush; }
    // The independent large image (Mac avatar-large); null while the large slot shows the small image.
    public string? LargeAvatarUrl => Origin is not null && Bot is { UsesSmallImage: false } bot ? Origin + $"api/bots/{Uri.EscapeDataString(Target.Id)}/avatar-large?v={bot.AvatarLargeVersion}" : null;
    public string? AvatarUrl => Origin is not null && (Bot?.AvatarVersion ?? Room?.AvatarVersion ?? "").Length != 0 ? Origin + $"api/{(Target.IsRoom ? "rooms" : "bots")}/{Uri.EscapeDataString(Target.Id)}/avatar?v={Bot?.AvatarVersion ?? Room!.AvatarVersion}" : null;
}

public sealed class Workspace : INotifyPropertyChanged, IDisposable
{
    private readonly Func<Uri, BellApi> apiFactory;
    private readonly Func<Uri, Task>? prepareConnection;
    private readonly Func<int, CancellationToken, Task> retryDelay;
    // retryDelay waits before automatic attempt number n (0, 1, 2...); tests replace it so no real backoff is waited.
    public Workspace(Func<Uri, BellApi>? apiFactory = null, Func<Uri, Task>? prepareConnection = null, Func<int, CancellationToken, Task>? retryDelay = null)
    {
        this.apiFactory = apiFactory ?? (origin => new BellApi(origin)); this.prepareConnection = prepareConnection;
        this.retryDelay = retryDelay ?? ((attempt, token) => Task.Delay(ReconnectBackoff.Ms(attempt), token));
    }
    public Task RetryDelayAsync(int attempt, CancellationToken token) => retryDelay(attempt, token);
    // False when the last failed connection was a refused login: retrying cannot fix it, the login page or the message stays.
    public bool ConnectionRetryable { get; private set; } = true;
    private BellApi? api;
    private CancellationTokenSource? connection;
    private CancellationTokenSource? selection;
    private readonly Dictionary<(string, ChatTarget), ConversationDraft> drafts = [];
    // Mac ConversationTimelineState.pendingSends: the owner's own messages shown before the server history has them.
    private readonly Dictionary<(string, ChatTarget), List<PendingSend>> pendingSends = [];
    private readonly SemaphoreSlim refreshLock = new(1);
    private List<ConversationEntry> all = [];
    private QueueItem[] queue = [];
    private string search = "";
    private string? connectionError;
    private bool needsLogin;
    private string connectionStatus = "接続先を設定してください。";
    public string OwnerName { get; private set; } = "あなた";
    // Above the member list only while both Claude slots are limited (Kiro, same as Web loadAccountsBanner).
    public string AccountsBanner { get; private set; } = "";
    public string AuthMode { get; private set; } = "local";
    private ConversationEntry? selected;
    private bool hasMore;
    private bool loading;
    private bool preview;
    private bool ready;
    private readonly Dictionary<ImageAttachment, BitmapSource> attachmentPreviews = [];
    private CancellationTokenSource? screenCancellation;
    private bool screenVisible;
    private string screenText = "", screenRaw = "";
    private bool screenOnline;
    private string? screenError;
    private ScreenInputModel? screenInput;
    private string? actionError;
    private string? stoppingBotId;
    private StopNotice? stopResult;
    private bool loadFailed;
    // null = not read yet or the read failed; only a server answer of "off" makes the client refuse a no-target room send.
    private bool? routingEnabled;
    private readonly Dictionary<string, Task<BitmapSource>> avatars = [];
    public ObservableCollection<ConversationEntry> Entries { get; } = [];
    public ObservableCollection<MessageItem> Messages { get; } = [];
    public CancellationToken ViewToken => selection?.Token ?? connection?.Token ?? CancellationToken.None;
    public CancellationToken ConnectionToken => connection?.Token ?? CancellationToken.None;
    public ManagementApi Management => new(api ?? throw new BellApiException("接続先を設定してください。"));
    public PlanningApi Planning => new(api ?? throw new BellApiException("接続先を設定してください。"));
    public GoalsApi Goals => new(api ?? throw new BellApiException("接続先を設定してください。"));
    public event Action? ServerChanged;
    // The member and room lists were just read again (an open editor checks whether its member is gone).
    public event Action? RosterChanged;
    // Mac eventRevision: the server events that make an open goal view read its goals again (see GoalEvents).
    public event Action? GoalEvent;
    public event Action? UpdatesChanged;
    public event Action<MessageNotification>? MessageArrived;
    public ConversationEntry[] Conversations => all.ToArray();
    public Bot[] Bots => all.Where(entry => entry.Bot is not null).Select(entry => entry.Bot!).ToArray();
    public string? ActionError { get => actionError; private set { actionError = value; Changed(); } }
    public bool ScreenVisible { get => screenVisible; private set { screenVisible = value; Changed(); Changed(nameof(ProfileVisible)); } }
    public bool ProfileVisible => !ScreenVisible;
    // What the terminal shows: the screen, or the empty-state line (Mac BotTerminalView value).
    public string Screen => screenText;
    public bool ScreenOnline => screenOnline;
    public string? ScreenError => screenError;
    // Mac status line: a failed read shows its error instead (in red), otherwise "1秒ごとに更新" while the seat is online.
    public string ScreenStatus => screenError ?? (screenOnline ? "1秒ごとに更新" : "停止中");
    public ScreenInputModel? ScreenInput => screenInput;
    private TaskCompletionSource screenFirstRead = new(TaskCreationOptions.RunContinuationsAsynchronously);
    // Completes when the first read of the open screen (and its approval check) has finished or failed; the renders and tests wait on it.
    public Task ScreenFirstRead => screenFirstRead.Task;
    // Where the screen key bar sends a failure the Mac would report to diagnostics; tests replace it.
    public Action<Exception, string, string>? ScreenFailureReport { get; set; }
    private void SetScreen(string raw, bool online, string? error)
    {
        var text = raw.Length != 0 ? raw : online ? "画面は空です" : "次のメッセージで起動します";
        // Only a real change is published, so the terminal's selection and scroll position survive an unchanged second.
        var changed = text != screenText || online != screenOnline || error != screenError;
        screenRaw = raw; screenText = text; screenOnline = online; screenError = error;
        if (changed) { Changed(nameof(Screen)); Changed(nameof(ScreenOnline)); Changed(nameof(ScreenError)); Changed(nameof(ScreenStatus)); }
    }
    public bool CanShowScreen => selected is { Target.IsRoom: false };
    public AttachmentPreview[] Attachments => Draft?.Attachments.Select((image, index) => new AttachmentPreview(image, attachmentPreviews[image], index + 1)).ToArray() ?? [];
    public string Search { get => search; set { search = value; Changed(); Filter(); } }
    public string? ConnectionError { get => connectionError; private set { connectionError = value; Changed(); } }
    public bool NeedsLogin { get => needsLogin; private set { needsLogin = value; Changed(); } }
    public string ConnectionStatus { get => connectionStatus; private set { connectionStatus = value; Changed(); } }
    public ConversationEntry? Selected => selected;
    public bool SelectedFastMode => selected?.FastMode == true;
    public bool HasSelection => selected is not null;
    public bool Connected => ready;
    public bool Opening { get; private set; }
    public string EditLabel => IsRoom ? "ルームを編集" : "メンバーを編集";
    public bool CanAttach => HasSelection && Draft is { Attaching: false };
    public bool IsRoom => selected?.Target.IsRoom == true;
    public string Title => selected?.Name ?? "チームと、同じデスクで。";
    public string OnlineSummary => $"{all.Count(entry => entry.Bot?.Online == true)}人オンライン";
    public string ConversationSubtitle => selected?.Bot is { } bot ? bot.Online ? "オンライン" : "オフライン" : selected?.Room is { } room ? $"{room.MemberIds.Length}人のルーム" : "";
    private QueueItem[] SelectedQueue => selected is { } entry ? QueueItem.DisplayItems(queue.Where(item => entry.Target.IsRoom ? item.Context == "room" && item.ContextId == entry.Target.Id : item.BotId == entry.Target.Id)) : [];
    public string ActivityText => selected is { } entry ? string.Join('\n', SelectedQueue.Select(item => item.Line(entry.Name))) : "";
    public bool HasActivity => SelectedQueue.Length != 0;
    // One line per running/queued delivery; a room line carries the member's stop button (Mac queueStrip).
    public ActivityRow[] ActivityRows
    {
        get
        {
            if (selected is not { } entry) return [];
            var display = SelectedQueue;
            return display.Select(item => new ActivityRow(item.Line(entry.Name), QueueItem.IsStopRow(item, display, entry.Target.IsRoom, entry.Room?.MemberIds ?? []) ? item.BotId : null, item.BotName ?? entry.Name, item.BotId is { } id && id == stoppingBotId)).ToArray();
        }
    }
    public bool StopEnabled => stoppingBotId is null;
    public StopNotice? StopResult { get => stopResult; internal set { stopResult = value; Changed(); } }
    public bool CurrentBotCanStop => selected is { Target: { IsRoom: false, Id: var id } } && queue.Any(item => item.BotId == id && item.IsActive);
    public bool LoadFailed { get => loadFailed; private set { loadFailed = value; Changed(); } }
    public bool RoutingEnabled => routingEnabled != false;
    public bool? RoutingState => routingEnabled;
    public string ReplyTargetLabel => ReplyTarget.Label(routingEnabled != false, ReplyMembers.Where(item => item.Selected).Select(item => item.Name).ToArray());
    public string? MemberName(string id) => all.FirstOrDefault(entry => entry.Target == new ChatTarget(id, false))?.Bot?.DisplayName;
    public ConversationEntry? MemberEntry(string id) => all.FirstOrDefault(entry => entry.Target == new ChatTarget(id, false));
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
    private void Changed([CallerMemberName] string? name = null)
    {
        PropertyChanged?.Invoke(this, new(name));
        if (name == nameof(Selected)) PropertyChanged?.Invoke(this, new(nameof(SelectedFastMode)));
    }
    private void ActivityChanged() { Changed(nameof(ActivityText)); Changed(nameof(HasActivity)); Changed(nameof(ActivityRows)); Changed(nameof(StopEnabled)); Changed(nameof(CurrentBotCanStop)); }
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
        selected = null; stoppingBotId = null; stopResult = null; loadFailed = false; routingEnabled = null;
        all.Clear(); pendingBotDeletions.Clear(); pendingSends.Clear(); queue = []; OwnerName = "あなた"; AuthMode = "local"; Entries.Clear(); Messages.Clear(); ReplyMembers.Clear();
        Changed(nameof(OwnerName)); Changed(nameof(AuthMode)); Changed(nameof(OnlineSummary));
        HasMore = false;
        Loading = false;
        Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(Connected)); Changed(nameof(EditLabel)); Changed(nameof(CanShowScreen)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(Server)); DraftChanged();
        ConnectionError = null;
        ConnectionRetryable = true;
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
            if (!session.Authenticated) { ConnectionRetryable = false; NeedsLogin = session.AuthMode == "cloudflare"; throw new BellApiException(NeedsLogin ? "Cloudflare Accessへログインしてください。" : "接続先が認証を拒否しました。サーバーの設定を確認してください。"); }
            await RefreshAsync(current, token);
            ready = true; Changed(nameof(Connected));
            ConnectionStatus = "接続済み";
            if (listen) _ = ListenAsync(current, token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) { if (error is BellApiException { RequiresLogin: true }) ConnectionRetryable = false; ConnectionError = error.Message; ConnectionStatus = "接続できませんでした。"; } }
    }

    // Trony 11-08: only cancel, sign-out and a refused login stop; every other failure is shown and reconnects on the backoff (the Mac stops on a malformed stream).
    private static string? ReconnectText(Exception error) => error switch
    {
        BellApiException { RequiresLogin: true } => null,
        BellApiException { Code: BellApiException.StreamEndedCode } => BellApiException.StreamEndedMessage,
        BellApiException { Status: { } status } when (int)status == 429 || (int)status >= 500 => BellApiException.ConnectFailedMessage,
        // The 30 s handshake limit cancels without our token being cancelled: that is a connection failure too.
        System.Net.Http.HttpRequestException or IOException or OperationCanceledException => BellApiException.ConnectFailedMessage,
        _ => BellApiException.ConnectFailedMessage + "（" + error.Message + "）"
    };

    // One stream at a time: after it ends or fails to open, wait the backoff (0/1/2/4/8/15 s) and open the next. Only cancel, sign-out, a new connection or a non-retryable error leaves the loop.
    private async Task ListenAsync(BellApi current, CancellationToken token)
    {
        var attempt = 0; string? reconnecting = null;
        while (true)
        {
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            try
            {
                await foreach (var item in current.EventsAsync(token))
                {
                    var hadError = ConnectionError is not null; var recovered = reconnecting is not null;
                    if (recovered && ConnectionError == reconnecting) ConnectionError = null;
                    reconnecting = null;
                    ConnectionStatus = "接続済み・新着を受信中";
                    if (item.TryGetProperty("type", out var type) && type.ValueKind == System.Text.Json.JsonValueKind.String && type.GetString() == "updates") UpdatesChanged?.Invoke();
                    // Events may have been missed while the stream was down, so the first event after a reconnect reads everything again.
                    if (recovered || item.EnumerateObject().Any()) { if (GoalEvents.ShouldReload(item, hadError)) GoalEvent?.Invoke(); await RefreshAsync(current, token, notify: true); ServerChanged?.Invoke(); }
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception error)
            {
                if (api != current || token.IsCancellationRequested) return;
                reconnecting = ReconnectText(error);
                ConnectionError = reconnecting ?? error.Message;
                ConnectionStatus = reconnecting is null ? "新着の受信が停止しました。" : "新着を再接続しています…";
                if (reconnecting is null) return;
            }
            // Mac: a stream that stayed up over 30 s starts the schedule again; a connection that drops at once keeps backing off.
            if (System.Diagnostics.Stopwatch.GetElapsedTime(started) > ReconnectBackoff.StableConnection) attempt = 0;
            try { await RetryDelayAsync(attempt++, token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        }
    }

    // An optional notice like Web: an older body (404) or a failed read only hides it; the next list refresh reads it again.
    private static async Task<string> AccountsBannerAsync(BellApi current, CancellationToken token)
    {
        try { return string.Join(" / ", AccountText.BannerTexts(await new HarnessAccountsApi(current).ReadAsync(token), DateTimeOffset.Now)); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { return ""; }
    }

    private async Task RefreshAsync(BellApi current, CancellationToken token, bool notify = false)
    {
        await refreshLock.WaitAsync(token);
        try
        {
            var bots = await current.GetAsync<BotsResponse>("/api/bots?avatar=omit", token);
            var rooms = await current.GetAsync<RoomsResponse>("/api/rooms?avatar=omit", token);
            var activity = await current.GetAsync<QueueResponse>("/api/queue", token);
            var owner = await current.GetAsync<OwnerResponse>("/api/owner?avatar=omit", token);
            var accountsBanner = await AccountsBannerAsync(current, token);
            if (selected is { Target.IsRoom: true })
            {
                // An optional setting: its failure must not fail the list refresh.
                try { await LoadRoutingAsync(current, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception error) { SetRouting(null); ActionError = "返信者の自動選択の設定を読み取れませんでした。" + error.Message; }
            }
            token.ThrowIfCancellationRequested();
            OwnerName = owner.Owner.Name; Changed(nameof(OwnerName));
            if (AccountsBanner != accountsBanner) { AccountsBanner = accountsBanner; Changed(nameof(AccountsBanner)); }
            queue = activity.Items; var working = queue.Where(item => item.Status == "running").Select(item => item.BotId).ToHashSet();
            var previous = all.ToDictionary(entry => entry.Target);
            all = bots.Bots.Select(bot => new ConversationEntry(new(bot.Id, false), bot.DisplayName, CurrentWork.Label(bot.CurrentWork), bot.Recent?.At ?? DateTimeOffset.MinValue, bot, null, Server, working.Contains(bot.Id)))
                .Concat(rooms.Rooms.Select(room => new ConversationEntry(new(room.Id, true), room.Name, room.Recent?.Preview ?? room.Purpose, room.Recent?.At ?? DateTimeOffset.MinValue, null, room, Server))).ToList();
            if (notify)
                foreach (var entry in all)
                    if (previous.TryGetValue(entry.Target, out var before) && MessageNotification.FromRecent(Server, entry.Target, entry.Bot?.Name ?? entry.Name, before.Bot?.Recent ?? before.Room?.Recent, entry.Bot?.Recent ?? entry.Room?.Recent) is { } notification) MessageArrived?.Invoke(notification);
            var usedAvatars = all.SelectMany(entry => new[] { entry.AvatarUrl, entry.LargeAvatarUrl }).ToHashSet(); foreach (var key in avatars.Keys.Where(key => !usedAvatars.Contains(key)).ToArray()) avatars.Remove(key);
            var known = all.Select(entry => entry.Target).ToHashSet();
            foreach (var key in drafts.Keys.Where(key => key.Item1 == Server && !known.Contains(key.Item2)).ToArray())
            {
                foreach (var image in drafts[key].Attachments) attachmentPreviews.Remove(image);
                drafts.Remove(key); pendingSends.Remove(key);
            }
            pendingBotDeletions.IntersectWith(all.Where(entry => entry.Bot is not null).Select(entry => entry.Target.Id));
            Filter();
            RosterChanged?.Invoke();
            Changed(nameof(OnlineSummary)); Changed(nameof(ConversationSubtitle));
            ActivityChanged();
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
        stopResult = null; loadFailed = false; Changed(nameof(StopResult)); Changed(nameof(LoadFailed));
        ActivityChanged();
        if (!drafts.ContainsKey((Server, entry.Target))) drafts[(Server, entry.Target)] = new ConversationDraft();
        Messages.Clear(); HasMore = false;
        ReplyMembers.Clear();
        foreach (var id in entry.Room?.MemberIds ?? [])
            ReplyMembers.Add(new MemberChoice(id, all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id, Draft!.Targets.Contains(id)));
        ActionError = null;
        Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(EditLabel)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(CanShowScreen)); Changed(nameof(ReplyTargetLabel)); DraftChanged();
        if (preview) { foreach (var item in PreviewMessages()) Messages.Add(new(item)); return; }
        if (api is null) return;
        Loading = true;
        try
        {
            var page = await api.GetAsync<MessagePage>(entry.Target.Path + "/messages?limit=30", token);
            token.ThrowIfCancellationRequested();
            // The cards created for this first page enter with the staggered opening animation; later arrivals use the short one.
            Opening = true; _ = System.Windows.Threading.Dispatcher.CurrentDispatcher.BeginInvoke(System.Windows.Threading.DispatcherPriority.ContextIdle, () => Opening = false);
            ShowMessages(page.Items);
            HasMore = page.HasMore;
            ScrollToBottom?.Invoke(true);
            if (entry.Target.IsRoom)
            {
                try { await LoadRoutingAsync(api, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception error) { if (!token.IsCancellationRequested) { SetRouting(null); ActionError = "返信者の自動選択の設定を読み取れませんでした。" + error.Message; } }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) { ConnectionError = error.Message; LoadFailed = Messages.Count == 0; } }
        finally { if (!token.IsCancellationRequested) Loading = false; }
    }

    // Mac routingEnabled: the "routing" feature is on. Only a room needs it, so only a selected room reads it.
    private async Task LoadRoutingAsync(BellApi current, CancellationToken token)
    {
        var settings = await current.GetAsync<System.Text.Json.JsonElement>("/api/settings", token);
        // An unexpected shape is unknown, not "off".
        bool? enabled = settings.ValueKind == System.Text.Json.JsonValueKind.Object && settings.TryGetProperty("settings", out var features) && features.ValueKind == System.Text.Json.JsonValueKind.Array
            ? features.EnumerateArray().Any(item => item.ValueKind == System.Text.Json.JsonValueKind.Object && item.TryGetProperty("id", out var id) && id.ValueKind == System.Text.Json.JsonValueKind.String && id.GetString() == "routing" && item.TryGetProperty("status", out var status) && status.ValueKind == System.Text.Json.JsonValueKind.String && status.GetString() == "enabled")
            : null;
        SetRouting(enabled);
    }
    private void SetRouting(bool? enabled)
    {
        if (enabled == routingEnabled) return;
        routingEnabled = enabled; Changed(nameof(RoutingEnabled)); Changed(nameof(RoutingState)); Changed(nameof(ReplyTargetLabel));
    }

    private async Task RefreshMessagesAsync(BellApi current, ChatTarget target, CancellationToken token)
    {
        var activeSelection = selection;
        var last = Received().LastOrDefault()?.Id;
        var page = await current.GetAsync<MessagePage>(target.Path + "/messages?limit=30", token);
        var after = last is null ? Array.Empty<TimelineMessage>()
            : (await current.GetAsync<MessagePage>(target.Path + "/messages?after=" + Uri.EscapeDataString(last), token)).Items;
        if (selected?.Target != target || Loading || api != current || selection != activeSelection) return;
        var merged = Timeline.Merge(Received(), page.Items.Concat(after));
        ShowMessages(merged);
        if (last is null) HasMore = page.HasMore;
        if (page.Items.Length != 0 && (last is null || merged.LastOrDefault()?.Id != last)) ScrollToBottom?.Invoke(false);
    }

    // The server history as the list holds it: everything except the local echoes.
    private TimelineMessage[] Received() => Messages.Select(item => item.Message).Where(message => !PendingSend.IsLocal(message.Id)).ToArray();

    // Mac visibleMessages: puts the list to "received history, then the echoes the history does not have yet", keeping the rows (and their loaded images) that stay.
    private void ShowMessages(TimelineMessage[] received)
    {
        if (selected is not { } entry) return;
        var key = (Server, entry.Target);
        var pending = PendingSend.Reconcile(pendingSends.GetValueOrDefault(key) ?? [], received);
        if (pending.Count == 0) pendingSends.Remove(key); else pendingSends[key] = pending;
        var desired = PendingSend.Visible(received, pending);
        var ids = desired.Select(message => message.Id).ToHashSet();
        for (var index = Messages.Count - 1; index >= 0; index--) if (!ids.Contains(Messages[index].Message.Id)) Messages.RemoveAt(index);
        for (var index = 0; index < desired.Length; index++)
        {
            if (index < Messages.Count && Messages[index].Message.Id == desired[index].Id) { Messages[index].Update(desired[index]); continue; }
            var existing = Messages.Select((item, at) => (item, at)).FirstOrDefault(pair => pair.at > index && pair.item.Message.Id == desired[index].Id);
            if (existing.item is null) Messages.Insert(index, new(desired[index]));
            else { Messages.Move(existing.at, index); Messages[index].Update(desired[index]); }
        }
    }
    // before null adds after; after null removes before; both replaces.
    private void ChangePending((string, ChatTarget) key, PendingSend? before, PendingSend? after)
    {
        var list = pendingSends.GetValueOrDefault(key) ?? [];
        var at = before is null ? -1 : list.FindIndex(item => item.Id == before.Id);
        if (after is null) { if (at >= 0) list.RemoveAt(at); } else if (at >= 0) list[at] = after; else list.Add(after);
        if (list.Count == 0) pendingSends.Remove(key); else pendingSends[key] = list;
        if (selected is { } entry && (Server, entry.Target) == key) ShowMessages(Received());
    }
    // Render seam: the owner's message in the first seconds after sending (never sent anywhere).
    internal void ShowEchoForRender(string body, bool accepted)
    {
        var key = (Server, selected!.Target); var echo = new PendingSend(PendingSend.NewId(), body, 0, DateTimeOffset.Now);
        ChangePending(key, null, accepted ? echo with { AcceptedId = "render-accepted" } : echo);
    }

    public async Task LoadOlderAsync()
    {
        if (api is null || selected is null || Received().FirstOrDefault() is not { } first || Loading) return;
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
        if (IsRoom && !ReplyMembers.Any(item => item.Selected) && routingEnabled == false) { Draft!.Reject(ReplyTarget.RoutingUnsetError); DraftChanged(); return; }
        var current = api!;
        var target = selected!.Target;
        var draft = Draft!;
        draft.Targets = ReplyMembers.Where(item => item.Selected).Select(item => item.Id).ToArray();
        var content = draft.BeginSendContent(); DraftChanged();
        var token = connection!.Token;
        // Mac send(): the message is on screen as 受付確認中 before the server answers; a failure takes it away again and gives the text back.
        var key = (Server, target); var echo = new PendingSend(PendingSend.NewId(), content.Text, content.Images.Length, DateTimeOffset.Now);
        ChangePending(key, null, echo);
        if (selected?.Target == target) ScrollToBottom?.Invoke(true);
        try
        {
            var acceptedId = await current.SendAsync(target, content.Text, content.Images, target.IsRoom && content.Targets.Length != 0 ? content.Targets : null, token);
            foreach (var image in content.Images) attachmentPreviews.Remove(image);
            if (api == current) ChangePending(key, echo, echo with { AcceptedId = acceptedId });
            draft.CompleteSend(); DraftChanged();
        }
        catch (Exception error)
        {
            if (api == current) ChangePending(key, echo, null);
            draft.FailSend(content, (BellApiException.IsResultUnconfirmed(error) ? "操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\n" : "") + error.Message);
            DraftChanged();
            return;
        }
        try { await RefreshAsync(current, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) ConnectionError = "送信は受け付けられました。会話の更新に失敗しました。" + error.Message; }
    }

    // Never resent on its own: a stop whose result is unknown is reported as such and the owner decides.
    public async Task StopAsync(string botId, string name)
    {
        if (api is null || connection is null || stoppingBotId is not null) return;
        var current = api; var token = connection.Token;
        stoppingBotId = botId; stopResult = null; Changed(nameof(StopResult)); ActivityChanged();
        try
        {
            var outcome = await current.StopBotAsync(botId, token);
            StopResult = StopNotice.FromOutcome(outcome, name);
        }
        catch (Exception error) { StopResult = StopNotice.FromFailure(error); }
        finally { stoppingBotId = null; ActivityChanged(); }
        if (api == current) await RefreshManagementAsync();
    }
    public Task StopCurrentAsync() => selected is { Target: { IsRoom: false, Id: var id } } entry ? StopAsync(id, entry.Name) : Task.CompletedTask;
    public void ToggleReplyMember(MemberChoice choice) { choice.Selected = !choice.Selected; Changed(nameof(ReplyTargetLabel)); }
    public void ClearReplyMembers() { foreach (var item in ReplyMembers) item.Selected = false; Changed(nameof(ReplyTargetLabel)); }
    public void ReportDraftError(string message) { if (Draft is { } draft) { draft.Reject(message); DraftChanged(); } }

    public void SaveReplyMembers()
    {
        if (Draft is { } draft) draft.Targets = ReplyMembers.Where(item => item.Selected).Select(item => item.Id).ToArray();
    }

    public void ReportActionError(string? message) => ActionError = message;
    // Render seam: the bottom banner of a live workspace whose update stream ended.
    internal void SetConnectionErrorForRender(string message) => ConnectionError = message;
    public async Task RefreshManagementAsync()
    {
        if (api is null || connection is null) return;
        try { await RefreshAsync(api, connection.Token); }
        catch (Exception error) { ActionError = "保存は受け付けられましたが、一覧の更新を確認できませんでした。" + error.Message; }
    }
    // Mac requestBotDeletion / confirmBotDeletion: DELETE answers 202 (accepted only). The member counts as deleting until a list read no longer has it.
    private readonly HashSet<string> pendingBotDeletions = [];
    public bool BotDeletionPending(string id) => pendingBotDeletions.Contains(id);
    // Render seam: the state a 202 from DELETE leaves while the member is still listed.
    public void SetBotDeletionPendingForRender(string id) { pendingBotDeletions.Add(id); RosterChanged?.Invoke(); }
    public bool HasBot(string id) => all.Any(entry => entry.Target == new ChatTarget(id, false));
    public async Task RequestBotDeletionAsync(string id)
    {
        await Management.DeleteBotAsync(id, ConnectionToken);
        if (HasBot(id)) { pendingBotDeletions.Add(id); RosterChanged?.Invoke(); }
    }
    // A read only. Throws when the list cannot be read; the caller keeps the member as pending then.
    public async Task<bool> ConfirmBotDeletionAsync(string id)
    {
        if (api is null || connection is null) throw new BellApiException("接続先を設定してください。");
        await RefreshAsync(api, connection.Token);
        return !HasBot(id);
    }
    private readonly Dictionary<(string, string), AvatarImageSession> imageSessions = [];
    // One per member and server: a selection kept after an unconfirmed save outlives the inspector and its sheet (Mac store.profileImageDrafts).
    public AvatarImageSession ImageSession(string botId) { if (!imageSessions.TryGetValue((Server, botId), out var session)) imageSessions[(Server, botId)] = session = new(); return session; }
    public string? AvatarVersion(string botId, AvatarVariant variant) => all.FirstOrDefault(entry => entry.Target == new ChatTarget(botId, false))?.Bot is { } bot ? variant == AvatarVariant.Small ? bot.AvatarVersion : bot.AvatarLargeVersion : null;
    // Unlike RefreshManagementAsync this throws: the image save flow must know whether the roster caught up.
    public Task RefreshForImageAsync() => api is null || connection is null ? Task.CompletedTask : RefreshAsync(api, connection.Token);
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
        screenCancellation?.Cancel(); screenCancellation?.Dispose(); screenCancellation = null; screenInput?.Retire(); screenInput = null; ScreenVisible = false;
    }
    // Mac BotScreenView.refreshScreen: the full history once (?history=1), then the screen tail every second joined onto it.
    // A failed read ends the polling and shows its error; the owner opens the screen again to start over. Nothing is retried.
    public async Task OpenScreenAsync()
    {
        ReturnToProfile();
        if (selected is not { Target.IsRoom: false } entry || api is null) return;
        var current = api;
        screenCancellation = CancellationTokenSource.CreateLinkedTokenSource(ViewToken);
        var token = screenCancellation.Token;
        var input = screenInput = new ScreenInputModel(current, entry.Target.Id, ScreenFailureReport);
        var firstRead = screenFirstRead = new(TaskCreationOptions.RunContinuationsAsynchronously);
        SetScreen("", false, null); Changed(nameof(ScreenInput)); ScreenVisible = true;
        var path = entry.Target.Path + "/screen";
        var scrollback = new ScreenScrollback(); var loadedHistory = false;
        try
        {
            while (!token.IsCancellationRequested)
            {
                var started = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    var result = await current.GetAsync<ScreenResponse>(loadedHistory ? path : path + "?history=1", token);
                    token.ThrowIfCancellationRequested();
                    string next;
                    if (loadedHistory) next = scrollback.Merge(result.Screen);
                    else { scrollback.Start(result.Screen); next = result.Screen; loadedHistory = true; }
                    SetScreen(next, result.Online, null);
                    await input.RefreshApprovalAsync(token);
                    firstRead.TrySetResult();
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                // BellApi has already raised AuthenticationRequired (the login button); the screen just stops.
                catch (BellApiException error) when (error.RequiresLogin) { firstRead.TrySetResult(); break; }
                // A transient failure (timeout, 5xx, seat restart) must not freeze an open screen: show it, read again next tick; the next 200 clears it.
                catch (Exception error) { SetScreen(screenRaw, screenOnline, error.Message); firstRead.TrySetResult(); }
                // Reads never overlap: the next starts one second after the previous started, at once after a slow answer.
                var wait = TimeSpan.FromSeconds(1) - started.Elapsed;
                if (wait > TimeSpan.Zero) await Task.Delay(wait, token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    public async Task ReconnectAsync() { if (api is not null) await ConnectAsync(Server); }
    public void SignOut()
    {
        connection?.Cancel(); selection?.Cancel(); ReturnToProfile(); ready = false; selected = null; stoppingBotId = null; stopResult = null; loadFailed = false; routingEnabled = null;
        all.Clear(); queue = []; Entries.Clear(); Messages.Clear(); ReplyMembers.Clear(); drafts.Clear(); pendingSends.Clear(); attachmentPreviews.Clear(); avatars.Clear(); OwnerName = "あなた"; AccountsBanner = ""; Changed(nameof(AccountsBanner));
        HasMore = false; Loading = false; ConnectionError = ActionError = null; NeedsLogin = AuthMode == "cloudflare"; ConnectionStatus = "ログアウトしました。";
        foreach (var name in new[] { nameof(Connected), nameof(Selected), nameof(HasSelection), nameof(IsRoom), nameof(Title), nameof(Profile), nameof(OwnerName), nameof(OnlineSummary), nameof(ActivityText), nameof(HasActivity), nameof(ActivityRows), nameof(StopEnabled), nameof(CurrentBotCanStop), nameof(StopResult), nameof(LoadFailed), nameof(RoutingEnabled), nameof(ReplyTargetLabel), nameof(CanShowScreen) }) Changed(name);
        DraftChanged();
    }
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

public sealed record ActivityRow(string Text, string? StopBotId, string Name, bool Stopping) { public string StopLabel => Stopping ? "停止中…" : "止める"; }
public sealed record AttachmentPreview(ImageAttachment Data, BitmapSource Preview, int Number = 0) { public string Name => Data.Name; public string RemoveLabel => $"添付画像{Number}を外す"; }

public sealed class MemberChoice(string id, string name, bool selected)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public bool Selected { get; set; } = selected;
}
