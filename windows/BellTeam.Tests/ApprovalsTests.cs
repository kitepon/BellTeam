using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// 決裁箱 (docs/architecture/modules/approval-box-extension): Core port of web/approvals-model.js, the /api/approvals/* client and the one feed, against Delta's contract fixtures.
// No UI type here: the same file also runs in BellTeam.Linux.Tests.
public sealed class ApprovalsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 3, 0, 0, TimeSpan.Zero);   // 12:00 JST
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "approvals-fixtures", name));
    private static ViewDecision Decision(string name) => Approvals.ParseDecision(JsonDocument.Parse(Fixture(name)).RootElement.Clone())!;
    private static JsonElement? Body(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Fact]
    public void FailureViewsFollowTheHttpAnswer()
    {
        var errors = JsonDocument.Parse(Fixture("errors.json")).RootElement;
        Assert.Equal(ApprovalFailure.Expired, Approvals.FailureOf(403, errors.GetProperty("not_entitled.expired").GetProperty("body")));
        Assert.Equal(ApprovalFailure.NoCredential, Approvals.FailureOf(409, errors.GetProperty("not_connected").GetProperty("body")));
        Assert.Equal(ApprovalFailure.Refused, Approvals.FailureOf(409, errors.GetProperty("conflict").GetProperty("body")));   // the fixture's decision is a placeholder string
        Assert.Equal(ApprovalFailure.Reconnect, Approvals.FailureOf(503, errors.GetProperty("unavailable").GetProperty("body")));
        Assert.Equal(ApprovalFailure.NotEntitled, Approvals.FailureOf(403, Body("""{"error":{"code":"not_entitled","state":"none"}}""")));
        Assert.Equal(ApprovalFailure.Conflict, Approvals.FailureOf(409, Body("""{"error":{"code":"conflict","decision":{"id":"K-1"}}}""")));
        Assert.Equal(ApprovalFailure.Old, Approvals.FailureOf(404, null));
        Assert.Equal(ApprovalFailure.Gone, Approvals.FailureOf(404, Body("""{"error":{"code":"not_found"}}""")));
        Assert.Equal(ApprovalFailure.Expired, Approvals.FailureOf(402, null));
        Assert.Equal(ApprovalFailure.Wait, Approvals.FailureOf(429, null));
        Assert.Equal(ApprovalFailure.Reconnect, Approvals.FailureOf(0, null));
        Assert.Equal(ApprovalFailure.Refused, Approvals.FailureOf(400, null));
    }

    [Fact]
    public void AMemberDecisionHasAFaceAndALinkNote_AnExternalOneHasAToolTileAndNeverHides()
    {
        var member = Approvals.CardRow(Decision("view-decision.bellteam-pending.json"), Now);
        Assert.Equal(["回答待ち", "急ぎ", "修正あり"], member.Badges.Select(badge => badge.Text));
        Assert.Equal("ブレッディ", member.Origin.Name);
        Assert.Equal("工程表「課金の設計」が、この回答を待っています", member.Note.Text);
        Assert.Equal(["期限 今日 18:00", "推奨あり"], member.Chips);
        Assert.True(member.Urgent);

        var external = Approvals.CardRow(Decision("view-decision.external-pending.json"), Now);
        Assert.Equal(["回答待ち", "外部から"], external.Badges.Select(badge => badge.Text));
        Assert.Equal(("terminal", "Claude Code · Macのレシート整理"), (external.Origin.Tile, external.Origin.Name));
        Assert.Equal("工程表とはつながっていません", external.Note.Text);
        Assert.Contains("外部から", external.Label);

        var unknown = Approvals.CardRow(Decision("view-decision.unknown-origin.json"), Now);
        Assert.Equal(("出どころ不明", true, "globe"), (unknown.Origin.Name, unknown.Origin.Unknown, unknown.Origin.Tile));
        Assert.Contains("外部から", unknown.Badges.Select(badge => badge.Text));
    }

    [Fact]
    public void TheFilterNeverChangesTheCountsOfTheOtherChips()
    {
        var list = JsonSerializer.Deserialize<ApprovalList>(Fixture("list.pending.json"), BellApi.Json)!.Items!;
        var counts = Approvals.OriginCounts(list);
        Assert.Equal(list.Length, counts.All);
        Assert.Equal(counts.All, counts.Bellteam + counts.External);
        Assert.Equal(counts.External, Approvals.OriginFilter(list, "external").Count);
        Assert.Equal(list.Length, Approvals.OriginFilter(list, "all").Count);
    }

    [Fact]
    public void ConfirmAndDeliveryWordsNameWhoGetsTheAnswer()
    {
        var linked = Decision("view-decision.bellteam-pending.json");
        Assert.Equal("「決裁箱と同じ請求にする」で答えますか？ 答えると、ブレッディが続きに進み、工程「課金の設計」が済みになります。", Approvals.ConfirmText(linked, "決裁箱と同じ請求にする"));
        Assert.StartsWith("この指示を送りますか？ ", Approvals.ConfirmText(linked, text: "もう少し調べて"));
        Assert.Equal("「共有フォルダに保存する」で答えますか？ 答えると、Claude Codeに届きます。", Approvals.ConfirmText(Decision("view-decision.external-pending.json"), "共有フォルダに保存する"));

        var unknown = Approvals.DeliveryNote(Decision("view-decision.answered-delivery-unknown.json"));
        Assert.Equal(("amb", true), (unknown.Tone, unknown.Copy));
        Assert.Contains("再開の文", unknown.Text);
        Assert.Equal("ok", Approvals.DeliveryNote(linked with { Delivery = "delivered" }).Tone);
        Assert.Equal("vio", Approvals.DeliveryNote(linked with { Delivery = "waiting" }).Tone);
    }

    [Fact]
    public void AnAnswerThatFailedKeepsTheAnswerAndAConflictCarriesTheLatestDecision()
    {
        Assert.Equal("ok", Approvals.AnswerOutcome(200, null).Kind);
        Assert.Equal(("retry", Approvals.Retry), (Approvals.AnswerOutcome(503, null).Kind, Approvals.AnswerOutcome(503, null).Message));
        Assert.Equal("retry", Approvals.AnswerOutcome(0, null).Kind);
        Assert.Equal("retry", Approvals.AnswerOutcome(429, null).Kind);
        var conflict = Approvals.AnswerOutcome(409, Body("""{"error":{"code":"conflict","decision":{"id":"K-9","version":3,"title":"新しい題"}}}"""));
        Assert.Equal(("conflict", "K-9", 3L), (conflict.Kind, conflict.Decision!.Id, conflict.Decision.Version));
        Assert.Equal(("stop", Approvals.NoCredential), (Approvals.AnswerOutcome(409, Body("""{"error":{"code":"not_connected"}}""")).Kind, Approvals.AnswerOutcome(409, Body("""{"error":{"code":"not_connected"}}""")).Message));
        Assert.Equal("gone", Approvals.AnswerOutcome(404, Body("""{"error":{"code":"not_found"}}""")).Kind);
        Assert.Equal("入力を確かめてください", Approvals.AnswerOutcome(400, Body("""{"error":{"code":"validation_failed","message":"入力を確かめてください"}}""")).Message);
    }

    [Fact]
    public void TheLinkPanelSaysWhyAnExternalDecisionIsNotLinked()
    {
        var linked = Approvals.LinkPanel(Decision("view-decision.bellteam-pending.json"));
        Assert.Equal("linked", linked.Kind);
        Assert.Equal(["課金の方式を調べる"], linked.Previous.Select(task => task.Title));
        Assert.Equal(new ApprovalLinkIds("bellteam", "approval-box/dec-k-demo1"), linked.Ids);
        Assert.Contains("「課金の実装」へ進めます", linked.Sentence);
        var external = Approvals.LinkPanel(Decision("view-decision.external-pending.json"));
        Assert.Equal(("unlinked", "つながっていません", null), (external.Kind, external.Title, external.Ids));
        Assert.Contains("Claude Code", string.Join("", external.Lines));
        Assert.Equal("connecting", Approvals.LinkPanel(Decision("view-decision.bellteam-pending.json") with { Link = null }).Kind);
    }

    [Fact]
    public void DoneRowsAreNewestFirstUnderDayHeadingsWithTheDeliveryBadge()
    {
        var answered = Decision("view-decision.answered-delivery-unknown.json");
        var older = answered with { Id = "old", Answer = answered.Answer! with { AnsweredAt = "2026-11-10T01:00:00Z" } };
        var withdrawn = Decision("view-decision.bellteam-pending.json") with { Id = "gone", Status = "cancelled", CancelReason = "別の方法に決まりました", UpdatedAt = "2026-11-14T12:00:00Z" };
        var today = answered with { Answer = answered.Answer! with { AnsweredAt = "2026-11-15T01:00:00Z" } };
        var groups = Approvals.GroupDone([older, withdrawn, today], Now);
        Assert.Equal(["今日", "昨日", "11月10日"], groups.Select(group => group.Heading));
        Assert.Equal("届いたか不明", groups[0].Rows[0].Delivery!.Text);
        Assert.True(groups[1].Rows[0].Cancelled);
        Assert.Equal(("別の方法に決まりました", null), (groups[1].Rows[0].Line, groups[1].Rows[0].Delivery));
        Assert.StartsWith("あなたの答え：", groups[0].Rows[0].Line);
    }

    [Fact]
    public void CountsAndTheEntryNeverDependOnTheFilter()
    {
        var summary = JsonSerializer.Deserialize<ApprovalSummary>(Fixture("summary.json"), BellApi.Json)!;
        Assert.Equal(Approvals.SummarySchema, summary.Schema);
        var counts = Approvals.CountsOf(summary);
        Assert.Equal((4, 1, 1, 2, 6), (counts.Pending, counts.Urgent, counts.Held, counts.Answered, counts.Filed));
        Assert.Equal(1.0 / 3, counts.Fraction, 6);
        Assert.Equal(("決裁箱、回答待ち4件", "あなたの回答を待っています", true), (Approvals.EntryView(summary, null).Label, Approvals.EntryView(summary, null).Sub, Approvals.EntryView(summary, null).Urgent));
        Assert.Equal("待っている決裁はありません", Approvals.EntryView(new ApprovalSummary { Pending = 0 }, null).Sub);
        Assert.Equal("このサーバーではまだ使えません", Approvals.EntryView(null, ApprovalFailure.Old).Sub);
        Assert.Equal(0, Approvals.CountsOf(null).Filed);
    }

    [Fact]
    public void BackoffIs1_2_4_ThenCapsAt30SecondsWithJitter()
    {
        Assert.Equal([1000, 2000, 4000, 8000, 16000, 30000, 30000], Enumerable.Range(0, 7).Select(attempt => Approvals.BackoffMs(attempt, () => 0.5)));
        Assert.Equal(800, Approvals.BackoffMs(0, () => 0));
        Assert.Equal(30000, Approvals.BackoffMs(20, () => 1));
    }

    // ---- API and feed over a fake server
    private sealed class Server(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        public List<string> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { lock (Calls) Calls.Add($"{request.Method} {request.RequestUri!.PathAndQuery}"); return answer(request, token); }
    }
    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Sse(Stream stream) => new(HttpStatusCode.OK) { Content = new StreamContent(stream) { Headers = { ContentType = new("text/event-stream") } } };
    private static BellApi Api(Server server) => new(new Uri("http://bell.test/"), server);

    [Fact]
    public async Task TheClientReadsTheModuleErrorBodiesInsteadOfLosingThem()
    {
        var server = new Server((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath switch
        {
            "/api/approvals/summary" => Json("""{"error":{"code":"not_entitled","state":"expired","message":"決裁箱の契約が切れています。"}}""", HttpStatusCode.Forbidden),
            "/api/approvals/K-1/answer" => Json("""{"error":{"code":"conflict","message":"直されました","decision":{"id":"K-1","version":2}}}""", HttpStatusCode.Conflict),
            "/api/approvals/connection" => Json("""{"state":"waiting"}"""),
            "/api/approvals/connect" => Json("""{"authorizationUrl":"https://approval.example/consent?code=abc","expiresAt":"2026-11-15T04:00:00Z"}"""),
            "/api/approvals/lost" => new HttpResponseMessage(HttpStatusCode.Unauthorized),
            _ => Json("{}", HttpStatusCode.NotFound)
        }));
        using var api = Api(server);
        var denied = await api.ApprovalSummaryAsync();
        Assert.Equal((403, ApprovalFailure.Expired), (denied.Status, denied.Failure));
        var conflict = await api.ApprovalAnswerAsync("K-1", "o1", null, 1, "key-1");
        Assert.Equal(ApprovalFailure.Conflict, conflict.Failure);
        Assert.Equal("K-1", Approvals.AnswerOutcome(conflict.Status, conflict.Body).Decision!.Id);
        Assert.Equal("waiting", (await api.ApprovalConnectionAsync()).Connection!.State);
        Assert.Equal("https://approval.example/consent?code=abc", (await api.ApprovalConnectAsync()).Start!.AuthorizationUrl);
        Assert.True((await api.ApprovalAsync("lost")).LoginRequired);
        Assert.Contains("POST /api/approvals/K-1/answer", server.Calls);
    }

    [Fact]
    public async Task AnAnswerCarriesItsIdempotencyKeyAndVersion_AndNoAnswerIsStatusZero()
    {
        string? key = null, body = null;
        var server = new Server(async (request, token) =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/answer", StringComparison.Ordinal)) { key = request.Headers.GetValues("Idempotency-Key").Single(); body = await request.Content!.ReadAsStringAsync(token); }
            throw new HttpRequestException("down");
        });
        using var api = Api(server);
        var reply = await api.ApprovalAnswerAsync("K-1", null, "もう少し調べて\r\n", 7, "abc");
        Assert.Equal(0, reply.Status);
        Assert.Equal(ApprovalFailure.Reconnect, reply.Failure);
        Assert.Equal("abc", key);
        using var json = JsonDocument.Parse(body!);
        Assert.Equal((7, "もう少し調べて\n"), (json.RootElement.GetProperty("version").GetInt32(), json.RootElement.GetProperty("text").GetString()));
    }

    private static async Task<bool> Until(Func<bool> done) { for (var i = 0; i < 500 && !done(); i++) await Task.Delay(10); return done(); }

    [Fact]
    public async Task TheFeedReadsTheSummaryThenHoldsTheStream_AndReadsAgainOnlyWhenItDrops()
    {
        var summary = Fixture("summary.json");
        var streams = new List<Stream>();
        var server = new Server((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/approvals/summary") return Task.FromResult(Json(summary));
            var pipe = new System.IO.Pipes.AnonymousPipeServerStream(System.IO.Pipes.PipeDirection.Out);
            var client = new System.IO.Pipes.AnonymousPipeClientStream(System.IO.Pipes.PipeDirection.In, pipe.ClientSafePipeHandle);
            lock (streams) streams.Add(pipe);
            return Task.FromResult(Sse(client));
        });
        var delays = new List<TimeSpan>();
        using var api = Api(server);
        var feed = new ApprovalsFeed(api, (span, token) => { lock (delays) delays.Add(span); return Task.CompletedTask; }, () => 0.5);
        var events = new List<string>(); var statuses = new List<ApprovalFeedStatus>();
        feed.DecisionChanged += item => { lock (events) events.Add($"{item.Kind}:{item.Id}:{item.Version}"); };
        feed.StatusChanged += () => { lock (statuses) statuses.Add(feed.Status); };
        feed.Start();
        Assert.True(await Until(() => streams.Count == 1));
        Assert.Equal((ApprovalFeedStatus.Live, 4), (feed.Status, feed.Summary!.Pending));
        var writer = new StreamWriter(streams[0], new UTF8Encoding(false)) { AutoFlush = true };
        await writer.WriteAsync("event: decision.updated\ndata: {\"id\":\"K-1\",\"version\":3}\n\n: heartbeat\n\nevent: summary\ndata: {\"schema\":\"bellteam.approvals-summary.v1\",\"pending\":5}\n\n");
        Assert.True(await Until(() => feed.Summary!.Pending == 5));
        Assert.Equal(["Updated:K-1:3"], events);
        Assert.Equal(1, server.Calls.Count(call => call == "GET /api/approvals/summary"));   // nothing read on a timer while the stream holds
        writer.Dispose();
        Assert.True(await Until(() => streams.Count == 2));   // the stream ended: summary again, then a new stream
        Assert.Equal(2, server.Calls.Count(call => call == "GET /api/approvals/summary"));
        Assert.Equal(TimeSpan.FromMilliseconds(1000), delays.Single());
        Assert.Contains(ApprovalFeedStatus.Drop, statuses);
        feed.Stop();
        await feed.Loop;
        Assert.False(feed.Running);
        streams[1].Dispose();
    }

    [Fact]
    public async Task ARefusalThatWaitingDoesNotCureStopsTheFeed_RefreshStartsItAgain()
    {
        var entitled = false; var summary = Fixture("summary.json");
        var server = new Server((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath == "/api/approvals/summary"
            ? entitled ? Json(summary) : Json("""{"error":{"code":"not_entitled","state":"none"}}""", HttpStatusCode.Forbidden)
            : Sse(new MemoryStream())));
        var delays = 0;
        using var api = Api(server);
        // The fake stream ends at once, so the feed reads again after every wait: a real wait keeps the loop off the test thread.
        var feed = new ApprovalsFeed(api, async (_, token) => { delays++; await Task.Delay(5, token); });
        feed.Start(); await feed.Loop;
        Assert.Equal((ApprovalFeedStatus.NotEntitled, ApprovalFailure.NotEntitled, false, 0), (feed.Status, feed.Failure!.Value, feed.Running, delays));   // no timer, no retry
        entitled = true;
        feed.Refresh();
        Assert.True(await Until(() => feed.Status is ApprovalFeedStatus.Live or ApprovalFeedStatus.Drop));
        Assert.Equal(4, feed.Summary!.Pending);
        feed.Stop(); await feed.Loop;
    }

    [Fact]
    public async Task NoAnswerKeepsRetryingForeverWithTheBackoff_AndALostSignInIsItsOwnStop()
    {
        var calls = 0;
        var server = new Server((request, _) =>
        {
            calls++;
            if (calls > 8) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
            throw new HttpRequestException("down");
        });
        var delays = new List<int>();
        using var api = Api(server);
        var feed = new ApprovalsFeed(api, (span, _) => { delays.Add((int)span.TotalMilliseconds); return Task.CompletedTask; }, () => 0.5);
        feed.Start(); await feed.Loop;
        Assert.Equal([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000], delays);
        Assert.Equal(ApprovalFeedStatus.LoginRequired, feed.Status);
    }
}
