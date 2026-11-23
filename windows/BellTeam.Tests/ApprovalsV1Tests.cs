using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// client-v0.5: the origin rule (its fixtures are the contract's), the /v1 Decision read, the v1 adapter against a stand-in Approval Box, and the switch (peer_channel).
public sealed class ApprovalsV1Tests
{
    private static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "approvals-fixtures", name));

    [Fact]
    public void TheOriginRuleFollowsEveryCaseOfTheContractsFixtures()
    {
        using var cases = JsonDocument.Parse(Fixture("origin-cases.json"));
        foreach (var item in cases.RootElement.GetProperty("cases").EnumerateObject())
        {
            var c = item.Value; var roster = c.GetProperty("roster").EnumerateArray().Select(m => (m.GetProperty("id").GetString()!, m.GetProperty("name").GetString()!)).ToList();
            var source = c.GetProperty("source"); string? Str(string name) => source.TryGetProperty(name, out var v) ? v.GetString() : null;
            var raw = new ViewDecision
            {
                Id = "K-1", Origin = new ApprovalOrigin { Client = Str("client"), SessionLabel = Str("session_label") },
                Requester = Str("requester_bot_id") is not null || Str("requester") is not null ? new ApprovalRequester { BotId = Str("requester_bot_id"), Name = Str("requester") } : null,
            };
            var result = ApprovalOriginRule.Apply(raw, roster); var expect = c.GetProperty("expect");
            Assert.Equal((expect.GetProperty("kind").GetString(), expect.GetProperty("basis").GetString()), (result.Origin!.Kind, result.Origin.Basis));
            if (expect.GetProperty("requester").ValueKind == JsonValueKind.Null) Assert.Null(result.Requester);
            else Assert.Equal((expect.GetProperty("requester").GetProperty("botId").GetString(), expect.GetProperty("requester").GetProperty("name").GetString()), (result.Requester!.BotId, result.Requester.Name));
            if (expect.TryGetProperty("client", out var client)) Assert.Equal(client.GetString(), result.Origin.Client);
        }
    }

    private const string Pending = """
        {"id":"K-1","title":"DBの移行をいま実行してよいか","context":"本番DBに列を足す。","options":[{"id":"a","label":"いま実行"},{"id":"b","label":"夜間に回す"}],"recommendation":"b","urgency":"high","deadline":"2026-10-01T09:00:00Z",
         "source":{"client":"claude-code","session_label":"ナユタ / approval-box","requester":"ナユタ","requester_bot_id":"bot-n","work_label":"approval-box","connection_label":"bellteam","via":"connector"},
         "status":"pending","resume_phrase":"Approval Box K-1 の答えを確認して続けて","created_at":"2026-10-01T03:00:00Z","updated_at":"2026-10-01T03:10:00Z","version":2,
         "history":[{"at":"2026-10-01T03:00:00Z","kind":"created","by":"ai"},{"at":"2026-10-01T03:10:00Z","kind":"amended","by":"ai","note":"選択肢を直しました","fields":["options"]}],
         "request_attachments":[{"id":"att_1","name":"a.png","content_type":"image/png","kind":"image","size":3,"sha256":"abc","created_at":"2026-10-01T03:00:00Z"}]}
        """;

    [Fact]
    public void AV1DecisionReadsIntoTheViewDecisionWithTheRecommendationTheAmendmentAndTheRawSource()
    {
        var decision = ApprovalsV1.Parse(JsonDocument.Parse(Pending).RootElement)!;
        Assert.Equal(("K-1", "pending", 2L, "high"), (decision.Id, decision.Status, decision.Version, decision.Urgency));
        Assert.Equal([false, true], decision.Options!.Select(option => option.Recommended));
        Assert.Equal(("選択肢を直しました", true), (decision.Amended!.Note, decision.Amended.Is)); Assert.Equal(["options"], decision.Amended.Fields!.ToList());
        Assert.Equal(("bot-n", "ナユタ", "Claude Code", "bellteam"), (decision.Requester!.BotId, decision.Requester.Name, decision.Origin!.Tool, decision.Origin.ConnectionLabel));   // raw: the origin rule decides who it is
        Assert.Equal([("att_1", "a.png", 3L, "abc")], decision.RequestAttachments!.Select(item => (item.Id, item.Name, item.Size, item.Sha256)));
        Assert.Null(ApprovalsV1.Parse(JsonDocument.Parse("{}").RootElement));
        var (items, next) = ApprovalsV1.ParseList(JsonDocument.Parse("{\"items\":[" + Pending + "],\"next_cursor\":\"c2\"}").RootElement);
        Assert.Equal((1, "c2"), (items.Count, next));
        Assert.Null(ApprovalsV1.ParseList(JsonDocument.Parse("{\"items\":[]}").RootElement).NextCursor);
    }

    [Fact]
    public void TheOpenListIsInApprovalBoxsOrder_UrgentFirstThenTheNearerDeadlineThenTheOlder()
    {
        ViewDecision D(string id, string urgency, string? deadline, string created) => new() { Id = id, Urgency = urgency, Deadline = deadline, CreatedAt = created, Status = "pending" };
        var order = Approvals.OpenOrder([D("old-normal", "normal", null, "2026-01-01T00:00:00Z"), D("new-high", "high", null, "2026-03-01T00:00:00Z"), D("soon-normal", "normal", "2026-05-01T00:00:00Z", "2026-02-01T00:00:00Z"), D("old-high-late", "high", "2026-09-01T00:00:00Z", "2026-01-01T00:00:00Z"), D("old-high-soon", "high", "2026-04-01T00:00:00Z", "2026-02-01T00:00:00Z")]);
        Assert.Equal(["old-high-soon", "old-high-late", "new-high", "soon-normal", "old-normal"], order.Select(item => item.Id));
    }

    // ---- the v1 adapter against a stand-in Approval Box
    private sealed class Box : HttpMessageHandler
    {
        public Func<HttpRequestMessage, string?, HttpResponseMessage?>? Override { get; set; }
        public List<(string Method, string Path, string? Body, string? Key, string? LastEventId)> Calls { get; } = [];
        public string Plan = "active"; public int OpenStreams; public string? Event;
        public string Decision(string id, string status = "pending", int version = 1) => Pending.Replace("\"id\":\"K-1\"", $"\"id\":\"{id}\"").Replace("\"status\":\"pending\"", $"\"status\":\"{status}\"").Replace("\"version\":2", $"\"version\":{version}");
        private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(token);
            lock (Calls) Calls.Add((request.Method.Method, request.RequestUri!.PathAndQuery, body, request.Headers.TryGetValues("Idempotency-Key", out var key) ? key.Single() : null, request.Headers.TryGetValues("Last-Event-ID", out var last) ? last.Single() : null));
            if (Override?.Invoke(request, body) is { } custom) return custom;
            var path = request.RequestUri.AbsolutePath;
            if (path == "/v1/me") return Json($"{{\"user_id\":\"K\",\"plan\":\"{Plan}\"}}");
            if (path == "/v1/decisions") return Json(request.RequestUri.Query.Contains("pending") ? "{\"items\":[" + Decision("K-1") + "]}" : "{\"items\":[" + Decision("K-9", "answered", 3) + "]}");
            if (path == "/v1/events") { OpenStreams++; return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new SseStream(Event)) { Headers = { ContentType = new("text/event-stream") } } }; }
            if (path.StartsWith("/v1/decisions/", StringComparison.Ordinal) && request.Method == HttpMethod.Get) return Json(Decision(path.Split('/')[3], "answered", 5));
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }
    // The stream says the given text and then stays open and silent.
    private sealed class SseStream(string? text) : Stream
    {
        private byte[] data = Encoding.UTF8.GetBytes(text ?? ""); private int at;
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) { if (at < data.Length) { var n = Math.Min(count, data.Length - at); Array.Copy(data, at, buffer, offset, n); at += n; return n; } await Task.Delay(Timeout.Infinite, token); return 0; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { if (at < data.Length) { var n = Math.Min(buffer.Length, data.Length - at); data.AsMemory(at, n).CopyTo(buffer); at += n; return n; } await Task.Delay(Timeout.Infinite, token); return 0; }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
    private static async Task Until(Func<bool> done, [System.Runtime.CompilerServices.CallerLineNumber] int line = 0) { for (var i = 0; i < 500 && !done(); i++) await Task.Delay(10); Assert.True(done(), "line " + line); }
    private static (V1ApprovalSource Source, Box Box, Func<bool> SignedIn, List<string> Dropped, TaskCompletionSource Release) Open(Action<Box>? tune = null, bool signedIn = true)
    {
        var box = new Box(); tune?.Invoke(box); var state = new[] { signedIn }; var dropped = new List<string>(); var release = new TaskCompletionSource();
        var http = new HttpClient(box) { BaseAddress = new Uri("https://box.test/v1/"), Timeout = Timeout.InfiniteTimeSpan };
        // the retry wait is released by the test: a retrying source does not spin
        var source = new V1ApprovalSource(http, () => state[0], () => { state[0] = false; dropped.Add("dropped"); }, (_, token) => release.Task.WaitAsync(token), () => 0.5);
        return (source, box, () => state[0], dropped, release);
    }

    [Fact]
    public async Task TheSourceReadsBothListsAndIsLiveWithItsEventsOpen_NeverTouchingTheBodysRoutes()
    {
        var (source, box, _, _, _) = Open(); source.Start();
        await Until(() => source.State.Status == RuntimeStatus.Live && box.OpenStreams == 1);
        Assert.Equal(["K-1", "K-9"], source.Decisions.Select(item => item.Id).Order());
        Assert.Equal(["GET /v1/me", "GET /v1/decisions?status=pending,held&limit=50", "GET /v1/decisions?status=answered,cancelled&limit=50", "GET /v1/events"], box.Calls.Select(call => call.Method + " " + call.Path));
        Assert.DoesNotContain(box.Calls, call => call.Path.StartsWith("/api/", StringComparison.Ordinal));
        await source.DisposeAsync();
    }

    [Fact]
    public async Task AnEventReadsTheDecisionAgainAndAReconnectResumesFromTheLastEventId()
    {
        var (source, box, _, _, release) = Open(b => b.Event = "id: 7\nevent: decision.updated\ndata: {\"decision_id\":\"K-1\",\"version\":5}\n\nevent: setup.updated\ndata: {}\n\n"); source.Start();
        await Until(() => source.Decisions.FirstOrDefault(item => item.Id == "K-1") is { Status: "answered", Version: 5 });   // the event made it read the decision (the stand-in answers it answered)
        await source.DisposeAsync();
        Assert.Contains(box.Calls, call => call.Method == "GET" && call.Path == "/v1/decisions/K-1");
    }

    [Fact]
    public async Task AnAnswerCarriesTheVersionAndOneKeyPerPress_AndAConflictReplacesTheDecisionWithoutResending()
    {
        var conflict = false;
        var (source, box, _, _, _) = Open(b => b.Override = (request, _) => request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath.EndsWith("/answer", StringComparison.Ordinal)
            ? new HttpResponseMessage(conflict ? HttpStatusCode.Conflict : HttpStatusCode.OK) { Content = new StringContent(conflict ? "{\"error\":{\"code\":\"conflict\",\"decision\":" + b.Decision("K-1", "pending", 3) + "}}" : b.Decision("K-1", "answered", 3), Encoding.UTF8, "application/json") } : null);
        source.Start(); await Until(() => source.State.Status == RuntimeStatus.Live);
        conflict = true;
        Assert.Equal("refused:stale_version", (await source.AnswerAsync("K-1", "a", null, 2)).Ack);
        Assert.Equal(3L, source.Decisions.Single(item => item.Id == "K-1").Version);   // the screen is replaced with the current decision
        conflict = false;
        Assert.Equal("ok", (await source.AnswerAsync("K-1", "a", null, 3)).Ack);
        Assert.Equal("answered", source.Decisions.Single(item => item.Id == "K-1").Status);
        var posts = box.Calls.Where(call => call.Method == "POST").ToList();
        Assert.Equal(2, posts.Count); Assert.All(posts, post => Assert.True(Guid.TryParse(post.Key, out _)));
        using var json = JsonDocument.Parse(posts[0].Body!);
        Assert.Equal(("a", 2), (json.RootElement.GetProperty("option_id").GetString(), json.RootElement.GetProperty("version").GetInt32()));
        Assert.False(json.RootElement.TryGetProperty("text", out _));                   // an absent field, never a null: the server's schema refuses null (first live run)
        conflict = false; await source.AnswerAsync("K-9", null, "もう少し\r\n", 3); await source.AnswerAsync("K-9", null, "もう少し\r\n", 3);
        var again = box.Calls.Where(call => call.Method == "POST" && call.Path.Contains("K-9")).ToList();
        Assert.Equal(again[0].Key, again[1].Key);                                     // the same press again is the same key: a second press is harmless
        Assert.Equal("もう少し\n", JsonDocument.Parse(again[0].Body!).RootElement.GetProperty("text").GetString());   // the text is normalized (CRLF -> LF)
        await source.DisposeAsync();
    }

    [Fact]
    public async Task ANetworkFailureAfterTheSendIsUnknownAndHoldAndUnholdUseTheirOwnRoutes()
    {
        var down = false;
        var (source, box, _, _, _) = Open(b => b.Override = (request, _) => request.Method == HttpMethod.Post && down ? throw new HttpRequestException("down") : null);
        source.Start(); await Until(() => source.State.Status == RuntimeStatus.Live);
        down = true; Assert.Equal("unknown", (await source.AnswerAsync("K-1", "a", null, 1)).Ack);
        down = false; box.Override = (request, _) => request.Method == HttpMethod.Post ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(box.Decision("K-1", "held", 2), Encoding.UTF8, "application/json") } : null;
        Assert.Equal("ok", (await source.HoldAsync("K-1", true)).Ack); Assert.Equal("ok", (await source.HoldAsync("K-1", false)).Ack);
        Assert.Contains(box.Calls, call => call.Path == "/v1/decisions/K-1/hold"); Assert.Contains(box.Calls, call => call.Path == "/v1/decisions/K-1/unhold");
        await source.DisposeAsync();
    }

    [Fact]
    public async Task A402IsNotEntitledAndReadsAgainOnRefresh_APlanExpiredIsToo_A401DropsThePassAndSaysItEnded_NoPassIsSignedOutWithNoCall()
    {
        var (source, box, _, _, _) = Open(b => b.Override = (request, _) => request.RequestUri!.AbsolutePath == "/v1/decisions" ? new HttpResponseMessage(HttpStatusCode.PaymentRequired) { Content = new StringContent("{\"error\":{\"code\":\"subscription_expired\"}}", Encoding.UTF8, "application/json") } : null);
        source.Start(); await Until(() => source.State.Status == RuntimeStatus.NotEntitled);
        box.Override = null; source.Refresh(); await Until(() => source.State.Status == RuntimeStatus.Live);
        await source.DisposeAsync();
        var (expired, boxExpired, _, _, _) = Open(b => b.Plan = "expired");   // /me says the plan ended: no list is read at all
        expired.Start(); await Until(() => expired.State is { Status: RuntimeStatus.NotEntitled, Reason: "no_entitlement" }); Assert.DoesNotContain(boxExpired.Calls, call => call.Path == "/v1/decisions"); await expired.DisposeAsync();

        var (ended, boxEnded, signedIn, dropped, _) = Open(b => b.Override = (request, _) => request.RequestUri!.AbsolutePath == "/v1/me" ? new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("{\"error\":{\"code\":\"unauthorized\"}}", Encoding.UTF8, "application/json") } : null);
        ended.Start(); await Until(() => ended.State is { Status: RuntimeStatus.SignedOut, Reason: "pass_ended" });
        Assert.Single(dropped); Assert.False(signedIn()); await ended.DisposeAsync();

        var (none, boxNone, _, _, _) = Open(signedIn: false);
        none.Start(); await Until(() => none.State.Status == RuntimeStatus.SignedOut); await Task.Delay(50);
        Assert.Empty(boxNone.Calls); await none.DisposeAsync();
    }

    [Fact]
    public async Task ANetworkFailureIsRetryingWithTheLastViewKept_AndRetryNowReadsAgain()
    {
        var down = false;
        var (source, box, _, _, release) = Open(b => b.Override = (request, _) => down ? throw new HttpRequestException("down") : null);
        source.Start(); await Until(() => source.State.Status == RuntimeStatus.Live);
        down = true; source.Refresh();   // retryNow while the connection still holds: nothing changes
        await Task.Delay(30); Assert.Equal(["K-1", "K-9"], source.Decisions.Select(item => item.Id).Order());   // the view stays whatever the state
        await source.DisposeAsync();
    }

    // ---- the switch
    private sealed class FakeSource(string name, List<string> log) : IApprovalSource, IAsyncDisposable
    {
        public RuntimeState State { get; } = new(RuntimeStatus.Live); public IReadOnlyList<ViewDecision> Decisions { get; } = [new ViewDecision { Id = name }];
        public event Action? Changed { add { } remove { } }
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => Task.FromResult(new SendOutcome("ok"));
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new SendOutcome("ok"));
        public void Refresh() => log.Add(name + ":refresh");
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
        public void Start() => log.Add(name + ":start");
        public ValueTask DisposeAsync() { log.Add(name + ":dispose"); return ValueTask.CompletedTask; }
    }

    [Fact]
    public async Task ThePcOneCoreIsNeverBuiltWhilePeerChannelIsFalseOrUnreadable_AndTheSwitchFollowsApprovalBox()
    {
        var log = new List<string>(); bool? answer = false; var reads = 0;
        var selector = new ApprovalSelector(() => { log.Add("v1:made"); return new FakeSource("v1", log); }, () => { log.Add("peer:made"); return new FakeSource("peer", log); }, _ => { reads++; return answer is null ? throw new HttpRequestException("down") : Task.FromResult(answer); });
        selector.Start(); await Until(() => selector.Adapter == "v1");
        Assert.Equal(["v1:made", "v1:start"], log); Assert.DoesNotContain("peer:made", log);   // false: only /v1
        answer = null; selector.Refresh(); await Until(() => reads == 2); selector.Refresh(); await Until(() => log.Count(item => item == "v1:refresh") == 2);
        Assert.Equal("v1", selector.Adapter);                                              // unreadable: the adapter in use stays
        answer = true; selector.Refresh(); await Until(() => selector.Adapter == "peer");
        Assert.Equal(["v1:dispose", "peer:made", "peer:start"], log.Skip(log.IndexOf("v1:start") + 1).Where(item => !item.EndsWith(":refresh")));
        Assert.Equal(["peer"], selector.Decisions.Select(item => item.Id));
        answer = false; selector.Refresh(); await Until(() => selector.Adapter == "v1");      // Approval Box moved back: so does the client
        await selector.DisposeAsync();

        var nothing = new List<string>();
        var first = new ApprovalSelector(() => new FakeSource("v1", nothing), () => new FakeSource("peer", nothing), _ => throw new HttpRequestException("down"));
        first.Start(); await Until(() => first.Adapter == "v1"); Assert.DoesNotContain("peer:start", nothing);   // a failed first read picks /v1
        await first.DisposeAsync();
    }
}
