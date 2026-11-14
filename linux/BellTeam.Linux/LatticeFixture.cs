using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace BellTeam.Linux;

/// <summary>
/// Render seam for the 工程表 window (--render-lattice): an in-process server in the lattice module's app contract shape, with the same charts as the Apple fixture
/// (test/helpers/lattice-ui-server.mjs on Rapi's branch). Times are relative to now. Scenes pick the state, the list, the stream, an unknown producer and
/// authored lanes (「authored」: cards nobody started carry the plan's lane text and no producer, as production plans write kiro / anis / root).
/// Every scene carries phases (one untitled) and one nested card (t05 under t04) for the tree; t11 has no phase and hangs from the chart.
/// 「owner」: t11 belongs to the Owner (producer = the reserved value owner, as the server resolves a lane 指揮官 / owner).
/// Finished cards carry doneAt (t03 none) and archived per the server rule: t02 and t03 are archived, t01 (its next card t07 is unstarted) is not.
/// </summary>
internal sealed class LatticeFixture(string scene) : HttpMessageHandler
{
    private static readonly (string Id, string Name, string Color)[] Members = [("bot-trony", "トロニー", "indigo"), ("bot-molly", "モリー", "mint"), ("bot-kiro", "キロ", "sky"), ("bot-admi", "アドミ", "amber"), ("bot-rapi", "ラピ", "rose"), ("bot-flora", "フローラ", "violet")];
    private static readonly string[][] Edges = [["t01", "t07"], ["t02", "t04"], ["t04", "t08"], ["t05", "t08"], ["t07", "t08"], ["t08", "t09"], ["t06", "t10"], ["t09", "t11"], ["t10", "t11"]];
    private static readonly (string Id, string? Title, string[] Tasks)[] Phases = [("ph1", "下調べ", ["t01", "t02", "t03"]), ("ph2", "部品", ["t04", "t05", "t06", "t07", "t08"]), ("ph3", null, ["t09", "t10"])];
    private static readonly Dictionary<string, int> Since = new() { ["t06"] = 52, ["t04"] = 41, ["t07"] = 36, ["t05"] = 24, ["t08"] = 18, ["t09"] = 6, ["t10"] = 3 };
    private int streams;
    private string State => scene switch { "unverified" => "unverified", "last-verified" => "last_verified", "unavailable" => "unavailable", _ => "verified" };
    private static string Ago(double minutes) => DateTimeOffset.UtcNow.AddMinutes(-minutes).ToString("O");

    private object[] Cards()
    {
        object Card(string id, string title, string state, string? producer, int depth, string done = "", string memo = "", double? started = null, string? reason = null, string? authored = null, double? finished = null, bool archived = false)
            => new { id = $"p1/{id}", plan = "p1", taskId = id, title, state, phase = Phases.FirstOrDefault(phase => phase.Tasks.Contains(id)).Id is { } ph ? $"p1/{ph}" : null, parent = id == "t05" ? "p1/t04" : null, lane = scene == "authored" && authored is not null ? authored : producer, producer = scene == "authored" && authored is not null ? null : producer, depth, doneCondition = done, designMemo = memo, startedAt = started is { } at ? Ago(at) : null, changedAt = Ago(60), blockedReason = reason, doneAt = finished is { } doneAgo ? Ago(doneAgo) : null, archived };
        return [
            Card("t01", "決定済み仕様の確認", "done", "bot-flora", 0, "仕様の要点を一覧にする", finished: 95),
            Card("t02", "Latticeの読取口の確認", "done", "bot-flora", 0, "読取の2つの入口を確かめる", finished: 60 * 27, archived: true),
            Card("t03", "旧・組込案の比較", "retired", "bot-admi", 0, archived: true),
            Card("t04", "部品の配置と保存場所", "in-progress", "bot-molly", 1, "配置先と保存先を決定", "部品の置き場と、工程表の保存先を決める。保存先は夜間の控えに入る場所にする。", 12),
            Card("t05", "席へのCLI配布", "in-progress", "bot-kiro", 1, "全席でCLIが使える", started: 4),
            Card("t06", "Web画面の組込口", "blocked", "bot-admi", 1, "Webから工程表を開ける", reason: "組込の登録点が未定"),
            Card("t07", "公開契約の裁定", "ready", "bot-trony", 1, "公開契約が確定する", authored: "root"),
            Card("t08", "部品の実装", "pending", "bot-flora", 2, "契約どおりに動き、席から工程表を読める", "Lattice部品の本体をつくる。公開の入口は裁定済みの契約だけに限り、保存はモリーの配置先を使う。", authored: "kiro"),
            Card("t09", scene == "authored" ? "iPhone/Mac画面の工程表と、待ちの流れの横めくり" : "iPhone/Mac画面", "pending", scene == "unknown" ? "bot-ghost" : "bot-rapi", 3, "実画面で承認される", authored: "anis"),
            Card("t10", "Web画面", "pending", "bot-flora", 3, "Webで工程表が開く", authored: "kiro"),
            Card("t11", "受け取り確認", "pending", scene is "owner" or "owner-lanes" ? "owner" : null, 4, "3画面を実画面で承認"),
        ];
    }

    private object Snapshot(string projectId)
    {
        var cards = Cards(); var json = JsonSerializer.SerializeToElement(cards);
        var byId = json.EnumerateArray().ToDictionary(card => card.GetProperty("taskId").GetString()!);
        bool Finished(string id) => byId[id].GetProperty("state").GetString() is "done" or "retired";
        string? Producer(string id) => byId[id].GetProperty("producer").GetString();
        var waits = Edges.Where(edge => !Finished(edge[0]) && !Finished(edge[1]))
            .Select(edge => new { waiter = Producer(edge[1]), waitingCard = $"p1/{edge[1]}", forCard = $"p1/{edge[0]}", producer = Producer(edge[0]), producerState = byId[edge[0]].GetProperty("state").GetString(), since = Ago(Since.GetValueOrDefault(edge[0], 1)) })
            .OrderBy(wait => wait.since, StringComparer.Ordinal).ToArray();
        var referenced = byId.Values.Select(card => card.GetProperty("producer").GetString()).Concat(waits.Select(wait => wait.waiter)).ToHashSet();
        var name = Names.GetValueOrDefault(projectId);
        return new
        {
            schema = "bellteam.lattice-chart.v1", epoch = "fixture", version = 1, at = Ago(0), projectId, name = name.Name, createdBy = name.CreatedBy, coordinator = projectId == "lattice",
            state = State, verifiedAt = Ago(State == "last_verified" ? 46 : 0), degraded = scene == "degraded" ? new[] { "lattice-read", "members" } : [],
            members = Members.Where(member => referenced.Contains(member.Id)).Select(member => new { botId = member.Id, name = member.Name, color = member.Color, avatarVersion = "" }),
            cards, phases = Phases.Select(phase => new { id = $"p1/{phase.Id}", title = phase.Title }), edges = Edges.Select(edge => new { from = $"p1/{edge[0]}", to = $"p1/{edge[1]}", waiting = !Finished(edge[0]) && !Finished(edge[1]) }), waits
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
        // A chart whose cards are all finished (0/0): the list and the one-chart shortcut skip it (a107).
        EmptyChart(),
        // 「list-many」: 37 charts as on the real server (a88), so the list scrolls.
        .. Enumerable.Range(1, scene == "list-many" ? 32 : 0).Select(index => Summary($"extra-{index:00}", false, 6, index % 6, 1, index % 3, 0, ["bot-kiro"], 20 * 60 + index)),
    ];
    private object EmptyChart() => Summary("empty-draft", false, 0, 0, 0, 0, 0, [], 30);
    private object Summary(string id, bool coordinator, int total, int done, int working, int waiting, int blocked, string[] active, double updated)
        => new { projectId = id, name = Names.TryGetValue(id, out var known) ? known.Name : $"追加の工程表 {id[^2..]}", coordinator, createdBy = Names.TryGetValue(id, out var maker) ? maker.CreatedBy : "bot-kiro", counts = new { total, done, working, waiting, blocked }, activeMembers = active, updatedAt = Ago(updated), state = "verified" };

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
            "/api/lattice/charts" => Json(new { schema = "bellteam.lattice-charts.v1", at = Ago(0), charts = scene == "single" ? [Charts()[0], EmptyChart()] : Charts() }),
            _ when path.EndsWith("/messages", StringComparison.Ordinal) => Json(new { items = Array.Empty<object>(), hasMore = false }),
            _ when path.StartsWith("/api/lattice/charts/", StringComparison.Ordinal) && path.EndsWith("/events", StringComparison.Ordinal) => Events(Uri.UnescapeDataString(path["/api/lattice/charts/".Length..^"/events".Length]), Json),
            _ => Json(new { error = "NOT_FOUND" }, HttpStatusCode.NotFound)
        };
        return Task.FromResult(response);
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
