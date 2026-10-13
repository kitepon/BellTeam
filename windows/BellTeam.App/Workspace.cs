using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using BellTeam.Core;

namespace BellTeam.App;

public sealed record ConversationEntry(ChatTarget Target, string Name, string Subtitle, DateTimeOffset RecentAt, Bot? Bot, Room? Room)
{
    public string Group => Target.IsRoom ? "ルーム" : "メンバー";
    public string Initial => Name.Length == 0 ? "?" : System.Globalization.StringInfo.GetNextTextElement(Name);
    public string Presence => Bot is { Online: true } ? "●" : "";
}

public sealed class Workspace : INotifyPropertyChanged, IDisposable
{
    private readonly Func<Uri, BellApi> apiFactory;
    public Workspace(Func<Uri, BellApi>? apiFactory = null) => this.apiFactory = apiFactory ?? (origin => new BellApi(origin));
    private BellApi? api;
    private CancellationTokenSource? connection;
    private CancellationTokenSource? selection;
    private readonly Dictionary<(string, ChatTarget), ConversationDraft> drafts = [];
    private readonly SemaphoreSlim refreshLock = new(1);
    private List<ConversationEntry> all = [];
    private string search = "";
    private string? connectionError;
    private string connectionStatus = "接続先を設定してください。";
    private ConversationEntry? selected;
    private bool hasMore;
    private bool loading;
    private bool preview;
    public ObservableCollection<ConversationEntry> Entries { get; } = [];
    public ObservableCollection<TimelineMessage> Messages { get; } = [];
    public string Search { get => search; set { search = value; Changed(); Filter(); } }
    public string? ConnectionError { get => connectionError; private set { connectionError = value; Changed(); } }
    public string ConnectionStatus { get => connectionStatus; private set { connectionStatus = value; Changed(); } }
    public ConversationEntry? Selected => selected;
    public bool IsRoom => selected?.Target.IsRoom == true;
    public string Title => selected?.Name ?? "チームと、同じデスクで。";
    public string Server => api?.Origin.AbsoluteUri ?? "";
    public bool HasMore { get => hasMore; private set { hasMore = value; Changed(); } }
    public bool Loading { get => loading; private set { loading = value; Changed(); Changed(nameof(CanSend)); } }
    private ConversationDraft? Draft => selected is null ? null : drafts.GetValueOrDefault((Server, selected.Target));
    public string DraftText { get => Draft?.Text ?? ""; set { if (Draft is { } draft) draft.Text = value; Changed(); Changed(nameof(CanSend)); } }
    public string? SendError => Draft?.Error;
    public string SendLabel => Draft?.Sending == true ? "送信中…" : "送信";
    public bool CanSend => api is not null && selected is not null && !Loading && Draft is { Sending: false } draft && !string.IsNullOrWhiteSpace(draft.Text);
    public ObservableCollection<MemberChoice> ReplyMembers { get; } = [];
    public string Profile => selected?.Bot is { } bot
        ? $"{bot.DisplayName}\n{(bot.Online ? "オンライン" : "オフライン")}\n\nプロフィール\n\n役職\n{Empty(bot.Position)}\n\n背景・見た目・関係性\n{Empty(bot.ProfileText)}\n\n性格・考え方\n{Empty(bot.Personality)}\n\n口調\n{Empty(bot.SpeechStyle)}\n\n担当する仕事\n{Empty(bot.Role)}\n\nAI\nハーネス: {bot.Harness}\nモデル: {Empty(bot.Model, "既定")}"
        : selected?.Room is { } room ? $"{room.Name}\n\nこの部屋で共有する仕事\n{Empty(room.Purpose)}\n\n参加メンバー\n{string.Join('\n', room.MemberIds.Select(id => all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id))}" : "左のメンバーやルームを選んで、会話を始めましょう。";
    private static string Empty(string value, string replacement = "未設定") => string.IsNullOrWhiteSpace(value) ? replacement : value;
    public event PropertyChangedEventHandler? PropertyChanged;
    public event Action<bool>? ScrollToBottom;
    private void Changed([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    private void DraftChanged() { Changed(nameof(DraftText)); Changed(nameof(SendError)); Changed(nameof(SendLabel)); Changed(nameof(CanSend)); }

    public async Task ConnectAsync(string address, bool listen = true)
    {
        var origin = ServerOrigin.Parse(address);
        SaveReplyMembers();
        connection?.Cancel();
        selection?.Cancel();
        api?.Dispose();
        connection?.Dispose();
        api = apiFactory(origin);
        connection = new CancellationTokenSource();
        selected = null;
        all.Clear(); Entries.Clear(); Messages.Clear(); ReplyMembers.Clear();
        HasMore = false;
        Loading = false;
        Changed(nameof(Selected)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); Changed(nameof(Server)); DraftChanged();
        ConnectionError = null;
        ConnectionStatus = "接続を確認しています…";
        var current = api;
        var token = connection.Token;
        try
        {
            var session = await current.GetAsync<SessionInfo>("/api/session", token);
            if (!session.Authenticated) throw new BellApiException("Cloudflare Accessへログインしてください。Windows版の外部ログインは次の段階で対応します。");
            await RefreshAsync(current, token);
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
                if (item.EnumerateObject().Any()) await RefreshAsync(current, token);
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
            var bots = await current.GetAsync<BotsResponse>("/api/bots", token);
            var rooms = await current.GetAsync<RoomsResponse>("/api/rooms", token);
            token.ThrowIfCancellationRequested();
            all = bots.Bots.Select(bot => new ConversationEntry(new(bot.Id, false), bot.DisplayName, bot.Recent?.Preview ?? bot.Position, bot.Recent?.At ?? DateTimeOffset.MinValue, bot, null))
                .Concat(rooms.Rooms.Select(room => new ConversationEntry(new(room.Id, true), room.Name, room.Recent?.Preview ?? room.Purpose, room.Recent?.At ?? DateTimeOffset.MinValue, null, room))).ToList();
            Filter();
            if (selected is { } active)
            {
                selected = all.FirstOrDefault(item => item.Target == active.Target);
                Changed(nameof(Selected)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile));
                if (selected is not null) await RefreshMessagesAsync(current, selected.Target, token);
                else { selection?.Cancel(); Messages.Clear(); ReplyMembers.Clear(); HasMore = false; DraftChanged(); }
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
        selection?.Cancel(); selection?.Dispose();
        selection = connection is null ? new CancellationTokenSource() : CancellationTokenSource.CreateLinkedTokenSource(connection.Token);
        var token = selection.Token;
        selected = entry;
        if (!drafts.ContainsKey((Server, entry.Target))) drafts[(Server, entry.Target)] = new ConversationDraft();
        Messages.Clear(); HasMore = false;
        ReplyMembers.Clear();
        foreach (var id in entry.Room?.MemberIds ?? [])
            ReplyMembers.Add(new MemberChoice(id, all.FirstOrDefault(item => item.Target == new ChatTarget(id, false))?.Name ?? id, Draft!.Targets.Contains(id)));
        Changed(nameof(Selected)); Changed(nameof(IsRoom)); Changed(nameof(Title)); Changed(nameof(Profile)); DraftChanged();
        if (preview) { foreach (var item in PreviewMessages()) Messages.Add(item); return; }
        if (api is null) return;
        Loading = true;
        try
        {
            var page = await api.GetAsync<MessagePage>(entry.Target.Path + "/messages?limit=30", token);
            token.ThrowIfCancellationRequested();
            foreach (var message in page.Items) Messages.Add(message);
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
        var last = Messages.LastOrDefault()?.Id;
        var page = await current.GetAsync<MessagePage>(target.Path + "/messages?limit=30", token);
        var after = last is null ? Array.Empty<TimelineMessage>()
            : (await current.GetAsync<MessagePage>(target.Path + "/messages?after=" + Uri.EscapeDataString(last), token)).Items;
        if (selected?.Target != target || Loading || api != current || selection != activeSelection) return;
        var merged = Timeline.Merge(Messages, page.Items.Concat(after));
        for (var index = 0; index < merged.Length; index++)
        {
            if (index == Messages.Count) Messages.Add(merged[index]);
            else if (Messages[index] != merged[index]) Messages[index] = merged[index];
        }
        if (last is null) HasMore = page.HasMore;
        if (page.Items.Length != 0) ScrollToBottom?.Invoke(false);
    }

    public async Task LoadOlderAsync()
    {
        if (api is null || selected is null || Messages.FirstOrDefault() is not { } first || Loading) return;
        var target = selected.Target;
        var token = selection!.Token;
        Loading = true;
        try
        {
            var page = await api.GetAsync<MessagePage>(target.Path + "/messages?limit=30&before=" + Uri.EscapeDataString(first.Id), token);
            token.ThrowIfCancellationRequested();
            var existing = Messages.Select(item => item.Id).ToHashSet();
            for (var index = page.Items.Length - 1; index >= 0; index--) if (existing.Add(page.Items[index].Id)) Messages.Insert(0, page.Items[index]);
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
        var text = draft.BeginSend(); DraftChanged();
        var token = connection!.Token;
        try
        {
            await current.SendAsync(target, text, target.IsRoom && draft.Targets.Length != 0 ? draft.Targets : null, token);
            draft.CompleteSend(); DraftChanged();
            if (selected?.Target == target && api == current) ScrollToBottom?.Invoke(true);
        }
        catch (Exception error)
        {
            var uncertain = error is not BellApiException { Status: not null } || (int)((error as BellApiException)?.Status ?? 0) >= 500;
            draft.FailSend(text, (uncertain ? "操作の結果を確認できませんでした。再操作する前に、現在の状態を更新して確認してください。\n" : "") + error.Message);
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
        new() { Id = "preview2", At = DateTimeOffset.Now, Direction = "incoming", Message = "## 同じデスクで\n**会話の本文を選択してコピー**できます。\n\n- 一覧からメンバーを選ぶ\n- 会話ごとに下書きを保持する\n\n> 確かめた事を、そのまま伝える。\n\n```csharp\nawait api.GetAsync(\"/api/session\");\n```\n\n| 操作 | キー |\n| --- | --- |\n| 検索 | Ctrl+K |\n| 改行 | Shift+Enter |" }
    ];
    public void Dispose() { connection?.Cancel(); selection?.Cancel(); connection?.Dispose(); selection?.Dispose(); api?.Dispose(); }
}

public sealed class MemberChoice(string id, string name, bool selected)
{
    public string Id { get; } = id;
    public string Name { get; } = name;
    public bool Selected { get; set; } = selected;
}
