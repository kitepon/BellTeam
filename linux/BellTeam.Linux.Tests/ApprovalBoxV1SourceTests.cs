using System.Net;
using System.Text;
using System.Text.Json;
using BellTeam.Core;
using BellTeam.Linux;
using BellTeam.PeerChannel;

namespace BellTeam.Linux.Tests;

// client-v0.5.md 5.2: the v1 adapter against a fake Approval Box (no network). The wire is the contract's table; the states are section 7.
public sealed class ApprovalBoxV1SourceTests
{
    private static readonly ServerAccess Access = new(new Uri("https://abx.test"), new Dictionary<string, string> { ["authorization"] = "Bearer pass" });
    private static readonly IReadOnlyList<(string, string)> Roster = [("bot-1", "モリー")];

    // A stream that never ends and never yields: the open /events connection.
    private sealed class OpenStream : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException(); public override long Position { get => 0; set { } }
        public override int Read(byte[] buffer, int offset, int count) { Thread.Sleep(Timeout.Infinite); return 0; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) { await Task.Delay(Timeout.Infinite, ct); return 0; }
        public override void Flush() { } public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException(); public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
    }

    private sealed class Fake(Func<HttpRequestMessage, string?, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string Path, string? Body, string? Key)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            request.Headers.TryGetValues("Idempotency-Key", out var key);
            lock (Calls) Calls.Add((request.Method, request.RequestUri!.PathAndQuery, body, key?.FirstOrDefault()));
            if (request.RequestUri!.AbsolutePath == "/v1/events") return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new OpenStream()) };
            return answer(request, body);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, object body) => new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
    private static object Decision(string id, string status = "pending", int version = 1, string? by = null) => new
    {
        id, title = "請求の確認 " + id, context = "背景", options = new[] { new { id = "a", label = "進める" }, new { id = "b", label = "止める" } }, recommendation = "a", urgency = "high", status, version,
        source = new { client = "claude-code", session_label = "モリー / 作業", requester_bot_id = by }, created_at = "2026-11-24T01:00:00Z", updated_at = "2026-11-24T01:00:00Z",
        history = new object[] { new { at = "2026-11-24T01:00:00Z", kind = "created", by = "ai" } },
    };

    private static async Task<bool> Until(Func<bool> condition) { for (var i = 0; i < 300 && !condition(); i++) await Task.Delay(10); return condition(); }
    private static ApprovalBoxV1Source Make(Fake fake, Func<CancellationToken, Task<ServerAccess>>? access = null) => new(access ?? (_ => Task.FromResult(Access)), () => Roster, fake);

    private static HttpResponseMessage Happy(HttpRequestMessage request, string? body)
    {
        var path = request.RequestUri!.PathAndQuery;
        if (path == "/v1/me") return Json(HttpStatusCode.OK, new { plan = "active" });
        if (path.StartsWith("/v1/decisions?status=pending,held") && !path.Contains("cursor=")) return Json(HttpStatusCode.OK, new { items = new[] { Decision("K-1", by: "bot-1") }, next_cursor = "c2" });
        if (path.StartsWith("/v1/decisions?status=pending,held")) return Json(HttpStatusCode.OK, new { items = new[] { Decision("K-2", "held") } });
        if (path.StartsWith("/v1/decisions?status=answered,cancelled")) return Json(HttpStatusCode.OK, new { items = new[] { Decision("K-0", "answered", 2) } });
        if (path == "/v1/decisions/K-1/answer") return Json(HttpStatusCode.OK, Decision("K-1", "answered", 2, "bot-1"));
        return Json(HttpStatusCode.NotFound, new { error = new { code = "not_found", message = "ない" } });
    }

    [Fact]
    public async Task ItReadsBothListsFollowsTheCursorAndDrawsTheOriginFromTheRoster()
    {
        var fake = new Fake(Happy); using var source = Make(fake); source.Start();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live));
        Assert.Equal(["K-0", "K-1", "K-2"], source.Decisions.Select(d => d.Id).Order());
        var one = source.Decisions.Single(d => d.Id == "K-1");
        Assert.Equal("bellteam", one.Origin!.Kind); Assert.Equal("botId", one.Origin.Basis); Assert.Equal("モリー", one.Requester!.Name); Assert.Equal("Claude Code", one.Origin.Tool);
        Assert.True(one.Options![0].Recommended); Assert.False(one.Options![1].Recommended); Assert.Equal("held", source.Decisions.Single(d => d.Id == "K-2").Status);
        Assert.Contains(fake.Calls, c => c.Path.Contains("cursor=c2"));
    }

    [Fact]
    public async Task AnAnswerCarriesTheVersionAndAnIdempotencyKeyAndTheAnsweredDecisionReplacesTheOpenOne()
    {
        var fake = new Fake(Happy); using var source = Make(fake); source.Start();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live));
        var outcome = await source.AnswerAsync("K-1", "a", null, 1);
        Assert.Equal("ok", outcome.Ack);
        var call = fake.Calls.Single(c => c.Path == "/v1/decisions/K-1/answer");
        Assert.Equal("""{"option_id":"a","version":1}""", call.Body); Assert.False(string.IsNullOrEmpty(call.Key));
        Assert.Equal("answered", source.Decisions.Single(d => d.Id == "K-1").Status);
    }

    [Fact]
    public async Task A409ReplacesTheScreenWithTheCurrentDecisionAndNeverRetriesTheOldVersion()
    {
        var fake = new Fake((request, body) => request.RequestUri!.AbsolutePath == "/v1/decisions/K-1/answer"
            ? Json(HttpStatusCode.Conflict, new { error = new { code = "conflict", message = "x", decision = Decision("K-1", "pending", 3, "bot-1") } }) : Happy(request, body));
        using var source = Make(fake); source.Start();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live));
        Assert.Equal("refused:stale_version", (await source.AnswerAsync("K-1", "a", null, 1)).Ack);
        Assert.Equal(3, source.Decisions.Single(d => d.Id == "K-1").Version);
        Assert.Single(fake.Calls, c => c.Path == "/v1/decisions/K-1/answer");
    }

    [Fact]
    public async Task AnUnknownOutcomeIsShownAndPressingAgainUsesTheSameKeySoItCannotDouble()
    {
        var failOnce = true;
        var fake = new Fake((request, body) =>
        {
            if (request.RequestUri!.AbsolutePath == "/v1/decisions/K-1/answer" && failOnce) { failOnce = false; throw new HttpRequestException("reset"); }
            return Happy(request, body);
        });
        using var source = Make(fake); source.Start();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live));
        Assert.Equal("unknown", (await source.AnswerAsync("K-1", "a", null, 1)).Ack);
        Assert.Equal("ok", (await source.AnswerAsync("K-1", "a", null, 1)).Ack);
        var keys = fake.Calls.Where(c => c.Path == "/v1/decisions/K-1/answer").Select(c => c.Key).ToList();
        Assert.Equal(2, keys.Count); Assert.Equal(keys[0], keys[1]);
    }

    [Fact]
    public async Task A401DropsThePassAndTheListA402IsNotEntitledAndBothLeaveByRefresh()
    {
        var status = HttpStatusCode.Unauthorized; var dropped = 0;
        var fake = new Fake((request, body) => status == HttpStatusCode.OK ? Happy(request, body) : Json(status, new { error = new { code = status == HttpStatusCode.Unauthorized ? "unauthorized" : "subscription_expired", message = "x" } }));
        using var source = Make(fake); source.PassEnded = () => dropped++; source.Start();
        Assert.True(await Until(() => source.State is { Status: RuntimeStatus.SignedOut, Reason: "pass_ended" })); Assert.Equal(1, dropped); Assert.Empty(source.Decisions);
        status = HttpStatusCode.PaymentRequired; source.Refresh();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.NotEntitled));
        status = HttpStatusCode.OK; source.Refresh();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live)); Assert.NotEmpty(source.Decisions);
    }

    [Fact]
    public async Task NoPassIsSignedOutAndANetworkFailureIsRetryingThenRecoversWithoutALimit()
    {
        var signedIn = false; var online = false;
        var fake = new Fake((request, body) => online ? Happy(request, body) : throw new HttpRequestException("down"));
        using var source = Make(fake, _ => signedIn ? Task.FromResult(Access) : throw new SignedOutException()); source.Start();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.SignedOut));
        signedIn = true; source.Refresh();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Retrying));
        online = true; source.Refresh();
        Assert.True(await Until(() => source.State.Status == RuntimeStatus.Live));
    }

    [Fact]
    public async Task TheSwitchFollowsTheServerAndAFailedReadKeepsTheAdapterInUse()
    {
        bool? wanted = false; var fake = new Fake(Happy);
        using var v1 = Make(fake);
        var selector = new SelectedApprovalSource(v1, () => null, _ => Task.FromResult(wanted));   // no engine in this build
        selector.Start();
        Assert.True(await Until(() => selector.State.Status == RuntimeStatus.Live));
        wanted = null; await selector.SelectAsync(CancellationToken.None);
        Assert.Equal(RuntimeStatus.Live, selector.State.Status);   // unreadable: stays on v1
        wanted = true; await selector.SelectAsync(CancellationToken.None);
        Assert.Equal(new RuntimeState(RuntimeStatus.Stopped, "update_needed"), selector.State); Assert.Empty(selector.Decisions);   // peer_channel on, no engine: the update line, not a spinner
        wanted = false; await selector.SelectAsync(CancellationToken.None);
        Assert.True(await Until(() => selector.State.Status == RuntimeStatus.Live)); Assert.NotEmpty(selector.Decisions);
    }
}
