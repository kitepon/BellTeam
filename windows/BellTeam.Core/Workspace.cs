using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.IO;

namespace BellTeam.Core;

public sealed record ConversationEntry(ChatTarget Target, string Name, string Subtitle, DateTimeOffset RecentAt, Bot? Bot, Room? Room, string? Origin = null, bool Working = false, SeatApproval? SeatApproval = null)
{
    // The amber badge on a member's row while one of its seats waits on a tool approval (seat-approval-clients); null for a room and for a member with none.
    public string? SeatApprovalBadge => SeatApproval is null ? null : SeatApprovalText.Badge;
    public string Group => Target.IsRoom ? CoreStrings.Workspace_Group_1 : CoreStrings.MessageNotification_FromRecent_5;
    public string Initial => Name.Length == 0 ? "?" : System.Globalization.StringInfo.GetNextTextElement(Name);
    public string Presence => Bot is { Online: true } ? "●" : "";
    public bool FastMode => Bot?.FastMode == true;
    public bool IsMember => Bot is not null;
    public bool Pinned => Bot?.PinnedAt is not null;
    public string PinBadge => Pinned ? "  📌" : "";
    public string PinMenuText => Pinned ? CoreStrings.Workspace_PinMenuText_1 : CoreStrings.Workspace_PinMenuText_2;
    // The red line under a member's summary and on top of its conversation; null for a room and for a member with no notice.
    public string? SeatLaunchLine => Bot?.SeatLaunch?.Line;
    public string PreviewText => TextContent.Normalize(Subtitle).Replace('\n', ' ');
    // Mac BotPresenceDot: red (pulsing in the row template) while working, mint when online, the line colour when offline; each app maps the tone to its colour.
    public PresenceTone PresenceTone => Working ? PresenceTone.Working : Bot?.Online == true ? PresenceTone.Online : PresenceTone.Offline;
    public string PresenceLabel => Working ? CoreStrings.Workspace_PresenceLabel_1 : Bot?.Online == true ? CoreStrings.Workspace_PresenceLabel_2 : CoreStrings.Workspace_PresenceLabel_3;
    public string FastModeBadge => FastMode ? CoreStrings.Workspace_FastModeBadge_1 : "";
    // The independent large image (Mac avatar-large); null while the large slot shows the small image.
    public string? LargeAvatarUrl => Origin is not null && Bot is { UsesSmallImage: false } bot ? Origin + $"api/bots/{Uri.EscapeDataString(Target.Id)}/avatar-large?v={bot.AvatarLargeVersion}" : null;
    public string? AvatarUrl => Origin is not null && (Bot?.AvatarVersion ?? Room?.AvatarVersion ?? "").Length != 0 ? Origin + $"api/{(Target.IsRoom ? "rooms" : "bots")}/{Uri.EscapeDataString(Target.Id)}/avatar?v={Bot?.AvatarVersion ?? Room!.AvatarVersion}" : null;
}

public enum PresenceTone { Working, Online, Offline }

// The image work an app supplies to Workspace: decoding, reading a file and encoding a pasted image to PNG.
public interface IImageCodec<TImage>
{
    Task<TImage> DecodeAsync(byte[] bytes);
    Task<(ImageAttachment Data, TImage Preview)> ReadAsync(string path);
    // A pasted image: its PNG bytes and a preview the draft may keep after the clipboard changes.
    (byte[] Png, TImage Preview) Pasted(TImage image);
}

public class Workspace<TImage> : INotifyPropertyChanged, IDisposable
{
    private readonly IImageCodec<TImage> codec;
    // Runs the action after the first page's message cards have rendered (WPF ContextIdle); Opening must stay true until then.
    private readonly Action<Action> afterFirstRender;
    private readonly Func<Uri, BellApi> apiFactory;
    private readonly Func<Uri, Task>? prepareConnection;
    private readonly Func<int, CancellationToken, Task> retryDelay;
    // retryDelay waits before automatic attempt number n (0, 1, 2...); tests replace it so no real backoff is waited.
    public Workspace(IImageCodec<TImage> codec, Action<Action> afterFirstRender, Func<Uri, BellApi>? apiFactory = null, Func<Uri, Task>? prepareConnection = null, Func<int, CancellationToken, Task>? retryDelay = null)
    {
        this.codec = codec; this.afterFirstRender = afterFirstRender;
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
    private SeatApproval[] seatApprovals = [];
    private QueueItem[] queue = [];
    private string search = "";
    private string? connectionError;
    private bool needsLogin;
    private string connectionStatus = CoreStrings.Workspace_connectionStatus_1;
    public string OwnerName { get; private set; } = CoreStrings.Approvals_HistoryRows_1;
    /// <summary>The Owner's open seat tool approvals, oldest first (seat-approvals.md); empty when the body has none or cannot say. Read again on every server event and after every answer.</summary>
    public IReadOnlyList<SeatApproval> SeatApprovals => seatApprovals;
    public event Action? SeatApprovalsChanged;
    /// <summary>Answers one entry (approve_once or deny), then reads the entries again whatever the outcome: a 409 means another front answered first.</summary>
    public async Task<SeatApprovalOutcome> AnswerSeatApprovalAsync(SeatApproval approval, string decision)
    {
        var current = api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1); var token = connection!.Token;
        var outcome = await current.AnswerSeatApprovalAsync(approval.Id, decision, token);
        try { await RefreshAsync(current, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception) { }   // the next event or refresh reads it again
        return outcome;
    }
    /// <summary>The Owner profile as last read (avatar body omitted), null until read on this connection.</summary>
    public OwnerProfile? Owner { get; private set; }
    // Above the member list only while both Claude slots are limited (Kiro, same as Web loadAccountsBanner).
    public string AccountsBanner { get; private set; } = "";
    public string AuthMode { get; private set; } = "local";
    private ConversationEntry? selected;
    private bool hasMore;
    private bool loading;
    private bool preview;
    private bool ready;
    private readonly Dictionary<ImageAttachment, TImage> attachmentPreviews = [];
    private CancellationTokenSource? screenCancellation;
    private bool screenVisible;
    private string screenText = "", screenRaw = "";
    private bool screenOnline, screenMachine;
    private string? screenError;
    private ScreenInputModel? screenInput;
    private string? actionError;
    private string? stoppingBotId;
    private StopNotice? stopResult;
    private bool loadFailed;
    // null = not read yet or the read failed; only a server answer of "off" makes the client refuse a no-target room send.
    private bool? routingEnabled;
    private readonly Dictionary<string, Task<TImage>> avatars = [];
    public ObservableCollection<ConversationEntry> Entries { get; } = [];
    public ObservableCollection<MessageItem> Messages { get; } = [];
    public CancellationToken ViewToken => selection?.Token ?? connection?.Token ?? CancellationToken.None;
    public CancellationToken ConnectionToken => connection?.Token ?? CancellationToken.None;
    public ManagementApi Management => new(api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1));
    public PlanningApi Planning => new(api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1));
    public GoalsApi Goals => new(api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1));
    // 端末 (16a): the registry as last read and the check results live for one connection, as on the Mac (empty after a reconnect and a sign-out).
    private TerminalsModel? terminals;
    // 16c: this PC's facts; a render or a test sets another before Terminals is first used.
    public IThisPc ThisPc { get; set; } = new ThisPcSystem();
    public TerminalsModel Terminals => terminals ??= new(new TerminalsApi(api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)), ThisPc);
    public event Action? ServerChanged;
    // The member and room lists were just read again (an open editor checks whether its member is gone).
    public event Action? RosterChanged;
    // Mac eventRevision: the server events that make an open goal view read its goals again (see GoalEvents).
    public event Action? GoalEvent;
    public event Action? UpdatesChanged;
    // a485 7c: login.requested / login.* / session.* on the stream; an app with a session reads its requests and session list again.
    public event Action? LoginEvent;
    public event Action<MessageNotification>? MessageArrived;
    public ConversationEntry[] Conversations => all.ToArray();
    public Bot[] Bots => all.Where(entry => entry.Bot is not null).Select(entry => entry.Bot!).ToArray();
    public string? ActionError { get => actionError; private set { actionError = value; Changed(); } }
    public bool ScreenVisible { get => screenVisible; private set { screenVisible = value; Changed(); Changed(nameof(ProfileVisible)); } }
    public bool ProfileVisible => !ScreenVisible;
    // What the terminal shows: the screen, or the empty-state line (Mac BotTerminalView value).
    public string Screen => screenText;
    public bool ScreenOnline => screenOnline;
    // A machine seat has no terminal: the app shows the screen text without the key bar.
    public bool ScreenMachine => screenMachine;
    public string? ScreenError => screenError;
    // Mac status line: a failed read shows its error instead (in red), otherwise "1秒ごとに更新" while the seat is online.
    public string ScreenStatus => screenError ?? (screenOnline ? CoreStrings.Workspace_ScreenStatus_1 : CoreStrings.SettingsModels_RowText_1);
    public ScreenInputModel? ScreenInput => screenInput;
    private TaskCompletionSource screenFirstRead = new(TaskCreationOptions.RunContinuationsAsynchronously);
    // Completes when the first read of the open screen (and its approval check) has finished or failed; the renders and tests wait on it.
    public Task ScreenFirstRead => screenFirstRead.Task;
    // Where the screen key bar sends a failure the Mac would report to diagnostics; tests replace it.
    public Action<Exception, string, string>? ScreenFailureReport { get; set; }
    private void SetScreen(string raw, bool online, string? error, bool machine)
    {
        var text = raw.Length != 0 ? raw : online ? CoreStrings.Workspace_SetScreen_1 : CoreStrings.Workspace_SetScreen_2;
        // Only a real change is published, so the terminal's selection and scroll position survive an unchanged second.
        var changed = text != screenText || online != screenOnline || error != screenError || machine != screenMachine;
        screenRaw = raw; screenText = text; screenOnline = online; screenError = error; screenMachine = machine;
        if (changed) { Changed(nameof(Screen)); Changed(nameof(ScreenOnline)); Changed(nameof(ScreenMachine)); Changed(nameof(ScreenError)); Changed(nameof(ScreenStatus)); }
    }
    public bool CanShowScreen => selected is { Target.IsRoom: false };
    public AttachmentPreview<TImage>[] Attachments => Draft?.Attachments.Select((image, index) => new AttachmentPreview<TImage>(image, attachmentPreviews[image], index + 1)).ToArray() ?? [];
    public string Search { get => search; set { search = value; Changed(); Filter(); } }
    public string? ConnectionError { get => connectionError; private set { connectionError = value; Changed(); } }
    // a485: what the server said about app sessions on the last read (null = a server without them: today's login path). When it enforces them, a missing or refused session is answered by the server's own login (LoginFlow), not by Access.
    public LoginInfo? Login { get; private set; }
    public bool SessionLoginRequired => Login?.Enforced == true;
    public bool NeedsLogin { get => needsLogin; private set { needsLogin = value; Changed(); } }
    public string ConnectionStatus { get => connectionStatus; private set { connectionStatus = value; Changed(); } }
    public ConversationEntry? Selected => selected;
    public bool SelectedFastMode => selected?.FastMode == true;
    public bool HasSelection => selected is not null;
    public bool Connected => ready;
    public bool Opening { get; private set; }
    public string EditLabel => IsRoom ? CoreStrings.Workspace_EditLabel_1 : CoreStrings.Workspace_EditLabel_2;
    public bool CanAttach => HasSelection && Draft is { Attaching: false };
    public bool IsRoom => selected?.Target.IsRoom == true;
    public string Title => selected?.Name ?? CoreStrings.Workspace_Title_1;
    public string OnlineSummary => CoreStrings.Workspace_OnlineSummary_1(all.Count(entry => entry.Bot?.Online == true));
    public string ConversationSubtitle => selected?.Bot is { } bot ? bot.Online ? CoreStrings.Workspace_ConversationSubtitle_1 : CoreStrings.Workspace_PresenceLabel_3 : selected?.Room is { } room ? CoreStrings.Workspace_ConversationSubtitle_3(room.MemberIds.Length) : "";
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
    public string SendLabel => Draft?.Attaching == true ? CoreStrings.Workspace_SendLabel_1 : Draft?.Sending == true ? CoreStrings.Workspace_SendLabel_2 : CoreStrings.Workspace_SendLabel_3;
    public bool CanSend => api is not null && selected is not null && !Loading && Draft is { Sending: false, Attaching: false, HasContent: true };
    public ObservableCollection<MemberChoice> ReplyMembers { get; } = [];
    // Reply to a chosen message (conversation reply.md). Not the room's 返信者 (ReplyMembers): that picks who answers, this picks what is answered.
    public ReplyReference? Quote => Draft?.Quote;
    // selection: the part of the text the Owner selected (引用して返信); null replies to the whole message.
    public void StartQuote(TimelineMessage message, QuoteSelection? selection = null)
    {
        if (Draft is not { } draft || !Timeline.IsQuotable(message) || selection is { Text: var text } && string.IsNullOrWhiteSpace(text)) return;
        draft.Quote = ReplyReference.Local(message, message.IsOutgoing ? OwnerName : message.Sender?.Title ?? selected?.Name ?? "", selection);
        draft.Selection = selection;
        Changed(nameof(Quote));
    }
    public void CancelQuote() { if (Draft is { } draft) { draft.Quote = null; draft.Selection = null; Changed(nameof(Quote)); } }
    // Raised with the id of a loaded row the view should scroll to; the quote tells the view which part to highlight.
    public event Action<string, ReplyReference?>? ScrollToMessage;
    // Tap on a quote: scroll to the original when it is loaded, else load older pages until it appears or there are no more (reply.md "Jump").
    public async Task JumpToAsync(ReplyReference quote)
    {
        if (selection?.Token is not { } token) return;
        ActionError = null; var id = quote.Id;
        while (!Messages.Any(item => item.Message.Id == id) && HasMore && !Loading && !token.IsCancellationRequested && ConnectionError is null)
        {
            var before = Messages.Count;
            await LoadOlderAsync();
            if (Messages.Count == before) break;
        }
        if (token.IsCancellationRequested) return;
        if (Messages.Any(item => item.Message.Id == id)) ScrollToMessage?.Invoke(id, quote);
        else if (!HasMore && ConnectionError is null) ActionError = Timeline.QuoteNotFound;
    }
    public string Profile => selected?.Bot is { } bot
        ? CoreStrings.Workspace_Profile_4(bot.DisplayName, (bot.Online ? CoreStrings.Workspace_ConversationSubtitle_1 : CoreStrings.Workspace_PresenceLabel_3), Empty(bot.Position), Empty(bot.ProfileText), Empty(bot.Personality), Empty(bot.SpeechStyle), Empty(bot.Role), bot.Harness, Empty(bot.Model, CoreStrings.UserRules_Label_9))
        : selected?.Room is { } room ? CoreStrings.Workspace_Profile_5(room.Name, Empty(room.Purpose), string.Join('\n', room.MemberIds.Select(id => all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id))) : CoreStrings.Workspace_Profile_6;
    private static string Empty(string value, string replacement = "未設定") => string.IsNullOrWhiteSpace(value) ? replacement : value;
    public event PropertyChangedEventHandler? PropertyChanged;
    public event Action<bool>? ScrollToBottom;
    private void Changed([CallerMemberName] string? name = null)
    {
        PropertyChanged?.Invoke(this, new(name));
        if (name == nameof(Selected)) PropertyChanged?.Invoke(this, new(nameof(SelectedFastMode)));
    }
    private void ActivityChanged() { Changed(nameof(ActivityText)); Changed(nameof(HasActivity)); Changed(nameof(ActivityRows)); Changed(nameof(StopEnabled)); Changed(nameof(CurrentBotCanStop)); }
    private void DraftChanged() { Changed(nameof(Quote)); Changed(nameof(DraftText)); Changed(nameof(SendError)); Changed(nameof(SendLabel)); Changed(nameof(CanSend)); Changed(nameof(CanAttach)); Changed(nameof(Attachments)); }

    public async Task ConnectAsync(string address, bool listen = true)
    {
        var origin = ServerOrigin.Parse(address);
        ready = false;
        SaveReplyMembers();
        ReturnToProfile();
        // a471-scroll-jump: a reconnect to the same server keeps the open conversation, its rows, the echoes and the list; the roster read at the end merges the fresh rows in like any refresh, so what the
        // Owner is reading stays where it is. Another server, or no open conversation, starts clean.
        var keep = selected is not null && api is not null && api.Origin == origin;
        connection?.Cancel();
        selection?.Cancel();
        api?.Dispose();
        connection?.Dispose();
        api = apiFactory(origin);
        terminals = null;
        avatars.Clear();
        connection = new CancellationTokenSource();
        if (keep) { selection?.Dispose(); selection = CancellationTokenSource.CreateLinkedTokenSource(connection.Token); }
        if (!keep) selected = null;
        stoppingBotId = null; stopResult = null; loadFailed = false; routingEnabled = null;
        pendingBotDeletions.Clear(); queue = []; Owner = null; OwnerName = CoreStrings.Approvals_HistoryRows_1; AuthMode = "local";
        if (!keep) { all.Clear(); pendingSends.Clear(); Entries.Clear(); Messages.Clear(); ReplyMembers.Clear(); }
        Changed(nameof(OwnerName)); Changed(nameof(AuthMode)); Changed(nameof(OnlineSummary));
        if (!keep) HasMore = false;
        Loading = false;
        Changed(nameof(Selected)); Changed(nameof(HasSelection)); Changed(nameof(Connected)); Changed(nameof(EditLabel)); Changed(nameof(CanShowScreen)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(Server)); DraftChanged();
        ConnectionError = null;
        ConnectionRetryable = true;
        NeedsLogin = false;
        ActionError = null;
        ConnectionStatus = CoreStrings.Workspace_ConnectAsync_2;
        var current = api;
        current.AuthenticationRequired += () => { if (api == current) NeedsLogin = true; };
        var token = connection.Token;
        try
        {
            if (prepareConnection is not null) await prepareConnection(origin);
            token.ThrowIfCancellationRequested();
            var session = await current.GetAsync<SessionInfo>("/api/session", token);
            AuthMode = session.AuthMode; Login = session.Login; Changed(nameof(AuthMode)); Changed(nameof(Login));
            if (!session.Authenticated) { ConnectionRetryable = false; NeedsLogin = session.AuthMode == "cloudflare" || SessionLoginRequired; throw new BellApiException(SessionLoginRequired ? CoreStrings.Workspace_ConnectAsync_3 : NeedsLogin ? CoreStrings.BellApi_RawAsync_1 : CoreStrings.Workspace_ConnectAsync_5); }
            await RefreshAsync(current, token);
            ready = true; Changed(nameof(Connected));
            ConnectionStatus = CoreStrings.Workspace_ConnectAsync_6;
            if (listen) _ = ListenAsync(current, token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        // a485 (app-sessions.md 7a): the server cannot judge a session right now (restart, rollback). The stored token stays; the page retries on the backoff.
        catch (BellApiException unavailable) when (unavailable.Code == "SESSION_STORE_UNAVAILABLE") { if (api == current) { ConnectionError = CoreStrings.SignIn_ServerNotReady_1; ConnectionStatus = CoreStrings.Workspace_ConnectAsync_8; } }
        catch (Exception error) { if (api == current) { if (error is BellApiException { RequiresLogin: true }) ConnectionRetryable = false; ConnectionError = error.Message; ConnectionStatus = CoreStrings.Workspace_ConnectAsync_8; } }
    }

    // Trony 11-08: only cancel, sign-out and a refused login stop; every other failure is shown and reconnects on the backoff (the Mac stops on a malformed stream).
    private static string? ReconnectText(Exception error) => error switch
    {
        BellApiException { RequiresLogin: true } => null,
        BellApiException { Code: BellApiException.StreamEndedCode } => BellApiException.StreamEndedMessage,
        BellApiException { Status: { } status } when (int)status == 429 || (int)status >= 500 => BellApiException.ConnectFailedMessage,
        // The 30 s handshake limit cancels without our token being cancelled: that is a connection failure too.
        System.Net.Http.HttpRequestException or IOException or OperationCanceledException => BellApiException.ConnectFailedMessage,
        _ => CoreStrings.Workspace_ReconnectText_1(BellApiException.ConnectFailedMessage, error.Message)
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
                    ConnectionStatus = CoreStrings.Workspace_ListenAsync_1;
                    var typeName = item.TryGetProperty("type", out var type) && type.ValueKind == System.Text.Json.JsonValueKind.String ? type.GetString() : null;
                    if (typeName == "updates") UpdatesChanged?.Invoke();
                    else if (typeName is not null && (typeName.StartsWith("login.") || typeName.StartsWith("session."))) LoginEvent?.Invoke();
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
                ConnectionStatus = reconnecting is null ? CoreStrings.Workspace_ListenAsync_2 : CoreStrings.Workspace_ListenAsync_3;
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
            var seat = await current.SeatApprovalsAsync(token);
            if (selected is { Target.IsRoom: true })
            {
                // An optional setting: its failure must not fail the list refresh.
                try { await LoadRoutingAsync(current, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception error) { SetRouting(null); ActionError = CoreStrings.Workspace_RefreshAsync_1(error.Message); }
            }
            token.ThrowIfCancellationRequested();
            Owner = owner.Owner; OwnerName = owner.Owner.Name; Changed(nameof(OwnerName));
            if (AccountsBanner != accountsBanner) { AccountsBanner = accountsBanner; Changed(nameof(AccountsBanner)); }
            queue = activity.Items;
            var previous = all.ToDictionary(entry => entry.Target);
            // Working is currentWork.state only, the same source as the work graph: turns started by a schedule or the member's own continuation have no running delivery.
            all = bots.Bots.Select(bot => new ConversationEntry(new(bot.Id, false), bot.DisplayName, CurrentWork.Label(bot.CurrentWork), bot.Recent?.At ?? DateTimeOffset.MinValue, bot, null, Server, bot.CurrentWork?.State == "working", seat.FirstOrDefault(item => item.BotId == bot.Id)))
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
            seatApprovals = seat; SeatApprovalsChanged?.Invoke();
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
            .OrderByDescending(item => item.Target.IsRoom).ThenBy(item => item.Bot?.PinnedAt ?? DateTimeOffset.MaxValue).ThenBy(item => item.Pinned ? item.Target.Id : "", StringComparer.Ordinal).ThenByDescending(item => item.RecentAt)) Entries.Add(entry);
    }

    public async Task SelectAsync(ConversationEntry entry)
    {
        SaveReplyMembers();
        ReturnToProfile();
        selection?.Cancel(); selection?.Dispose();
        selection = connection is null ? new CancellationTokenSource() : CancellationTokenSource.CreateLinkedTokenSource(connection.Token);
        var token = selection.Token;
        selected = entry; olderRead = null;
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
            var page = await api.GetAsync<MessagePage>(entry.Target.Path + "/messages?limit=" + HistoryPaging.FirstPageLimit, token);
            token.ThrowIfCancellationRequested();
            // The cards created for this first page enter with the staggered opening animation; later arrivals use the short one.
            Opening = true; afterFirstRender(() => Opening = false);
            ShowMessages(page.Items);
            HasMore = page.HasMore;
            ScrollToBottom?.Invoke(true);
            if (entry.Target.IsRoom)
            {
                try { await LoadRoutingAsync(api, token); }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { }
                catch (Exception error) { if (!token.IsCancellationRequested) { SetRouting(null); ActionError = CoreStrings.Workspace_RefreshAsync_1(error.Message); } }
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
        var page = await current.GetAsync<MessagePage>(target.Path + "/messages?limit=10", token);
        var after = last is null ? Array.Empty<TimelineMessage>()
            : (await current.GetAsync<MessagePage>(target.Path + "/messages?after=" + Uri.EscapeDataString(last), token)).Items;
        if (selected?.Target != target || Loading || api != current || selection != activeSelection) return;
        var merged = Timeline.Merge(Received(), page.Items.Concat(after));
        ShowMessages(merged);
        if (last is null) HasMore = page.HasMore;
        if (page.Items.Length != 0 && (last is null || merged.LastOrDefault()?.Id != last)) ScrollToBottom?.Invoke(false);
    }

    // The server history as the list holds it: everything except the local echoes.
    private TimelineMessage[] Received() => Timeline.Expand(Messages.Select(item => item.Message)).Where(message => !PendingSend.IsLocal(message.Id)).ToArray();

    // Mac visibleMessages: puts the list to "received history, then the echoes the history does not have yet", keeping the rows (and their loaded images) that stay.
    private void ShowMessages(TimelineMessage[] received)
    {
        if (selected is not { } entry) return;
        var key = (Server, entry.Target);
        var pending = PendingSend.Reconcile(pendingSends.GetValueOrDefault(key) ?? [], received);
        if (pending.Count == 0) pendingSends.Remove(key); else pendingSends[key] = pending;
        var desired = Timeline.VisibleMachine(PendingSend.Visible(received, pending));
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

    // One older request at a time (machine-stream.md "History pages of a long stream"): a caller that comes while one is on its way waits for that one.
    // The read does not set Loading, so a background read never turns the send button off.
    // a471-scroll-jump: rows that land above the view must not move it. The app reads its scroll position in OlderRowsAdding and restores it in OlderRowsAdded; both run on the UI thread
    // around the one change, so a scroll the Owner made while the page was on its way is kept (the position read when the request started would undo it).
    public event Action? OlderRowsAdding, OlderRowsAdded;
    private Task? olderRead;
    public Task LoadOlderAsync() => olderRead is { IsCompleted: false } running ? running : olderRead = ReadOlderAsync();
    private async Task ReadOlderAsync()
    {
        if (api is null || selected is null || Received().FirstOrDefault() is not { } first || Loading) return;
        var target = selected.Target;
        var token = selection!.Token;
        try
        {
            var page = await api.GetAsync<MessagePage>(target.Path + "/messages?limit=" + HistoryPaging.OlderPageLimit + "&before=" + Uri.EscapeDataString(first.Id) + "&before_at=" + HistoryPaging.BeforeAt(first.At), token);
            token.ThrowIfCancellationRequested();
            // Folded rows are drawn again from the whole list, so a run split by the page edge becomes one line.
            var loaded = Received(); var known = loaded.Select(message => message.Id).ToHashSet();
            OlderRowsAdding?.Invoke();
            ShowMessages([.. page.Items.Where(message => !known.Contains(message.Id)), .. loaded]);
            OlderRowsAdded?.Invoke();
            HasMore = page.HasMore;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (!token.IsCancellationRequested) ConnectionError = error.Message; }
    }

    // Forward one message of the open conversation to another Bot or room, with an optional comment of the Owner's own. Returns null when it was accepted,
    // else the refusal in plain words (nothing was sent then). The destination's own screen is read again when it is the one open.
    public async Task<string?> ForwardAsync(TimelineMessage message, ChatTarget destination, string comment)
    {
        if (api is null || connection is null || selected is null || !Timeline.IsForwardable(message)) return CoreStrings.Workspace_ForwardAsync_1;
        var current = api; var token = connection.Token; var from = selected.Target;
        try { await current.SendAsync(destination, comment.Trim(), [], null, token, forward: new ForwardSource(from.IsRoom ? "room" : "bot", from.Id, message.Id)); }
        catch (BellApiException error) when (error.Status is not null) { return Timeline.ForwardRefusal(error); }
        catch (Exception error) { return (BellApiException.IsResultUnconfirmed(error) ? CoreStrings.Workspace_ForwardAsync_2 : "") + error.Message; }
        if (api == current && selected?.Target == destination) { try { await RefreshAsync(current, token); } catch (OperationCanceledException) when (token.IsCancellationRequested) { } catch (Exception error) { if (api == current) ConnectionError = CoreStrings.Workspace_ForwardAsync_3(error.Message); } }
        return null;
    }

    // Share content from another app to a chosen Bot or room with an optional comment. Returns null when accepted, else the refusal in plain words.
    // It needs no open conversation (the share window has none); an open destination is read again.
    public async Task<string?> ShareAsync(ChatTarget destination, string comment, ShareContent content, ImageAttachment[] images)
    {
        if (api is null || connection is null) return CoreStrings.Workspace_ShareAsync_1;
        if (!content.HasContent(images.Length)) return CoreStrings.Workspace_ShareAsync_2;
        var current = api; var token = connection.Token;
        try { await current.SendAsync(destination, comment.Trim(), images, null, token, share: content); }
        catch (BellApiException error) when (error.Status is not null) { return Timeline.ShareRefusal(error); }
        catch (Exception error) { return (BellApiException.IsResultUnconfirmed(error) ? CoreStrings.Workspace_ForwardAsync_2 : "") + error.Message; }
        if (api == current && selected?.Target == destination) { try { await RefreshAsync(current, token); } catch (OperationCanceledException) when (token.IsCancellationRequested) { } catch (Exception error) { if (api == current) ConnectionError = CoreStrings.Workspace_ShareAsync_4(error.Message); } }
        return null;
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
        var key = (Server, target); var echo = new PendingSend(PendingSend.NewId(), content.Text, content.Images.Length, DateTimeOffset.Now, ReplyTo: content.Quote);
        ChangePending(key, null, echo);
        if (selected?.Target == target) ScrollToBottom?.Invoke(true);
        try
        {
            var acceptedId = await current.SendAsync(target, content.Text, content.Images, target.IsRoom && content.Targets.Length != 0 ? content.Targets : null, token, content.Quote?.Id, content.Selection);
            foreach (var image in content.Images) attachmentPreviews.Remove(image);
            if (api == current) ChangePending(key, echo, echo with { AcceptedId = acceptedId });
            draft.CompleteSend(); DraftChanged();
        }
        catch (Exception error)
        {
            if (api == current) ChangePending(key, echo, null);
            draft.FailSend(content, (BellApiException.IsResultUnconfirmed(error) ? CoreStrings.Workspace_ForwardAsync_2 : "") + error.Message);
            DraftChanged();
            return;
        }
        try { await RefreshAsync(current, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) { if (api == current) ConnectionError = CoreStrings.Workspace_SendAsync_2(error.Message); }
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
        catch (Exception error) { ActionError = CoreStrings.Workspace_RefreshManagementAsync_1(error.Message); }
    }
    // Mac requestBotDeletion / confirmBotDeletion: DELETE answers 202 (accepted only). The member counts as deleting until a list read no longer has it.
    private readonly HashSet<string> pendingBotDeletions = [];
    public bool BotDeletionPending(string id) => pendingBotDeletions.Contains(id);
    // Render seam: the state a 202 from DELETE leaves while the member is still listed.
    public void SetBotDeletionPendingForRender(string id) { pendingBotDeletions.Add(id); RosterChanged?.Invoke(); }
    public bool HasBot(string id) => all.Any(entry => entry.Target == new ChatTarget(id, false));
    // a480: PATCH /api/bots/:id {pinned}; the roster is read again so the order comes from the server's pinnedAt. A failed read-back is reported, never a failed pin.
    public async Task SetPinnedAsync(string id, bool pinned)
    {
        await Management.SetPinnedAsync(id, pinned, ConnectionToken);
        await RefreshManagementAsync();
    }
    public async Task RequestBotDeletionAsync(string id)
    {
        await Management.DeleteBotAsync(id, ConnectionToken);
        if (HasBot(id)) { pendingBotDeletions.Add(id); RosterChanged?.Invoke(); }
    }
    // A read only. Throws when the list cannot be read; the caller keeps the member as pending then.
    public async Task<bool> ConfirmBotDeletionAsync(string id)
    {
        if (api is null || connection is null) throw new BellApiException(CoreStrings.Workspace_connectionStatus_1);
        await RefreshAsync(api, connection.Token);
        return !HasBot(id);
    }
    private readonly Dictionary<(string, string), AvatarImageSession> imageSessions = [];
    // One per member and server: a selection kept after an unconfirmed save outlives the inspector and its sheet (Mac store.profileImageDrafts).
    public AvatarImageSession ImageSession(string botId) { if (!imageSessions.TryGetValue((Server, botId), out var session)) imageSessions[(Server, botId)] = session = new(); return session; }
    public string? AvatarVersion(string botId, AvatarVariant variant) => all.FirstOrDefault(entry => entry.Target == new ChatTarget(botId, false))?.Bot is { } bot ? variant == AvatarVariant.Small ? bot.AvatarVersion : bot.AvatarLargeVersion : null;
    // Unlike RefreshManagementAsync this throws: the image save flow must know whether the roster caught up.
    public Task RefreshForImageAsync() => api is null || connection is null ? Task.CompletedTask : RefreshAsync(api, connection.Token);
    public Task<TImage> AvatarAsync(string url)
    {
        if (avatars.TryGetValue(url, out var existing)) return existing;
        async Task<TImage> Load() => await codec.DecodeAsync(await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).ImageAsync(url, ConnectionToken));
        var task = Load(); avatars[url] = task; return task;
    }
    public async Task AttachFilesAsync(string[] paths)
    {
        if (Draft is not { } draft) return;
        if (draft.Attaching) { ActionError = CoreStrings.Workspace_AttachFilesAsync_1; return; }
        var key = (Server, selected!.Target);
        draft.Attaching = true; ActionError = null; DraftChanged();
        try
        {
            var loaded = new List<(ImageAttachment Data, TImage Preview)>();
            foreach (var path in paths) loaded.Add(await codec.ReadAsync(path));
            if (!drafts.TryGetValue(key, out var current) || current != draft) return;
            foreach (var image in loaded) { attachmentPreviews[image.Data] = image.Preview; draft.Attachments.Add(image.Data); }
        }
        catch (Exception error) { ActionError = CoreStrings.Workspace_AttachFilesAsync_2(error.Message); }
        finally { draft.Attaching = false; DraftChanged(); }
    }
    public void AttachClipboardImage(TImage bitmap)
    {
        if (Draft is not { } draft) return;
        if (draft.Attaching) { ActionError = CoreStrings.Workspace_AttachFilesAsync_1; return; }
        var (png, previewImage) = codec.Pasted(bitmap);
        var data = new ImageAttachment(CoreStrings.Workspace_AttachClipboardImage_2, "image/png", png);
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
        catch (Exception error) { ActionError = CoreStrings.Workspace_ExportAsync_1(error.Message); }
    }
    public async Task<byte[]> ImageAsync(string path, CancellationToken token)
    {
        if (preview) return PreviewImagePng.ToArray();
        return await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).ImageAsync(path, token);
    }
    // The preview's 2x2 lilac/sand checker as PNG (was encoded from a WPF bitmap; now fixed bytes so Core stays UI-free).
    private static readonly byte[] PreviewImagePng = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0, 114, 182, 13, 36, 0, 0, 0, 22, 73, 68, 65, 84, 120, 156, 99, 120, 54, 109, 203, 255, 105, 251, 46, 253, 103, 0, 17, 32, 14, 0, 112, 66, 12, 169, 254, 53, 102, 152, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
    public async Task<SecretRequest> FinishSecretAsync(string id, SecretSubmission? submission) => await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).FinishSecretAsync(id, submission, connection!.Token);
    public async Task<OnePasswordKey[]?> SecretKeysAsync(string id) => await new SecretRequestApi(api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).KeysAsync(id, connection!.Token);
    // The stored raw line of an entry whose text was cut (machine-stream.md).
    public async Task<string> MachineLineAsync(string botId, int seq) => (await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).GetAsync<MachineLine>($"/api/bots/{Uri.EscapeDataString(botId)}/machine-events/{seq}", connection!.Token)).Line;
    public async Task<MachineRequest> AnswerSeatRequestAsync(string id, MachineAnswer[]? answers, string? decision) => await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).AnswerSeatRequestAsync(id, answers, decision, connection!.Token);
    public async Task<OwnerQuestion> AnswerAsync(string id, string? choice, string? text) => await (api ?? throw new BellApiException(CoreStrings.Workspace_connectionStatus_1)).AnswerAsync(id, choice, text, connection!.Token);
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
        SetScreen("", false, null, false); Changed(nameof(ScreenInput)); ScreenVisible = true;
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
                    SetScreen(next, result.Online, null, result.Machine);
                    await input.RefreshApprovalAsync(token);
                    firstRead.TrySetResult();
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
                // BellApi has already raised AuthenticationRequired (the login button); the screen just stops.
                catch (BellApiException error) when (error.RequiresLogin) { firstRead.TrySetResult(); break; }
                // A transient failure (timeout, 5xx, seat restart) must not freeze an open screen: show it, read again next tick; the next 200 clears it.
                catch (Exception error) { SetScreen(screenRaw, screenOnline, error.Message, screenMachine); firstRead.TrySetResult(); }
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
        connection?.Cancel(); selection?.Cancel(); ReturnToProfile(); ready = false; selected = null; stoppingBotId = null; stopResult = null; loadFailed = false; routingEnabled = null; terminals = null;
        all.Clear(); queue = []; Entries.Clear(); Messages.Clear(); ReplyMembers.Clear(); drafts.Clear(); pendingSends.Clear(); attachmentPreviews.Clear(); avatars.Clear(); Owner = null; OwnerName = CoreStrings.Approvals_HistoryRows_1; AccountsBanner = ""; Changed(nameof(AccountsBanner));
        HasMore = false; Loading = false; ConnectionError = ActionError = null; NeedsLogin = AuthMode == "cloudflare" || SessionLoginRequired; ConnectionStatus = CoreStrings.Workspace_SignOut_2;
        foreach (var name in new[] { nameof(Connected), nameof(Selected), nameof(HasSelection), nameof(IsRoom), nameof(Title), nameof(Profile), nameof(OwnerName), nameof(OnlineSummary), nameof(ActivityText), nameof(HasActivity), nameof(ActivityRows), nameof(StopEnabled), nameof(CurrentBotCanStop), nameof(StopResult), nameof(LoadFailed), nameof(RoutingEnabled), nameof(ReplyTargetLabel), nameof(CanShowScreen) }) Changed(name);
        DraftChanged();
    }
    public void LoadPreview()
    {
        preview = true;
        all = [new(new("preview", false), CoreStrings.Workspace_LoadPreview_1, CoreStrings.Workspace_LoadPreview_2, DateTimeOffset.Now,
            new Bot { Id = "preview", Name = CoreStrings.Workspace_LoadPreview_1, DisplayName = CoreStrings.Workspace_LoadPreview_1, Online = true, Position = CoreStrings.Workspace_LoadPreview_5, ProfileText = CoreStrings.Workspace_LoadPreview_6, Role = CoreStrings.Workspace_LoadPreview_7 }, null,
            SeatApproval: new SeatApproval { Id = "sa-preview-0000000000000000-1", BotId = "preview", BotName = CoreStrings.Workspace_LoadPreview_1, Harness = "codex", Tool = "Bash", Command = "git push --force origin main", Reason = CoreStrings.Workspace_LoadPreview_9, Since = DateTimeOffset.Now })];
        seatApprovals = all.Select(entry => entry.SeatApproval).OfType<SeatApproval>().ToArray(); SeatApprovalsChanged?.Invoke();   // the seat-approval entry of the preview (--render-preview)
        Filter(); ConnectionStatus = CoreStrings.Workspace_LoadPreview_10;
    }
    private static TimelineMessage[] PreviewMessages() => [
        new() { Id = "preview1", At = DateTimeOffset.Now, Direction = "outgoing", Message = CoreStrings.Workspace_PreviewMessages_1 },
        new() { Id = "preview2", At = DateTimeOffset.Now, Direction = "incoming", Message = CoreStrings.Workspace_PreviewMessages_2, Image = true, ImageUrls = ["/api/message-images/user/preview.png"] },
        new() { Id = "preview-secret", At = DateTimeOffset.Now, SecretRequest = new() { Id = "preview-secret", BotId = "preview", ToolId = "test", Label = CoreStrings.Workspace_PreviewMessages_3, Message = CoreStrings.Workspace_LoadPreview_6, Status = "pending" } },
        new() { Id = "preview-question", At = DateTimeOffset.Now, OwnerQuestion = new() { Id = "preview-question", BotId = "preview", Question = CoreStrings.Workspace_PreviewMessages_5, Options = [CoreStrings.Workspace_PreviewMessages_6, CoreStrings.Workspace_PreviewMessages_7], AllowOther = true, Status = "open" } }
    ];
    public void Dispose() { ReturnToProfile(); connection?.Cancel(); selection?.Cancel(); connection?.Dispose(); selection?.Dispose(); api?.Dispose(); api = null; attachmentPreviews.Clear(); avatars.Clear(); drafts.Clear(); }
}

public sealed record ActivityRow(string Text, string? StopBotId, string Name, bool Stopping) { public string StopLabel => Stopping ? CoreStrings.Workspace_StopLabel_1 : CoreStrings.StoreAccount_StopAllOthersConfirm_1; }
public sealed record AttachmentPreview<TImage>(ImageAttachment Data, TImage Preview, int Number = 0) { public string Name => Data.Name; public string RemoveLabel => CoreStrings.Workspace_RemoveLabel_1(Number); }

public sealed class MemberChoice(string id, string name, bool selected)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public bool Selected { get; set; } = selected;
}
