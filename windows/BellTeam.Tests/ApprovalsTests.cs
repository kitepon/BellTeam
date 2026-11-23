using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.Core;

namespace BellTeam.Tests;

// 決裁箱 (docs/architecture/modules/approval-box-extension): Core port of web/approvals-model.js and the one connection client, against Delta's contract fixtures (the list, answers and events are the device's since the /v1 close).
// No UI type here: the same file also runs in BellTeam.Linux.Tests.
public sealed class ApprovalsTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 3, 0, 0, TimeSpan.Zero);   // 12:00 JST
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "approvals-fixtures", name));
    private static ViewDecision Decision(string name) => JsonSerializer.Deserialize<ViewDecision>(Fixture(name), BellApi.Json)!;
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
        var list = JsonSerializer.Deserialize<ViewDecision[]>(JsonDocument.Parse(Fixture("list.pending.json")).RootElement.GetProperty("items").GetRawText(), BellApi.Json)!;
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
    public void AnIdAndStateOnlyLinkSaysTheTaskWithoutNamingIt()
    {
        var link = new ApprovalLink { State = "linked", Attached = true, Chart = new ApprovalChart { ProjectId = "lattice" }, Task = new ApprovalTask { CardId = "p1/t07" } };
        var decision = Decision("view-decision.bellteam-pending.json") with { Link = link };
        Assert.Equal("工程表の工程が、この回答を待っています", Approvals.LinkNote(decision).Text);
        var panel = Approvals.LinkPanel(decision);
        Assert.Equal(("linked", new ApprovalLinkIds("lattice", "p1/t07")), (panel.Kind, panel.Ids));
        Assert.StartsWith("答えると、工程が済みになり、次の工程へ進めます。", panel.Sentence); Assert.DoesNotContain("「」", panel.Sentence);
        Assert.StartsWith("答えました。工程は済みです。", Approvals.LinkPanel(decision with { Status = "answered" }).Sentence);
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

    // ---- the one connection client over a fake server (since the /v1 close only these routes stay)
    private sealed class Server(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        public List<string> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { lock (Calls) Calls.Add($"{request.Method} {request.RequestUri!.PathAndQuery}"); return answer(request, token); }
    }
    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task TheConnectionClientReadsItsStateAndTheConsentUrl_AndARemovedRouteIsNotAFailure()
    {
        var server = new Server((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath switch
        {
            "/api/approvals/connection" when request.Method == HttpMethod.Delete => Json("""{"state":"not_connected"}"""),
            "/api/approvals/connection" => Json("""{"state":"waiting"}"""),
            "/api/approvals/connect" when request.Method == HttpMethod.Delete => Json("""{"state":"not_connected"}"""),
            "/api/approvals/connect" => Json("""{"authorizationUrl":"https://approval.example/consent?code=abc","expiresAt":"2026-11-15T04:00:00Z"}"""),
            "/api/approvals/lost" => new HttpResponseMessage(HttpStatusCode.Unauthorized),
            _ => Json("{}", HttpStatusCode.NotFound)
        }));
        using var api = new BellApi(new Uri("http://bell.test/"), server);
        Assert.Equal("waiting", (await api.ApprovalConnectionAsync()).Connection!.State);
        Assert.Equal("https://approval.example/consent?code=abc", (await api.ApprovalConnectAsync()).Start!.AuthorizationUrl);
        Assert.Equal("not_connected", (await api.ApprovalStopConnectAsync()).Body!.Value.GetProperty("state").GetString());
        Assert.Equal("not_connected", (await api.ApprovalDisconnectAsync()).Body!.Value.GetProperty("state").GetString());
        Assert.Equal(["GET /api/approvals/connection", "POST /api/approvals/connect", "DELETE /api/approvals/connect", "DELETE /api/approvals/connection"], server.Calls);
    }

    [Fact]
    public void TheCountsAreTheDevicesAloneAndTheEntryReadsThem()
    {
        var now = new DateTimeOffset(2026, 11, 15, 3, 0, 0, TimeSpan.Zero);
        var device = new[]
        {
            new ViewDecision { Id = "a", Status = "pending", Urgency = "high", CreatedAt = "2026-11-15T01:00:00Z" }, new ViewDecision { Id = "b", Status = "pending", CreatedAt = "2026-11-10T01:00:00Z" }, new ViewDecision { Id = "c", Status = "held", Urgency = "high" },
            new ViewDecision { Id = "d", Status = "answered", CreatedAt = "2026-11-15T00:00:00Z", Answer = new ApprovalAnswer { AnsweredAt = "2026-11-15T02:00:00Z" } },
        };
        var summary = Approvals.SummaryOf(device, now);
        Assert.Equal(Approvals.SummarySchema, summary.Schema);
        Assert.Equal((2, 1, 2, 1, 2), (summary.Pending, summary.Held, summary.Urgent, summary.AnsweredToday, summary.FiledToday));
        Assert.Equal(("あなたの回答を待っています", 2), (Approvals.EntryView(summary, null).Sub, Approvals.EntryView(summary, null).Pending));
        Assert.Equal(0, Approvals.SummaryOf([], now).Pending);
    }
}
