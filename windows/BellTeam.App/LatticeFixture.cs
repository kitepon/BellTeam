using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace BellTeam.App;

/// <summary>
/// Render seam for the 工程表 window (--render-lattice): an in-process server in the lattice module's app contract shape, with the same charts as the Apple fixture
/// (test/helpers/lattice-ui-server.mjs on Rapi's branch). Times are relative to now. Scenes pick the state, the list, the stream, an unknown producer and
/// authored lanes (「authored」: cards nobody started carry the plan's lane text and no producer, as production plans write kiro / anis / root).
/// Every scene carries phases (one untitled) and one nested card (t05 under t04) for the tree; t11 has no phase and hangs from the chart.
/// 「owner」: t11 belongs to the Owner (producer = the reserved value owner, as the server resolves a lane 指揮官 / owner); its 詳細 shows the Approval Box decision (GET /api/approvals/by-task answers only there, 404 elsewhere as before the extension ships).
/// Finished cards carry doneAt (t03 none) and archived per the server rule: t02 and t03 are archived, t01 (its next card t07 is unstarted) is not. counted (a96): every card but t03, the only card of its finished tree; t02 is hidden but its tree is open.
/// ブロック一覧 scenes (stops*): GET /api/lattice/blockers has five stops on four charts (a member, the Owner, an authored lane, an unknown Bot, no lane; today,
/// yesterday, an older day); stops-unread names an unread chart, stops-empty none, stops-retry answers 503, stops-old 404; 外す removes, stops-refused answers 409.
/// 接続 (a161; every scene, the 「connections」 scene opens the panel): cards carry `connections` and no edge or wait is sent for them. t10 connects to two tasks of other charts (one read: 通話ブリッジの刷新, Kiro, in progress; one Lattice could not read),
/// t08 carries a 優先接続 asked by Rapi, t09 a schedule 接続. `externals[]` holds the other charts' facts for the two `task` entries.
/// </summary>
internal sealed class LatticeFixture(string scene) : HttpMessageHandler
{
    private static readonly (string Id, string Name, string Color)[] Members = [("bot-trony", "トロニー", "indigo"), ("bot-molly", "モリー", "mint"), ("bot-kiro", "キロ", "sky"), ("bot-admi", "アドミ", "amber"), ("bot-rapi", "ラピ", "rose"), ("bot-flora", "フローラ", "violet")];
    // 「history」 scenes (a457): the snapshot says history.closed and GET .../history serves these finished cards of closed trees in pages of two (cursor "h1.2" = the second page); history-failed answers 503 for the first page.
    private static readonly (string Id, string Title, string Producer, int DaysAgo)[] ClosedCards = [("c01", "閉じたツリーの最後の確認", "bot-flora", 2), ("c02", "古い設計メモの整理", "bot-admi", 3), ("c03", "旧い組込案の取り下げ", "bot-kiro", 9)];
    private object HistoryPage(string? before, Func<object, HttpStatusCode, HttpResponseMessage> json)
    {
        var skip = before == "h1.2" ? 2 : 0; var cards = ClosedCards.Skip(skip).Take(2).ToArray();
        return new
        {
            schema = "bellteam.lattice-history.v1", projectId = "lattice", at = Ago(0), state = "verified", closed = ClosedCards.Length,
            members = Members.Where(member => cards.Any(card => card.Producer == member.Id)).Select(member => new { botId = member.Id, name = member.Name, color = member.Color, avatarVersion = "" }),
            cards = cards.Select(card => new { id = $"p0/{card.Id}", plan = "p0", taskId = card.Id, title = card.Title, state = "done", lane = "x", producer = card.Producer, startedAt = Ago(card.DaysAgo * 1440 + 60), changedAt = Ago(card.DaysAgo * 1440), blockedReason = (string?)null, depth = 0, phase = (string?)null, parent = (string?)null, doneAt = Ago(card.DaysAgo * 1440), archived = true, counted = false, connections = Array.Empty<object>() }),
            next = skip == 0 ? "h1.2" : null
        };
    }
    private static readonly string[][] Edges = [["t01", "t07"], ["t02", "t04"], ["t04", "t08"], ["t05", "t08"], ["t07", "t08"], ["t08", "t09"], ["t06", "t10"], ["t09", "t11"], ["t10", "t11"]];
    private static readonly (string Id, string? Title, string[] Tasks)[] Phases = [("ph1", "下調べ", ["t01", "t02", "t03"]), ("ph2", "部品", ["t04", "t05", "t06", "t07", "t08"]), ("ph3", null, ["t09", "t10"])];
    private static readonly Dictionary<string, int> Since = new() { ["t06"] = 52, ["t04"] = 41, ["t07"] = 36, ["t05"] = 24, ["t08"] = 18, ["t09"] = 6, ["t10"] = 3 };
    private int streams;
    // 工程表の設定 (reminders API): the saved switch of the chart that is asked, OFF until set. 「reminders-save-fails」 saves the PUT and then answers 503 (an uncertain write); 「reminders-old」 has no reminders route; 「reminders-read-fails」 answers 503 to the first read.
    // list-nudge: 催促 already on for two charts, so the chart list shows the badge on those cards only.
    private readonly Dictionary<string, bool> reminders = scene == "list-nudge" ? new() { ["lattice"] = true, ["call-bridge"] = true } : [];
    private int reminderReads;
    /// <summary>The bodies of the PUTs this server saw, in order (tests count them).</summary>
    internal List<string> ReminderWrites { get; } = [];
    private string State => scene switch { "unverified" => "unverified", "last-verified" => "last_verified", "unavailable" => "unavailable", _ => "verified" };
    private static string Ago(double minutes) => DateTimeOffset.UtcNow.AddMinutes(-minutes).ToString("O");

    private object[] Cards()
    {
        object Card(string id, string title, string state, string? producer, int depth, string done = "", string memo = "", double? started = null, string? reason = null, string? authored = null, double? finished = null, bool archived = false)
            => new { id = $"p1/{id}", plan = "p1", taskId = id, title, state, phase = Phases.FirstOrDefault(phase => phase.Tasks.Contains(id)).Id is { } ph ? $"p1/{ph}" : null, parent = id == "t05" ? "p1/t04" : null, lane = scene == "authored" && authored is not null ? authored : producer, producer = scene == "authored" && authored is not null ? null : producer, depth, doneCondition = done, designMemo = memo, startedAt = started is { } at ? Ago(at) : null, changedAt = Ago(60), blockedReason = reason, doneAt = finished is { } doneAgo ? Ago(doneAgo) : null, archived, counted = id != "t03", connections = Joins(id) };
        // 接続 (README: card `connections`, only open entries): a task of another chart (ref = its externals[] id), a priority (agent) and a schedule (ref = its id).
        object[] Joins(string id) => id switch
        {
            "t10" => [new { kind = "task", state = "open", @ref = "call-bridge:cb/release", reason = "橋の新しい版が出てから", since = Ago(3) }, new { kind = "task", state = "open", @ref = "guide:g/intro", reason = (string?)null, since = Ago(1) }],
            "t08" => [new { kind = "priority", state = "open", agent = "bot-rapi", reason = "受け口が空いたらすぐ着手したい", since = Ago(18) }],
            "t09" => [new { kind = "schedule", state = "open", @ref = "sch-7f3a", reason = "夜間の控えが終わってから", since = Ago(40) }],
            _ => []
        };
        return [
            Card("t01", "決定済み仕様の確認", "done", "bot-flora", 0, "仕様の要点を一覧にする", finished: 95),
            Card("t02", "Latticeの読取口の確認", "done", "bot-flora", 0, "読取の2つの入口を確かめる", finished: 60 * 27, archived: true),
            Card("t03", "旧・組込案の比較", "retired", "bot-admi", 0, archived: true),
            Card("t04", "部品の配置と保存場所", "in-progress", "bot-molly", 1, "配置先と保存先を決定", "部品の置き場と、工程表の保存先を決める。保存先は夜間の控えに入る場所にする。", 12),
            Card("t05", "席へのCLI配布", "in-progress", "bot-kiro", 1, "全席でCLIが使える", started: 4),
            Card("t06", "Web画面の組込口", "blocked", "bot-admi", 1, "Webから工程表を開ける", reason: "組込の登録点が未定"),
            Card("t07", "公開契約の裁定", "ready", "bot-trony", 1, "公開契約が確定する", authored: "root"),
            Card("t08", "部品の実装", "pending", "bot-flora", 2, "契約どおりに動き、席から工程表を読める", "Lattice部品の本体をつくる。公開の入口は裁定済みの契約だけに限り、保存はモリーの配置先を使う。", authored: "kiro"),
            Card("t09", scene == "authored" ? "iPhone/Mac画面の工程表と、接続パネルの横めくり" : "iPhone/Mac画面", "pending", scene == "unknown" ? "bot-ghost" : "bot-rapi", 3, "実画面で承認される", authored: "anis"),
            Card("t10", "Web画面", "pending", "bot-flora", 3, "Webで工程表が開く", authored: "kiro"),
            Card("t11", "受け取り確認", "pending", scene is "owner" or "owner-lanes" ? "owner" : null, 4, "3画面を実画面で承認"),
        ];
    }

    private object Snapshot(string projectId)
    {
        var cards = Cards(); var json = JsonSerializer.SerializeToElement(cards);
        var byId = json.EnumerateArray().ToDictionary(card => card.GetProperty("taskId").GetString()!);
        bool Finished(string id) => byId[id].GetProperty("state").GetString() is "done" or "retired";
        // externals[]: the other chart's facts for each open `task` connection (drawn as text only).
        var externals = new[] { new { id = "call-bridge:cb/release", projectId = "call-bridge", cardId = "cb/release", chartName = (string?)"通話ブリッジの刷新", title = (string?)"橋の新しい版を出す", state = (string?)"in-progress", finished = false, producer = (string?)"bot-kiro" },
                                new { id = "guide:g/intro", projectId = "guide", cardId = "g/intro", chartName = (string?)null, title = (string?)null, state = (string?)null, finished = false, producer = (string?)(scene == "unknown" ? "bot-ghost" : null) } };
        var referenced = byId.Values.Select(card => card.GetProperty("producer").GetString()).Concat(externals.Select(ext => ext.producer)).Append("bot-rapi").ToHashSet();        var name = Names.GetValueOrDefault(projectId);
        return new
        {
            schema = "bellteam.lattice-chart.v1", epoch = "fixture", version = 1, at = Ago(0), projectId, name = name.Name, createdBy = name.CreatedBy, coordinator = projectId == "lattice",
            state = State, verifiedAt = Ago(State == "last_verified" ? 46 : 0), degraded = scene == "degraded" ? new[] { "lattice-read", "members" } : [],
            members = Members.Where(member => referenced.Contains(member.Id)).Select(member => new { botId = member.Id, name = member.Name, color = member.Color, avatarVersion = "" }),
            history = scene.StartsWith("history", StringComparison.Ordinal) ? new { closed = ClosedCards.Length } : null,
            cards, phases = Phases.Select(phase => new { id = $"p1/{phase.Id}", title = phase.Title }), edges = Edges.Select(edge => new { from = $"p1/{edge[0]}", to = $"p1/{edge[1]}", waiting = !Finished(edge[0]) && !Finished(edge[1]) }), externals
        };
    }
    private static readonly Dictionary<string, (string? Name, string CreatedBy)> Names = new()
    {
        ["lattice"] = ("Lattice組込", "bot-trony"), ["nightly-care"] = ("夜間の整備", "bot-molly"), ["call-bridge"] = ("通話ブリッジの刷新", "bot-kiro"), ["web-polish"] = (null, "bot-admi"), ["guide"] = (null, "bot-ghost"),
    };
    private object[] Charts() => scene == "list-empty" ? [] : [
        Summary("lattice", true, 11, 3, 2, 4, 1, ["bot-trony", "bot-molly", "bot-kiro", "bot-admi", "bot-rapi", "bot-flora"], 1),
        Summary("nightly-care", false, 12, 7, 2, 1, 0, ["bot-molly", "bot-kiro", "bot-admi"], 12),
        Summary("call-bridge", false, 8, 3, 1, 2, 0, ["bot-kiro", "bot-molly", "bot-trony", "bot-rapi"], 34),
        Summary("web-polish", false, 11, 9, 1, 0, 0, ["bot-admi", "bot-flora"], 63),
        Summary("guide", false, 9, 4, 1, 2, 0, ["bot-flora", "bot-ghost", "bot-trony"], 14 * 60),
        // list-many (a87, as the Apple fixture's many=1): 30 more charts after the five, so 一覧 runs past the window's bottom.
        .. scene == "list-many" ? Enumerable.Range(1, 30).Select(index => (object)new { projectId = $"extra-{index:00}", name = $"追加の工程表 {index:00}", coordinator = false, createdBy = "bot-rapi", counts = new { total = 6, done = index % 6, working = 1, blocked = 0, connections = 0 }, activeMembers = new[] { "bot-rapi" }, updatedAt = Ago(20 * (index + 1)), state = "verified" }) : [],
    ];
    private object Summary(string id, bool coordinator, int total, int done, int working, int connections, int blocked, string[] active, double updated)
        => new { projectId = id, name = Names[id].Name, coordinator, createdBy = Names[id].CreatedBy, counts = new { total, done, working, blocked, connections }, activeMembers = active, updatedAt = Ago(updated), state = "verified", reminders = reminders.GetValueOrDefault(id) };

    private object Blockers()
    {
        object Stop(string id, string projectId, string task, string title, string? lane, string reason, double ago, string? by)
            => new { stopId = id, projectId, chartName = Names[projectId].Name, chartCreatedBy = Names[projectId].CreatedBy, plan = "p1", taskId = task, cardId = $"p1/{task}", title, lane, reason, blockedAt = Ago(ago), blockedBy = by };
        // Times relative to 12:00 JST today so the rows read 今日 / 昨日 / an older day whenever the scene is drawn.
        var noon = new DateTimeOffset(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(9)).Date, TimeSpan.FromHours(9)).AddHours(12);
        double Before(double hours) => (DateTimeOffset.UtcNow - noon.AddHours(-hours)).TotalMinutes;
        object[] stops = scene == "stops-empty" ? [] : [
            Stop("0a1b2c3d4e5f60718293a4b5", "lattice", "t06", "Web画面の組込口", "bot-admi", "組込の登録点が未定", Before(0), "bot-admi"),
            Stop("1b2c3d4e5f60718293a4b5c6", "nightly-care", "t03", "夜間の控えの保存先を決める", "owner", "Waiting on the Owner: which disk keeps the nightly copy. Nothing the team can do moves it until then.", Before(3), "bot-molly"),
            Stop("2c3d4e5f60718293a4b5c6d7", "call-bridge", "t02", "通話の受け口をBellTeamの席へつなぐ", "kiro", "相手側のトークンが届くまで待つ", Before(26), "owner"),
            Stop("3d4e5f60718293a4b5c6d7e8", "web-polish", "t09", "古い画面の片付け", "bot-ghost", "本体の便の後で行う", Before(24 * 3 + 2), "bot-ghost"),
            Stop("4e5f60718293a4b5c6d7e8f9", "web-polish", "t11", "受け取り確認", null, "担当が決まっていない", Before(24 * 5), null),
        ];
        return new { schema = "bellteam.lattice-blockers.v1", at = Ago(0), blockers = stops, unreadCharts = scene == "stops-unread" ? new[] { "guide" } : [] };
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    {
        var path = request.RequestUri!.AbsolutePath;
        HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
        if (path.StartsWith("/api/lattice/", StringComparison.Ordinal) && scene == "old-server") return Task.FromResult(Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound));
        var response = path switch
        {
            "/api/session" => Json(new { authenticated = true, authMode = "local" }),
            "/api/setup" => Json(new { phase = "ready", complete = true }),
            "/api/bots" => Json(new { bots = Members.Select(member => new { id = member.Id, name = member.Name, displayName = member.Name, color = member.Color }) }),
            "/api/rooms" => Json(new { rooms = Array.Empty<object>() }), "/api/queue" => Json(new { items = Array.Empty<object>() }),
            "/api/owner" => Json(new { owner = new { name = "利用者" } }), "/api/settings" => Json(new { settings = Array.Empty<object>() }),
            "/api/lattice/blockers" => scene switch
            {
                "stops-old" => Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound), "stops-retry" => Json(new { error = "LATTICE_UNAVAILABLE" }, HttpStatusCode.ServiceUnavailable), _ => Json(Blockers())
            },
            _ when path.StartsWith("/api/lattice/charts/", StringComparison.Ordinal) && path.EndsWith("/unblock", StringComparison.Ordinal) && request.Method == HttpMethod.Post => scene == "stops-refused"
                ? Json(new { error = "LATTICE_UNBLOCK_REFUSED", outcome = "refused", code = "TODO_TRANSITION_REFUSED", reason = "この工程はもう取り下げられています。" }, HttpStatusCode.Conflict)
                : Json(new { schema = "bellteam.lattice-unblock.v1", projectId = Uri.UnescapeDataString(path["/api/lattice/charts/".Length..^"/unblock".Length]), stopId = "", outcome = "removed" }),
            "/api/approvals/by-task" when scene == "owner" && request.RequestUri.Query.Contains("task=t11") => Json(new { decisionId = "K-FIXTUR", status = "pending", title = "3画面の受け取りを承認しますか" }),
            _ when path.StartsWith("/api/lattice/charts/", StringComparison.Ordinal) && path.EndsWith("/reminders", StringComparison.Ordinal) => Reminders(request, Uri.UnescapeDataString(path["/api/lattice/charts/".Length..^"/reminders".Length]), Json),
            "/api/lattice/charts" => Json(new { schema = "bellteam.lattice-charts.v1", at = Ago(0), charts = scene == "single" ? Charts().Take(1) : Charts() }),
            _ when path.EndsWith("/messages", StringComparison.Ordinal) => Json(new { items = Array.Empty<object>(), hasMore = false }),
            _ when path.StartsWith("/api/lattice/charts/", StringComparison.Ordinal) && path.EndsWith("/history", StringComparison.Ordinal) && scene.StartsWith("history", StringComparison.Ordinal) =>
                scene == "history-failed" && !request.RequestUri.Query.Contains("before=") ? Json(new { error = "LATTICE_UNAVAILABLE" }, HttpStatusCode.ServiceUnavailable) : Json(HistoryPage(Uri.UnescapeDataString(request.RequestUri.Query).Split("before=") is [_, var cursor] ? cursor : null, Json)),
            _ when path.StartsWith("/api/lattice/charts/", StringComparison.Ordinal) && path.EndsWith("/events", StringComparison.Ordinal) => Events(Uri.UnescapeDataString(path["/api/lattice/charts/".Length..^"/events".Length]), Json),
            _ => Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound)
        };
        return Task.FromResult(response);
    }

    private HttpResponseMessage Reminders(HttpRequestMessage request, string projectId, Func<object, HttpStatusCode, HttpResponseMessage> json)
    {
        if (scene == "reminders-old") return json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound);
        if (!Names.ContainsKey(projectId)) return json(new { error = "LATTICE_CHART_NOT_FOUND" }, HttpStatusCode.NotFound);
        object Saved() => new { schema = "bellteam.lattice-reminders.v1", projectId, enabled = reminders.GetValueOrDefault(projectId) };
        if (request.Method == HttpMethod.Put)
        {
            var body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult(); ReminderWrites.Add(body);
            reminders[projectId] = JsonDocument.Parse(body).RootElement.GetProperty("enabled").GetBoolean();
            return scene == "reminders-save-fails" ? json(new { error = "LATTICE_UNAVAILABLE" }, HttpStatusCode.ServiceUnavailable) : json(Saved(), HttpStatusCode.OK);
        }
        return scene == "reminders-read-fails" && Interlocked.Increment(ref reminderReads) == 1 ? json(new { error = "LATTICE_UNAVAILABLE" }, HttpStatusCode.ServiceUnavailable) : json(Saved(), HttpStatusCode.OK);
    }

    // One snapshot, then the stream stays open (a real stream sends heartbeats). The reconnecting scene drops after the first snapshot and answers 503 after that.
    private HttpResponseMessage Events(string projectId, Func<object, HttpStatusCode, HttpResponseMessage> json)
    {
        if (!Names.ContainsKey(projectId)) return json(new { error = "LATTICE_CHART_NOT_FOUND" }, HttpStatusCode.NotFound);
        if (scene == "reconnecting" && Interlocked.Increment(ref streams) > 1) return json(new { error = "LATTICE_UNAVAILABLE" }, HttpStatusCode.ServiceUnavailable);
        var text = $"event: snapshot\ndata: {JsonSerializer.Serialize(Snapshot(projectId))}\n\n";
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new OpenStream(Encoding.UTF8.GetBytes(text), scene != "reconnecting")) { Headers = { ContentType = new("text/event-stream") } } };
    }
    private sealed class OpenStream(byte[] first, bool stayOpen) : Stream
    {
        private int at;
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => await ReadAsync(buffer.AsMemory(offset, count), token);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (at < first.Length) { var length = Math.Min(buffer.Length, first.Length - at); first.AsMemory(at, length).CopyTo(buffer); at += length; return length; }
            if (!stayOpen) return 0;
            await Task.Delay(Timeout.Infinite, token); return 0;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
