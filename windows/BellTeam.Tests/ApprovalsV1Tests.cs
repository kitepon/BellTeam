using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BellTeam.App;
using Kitepon.ApprovalBox.Client;
using BellTeam.Core;

namespace BellTeam.Tests;

// client-v0.5: the origin rule (its fixtures are the contract's), the /v1 Decision read, and the screen's source over Kitepon.ApprovalBox.Client against a stand-in Approval Box.
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
        public string Plan = "active"; public int OpenStreams;
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
            if (path == "/v1/events") { OpenStreams++; return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new SseStream(null)) { Headers = { ContentType = new("text/event-stream") } } }; }
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
    // The package's client over the Box: the transport is the fake server; the pass provider says signed in or not, a rejected pass is recorded.
    private static (ClientApprovalSource Source, Box Box, List<string> Rejected) Open(Action<Box>? tune = null, bool signedIn = true)
    {
        var box = new Box(); tune?.Invoke(box); var rejected = new List<string>();
        var client = new ApprovalBoxClient(new ApprovalBoxClientOptions
        {
            BaseUri = new Uri("https://box.test"), PassProvider = (_, _) => ValueTask.FromResult(signedIn ? "Bearer test" : null), PassRejected = rejected.Add, Transport = box
        });
        return (new ClientApprovalSource(client), box, rejected);
    }

    [Fact]
    public async Task TheSourceIsLiveAndMapsTheNormalizedDecisionsToWhatTheScreenDraws()
    {
        var (source, box, _) = Open(); source.Start();
        await Until(() => source.State.Status == RuntimeStatus.Live && box.OpenStreams == 1);
        Assert.Equal(["K-1", "K-9"], source.Decisions.Select(item => item.Id).Order());
        Assert.DoesNotContain(box.Calls, call => call.Path.StartsWith("/api/", StringComparison.Ordinal));
        // the same /v1 JSON read by the Core parser and by the package gives the same decision on the fields the screen draws
        using var raw = JsonDocument.Parse(box.Decision("K-1"));
        var expected = ApprovalsV1.Parse(raw.RootElement)!; var seen = source.Decisions.Single(item => item.Id == "K-1");
        Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(seen));
        await source.DisposeAsync();
    }

    [Fact]
    public async Task AnAnswerSendsTheVersionAndNoNullField_AConflictIsStaleAndAnAnswerIsOk()
    {
        var conflict = false;
        var (source, box, _) = Open(b => b.Override = (request, _) => request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath.EndsWith("/answer", StringComparison.Ordinal)
            ? new HttpResponseMessage(conflict ? HttpStatusCode.Conflict : HttpStatusCode.OK) { Content = new StringContent(conflict ? "{\"error\":{\"code\":\"conflict\",\"decision\":" + b.Decision("K-1", "pending", 3) + "}}" : b.Decision("K-1", "answered", 3), Encoding.UTF8, "application/json") } : null);
        source.Start(); await Until(() => source.State.Status == RuntimeStatus.Live);
        conflict = true;
        Assert.Equal("refused:stale_version", (await source.AnswerAsync("K-1", "a", null, 2)).Ack);
        Assert.Equal(3L, source.Decisions.Single(item => item.Id == "K-1").Version);   // the screen is replaced with the current decision
        conflict = false;
        Assert.Equal("ok", (await source.AnswerAsync("K-1", "a", null, 3)).Ack);
        var post = box.Calls.Last(call => call.Method == "POST");
        using var json = JsonDocument.Parse(post.Body!);
        Assert.Equal(("a", 3), (json.RootElement.GetProperty("option_id").GetString(), json.RootElement.GetProperty("version").GetInt32()));
        Assert.False(json.RootElement.TryGetProperty("text", out _));                   // an absent field, never a null: the server's schema refuses null (first live run)
        await source.DisposeAsync();
    }

    [Fact]
    public async Task ANoPassIsSignedOutWithNoCall_A401HandsThePassBackAndSaysItEnded_A402IsNotEntitled()
    {
        var (none, boxNone, _) = Open(signedIn: false);
        none.Start(); await Until(() => none.State.Status == RuntimeStatus.SignedOut); await Task.Delay(50);
        Assert.Equal(["GET /v1/auth/config"], boxNone.Calls.Select(call => call.Method + " " + call.Path)); await none.DisposeAsync();   // only the switch read, which needs no pass

        var (ended, _, rejected) = Open(b => b.Override = (request, _) => request.RequestUri!.AbsolutePath == "/v1/me" ? new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("{\"error\":{\"code\":\"unauthorized\"}}", Encoding.UTF8, "application/json") } : null);
        ended.Start(); await Until(() => ended.State is { Status: RuntimeStatus.SignedOut, Reason: "pass_ended" });
        Assert.NotEmpty(rejected); await ended.DisposeAsync();

        var (expired, boxExpired, _) = Open(b => b.Plan = "expired");   // /me says the plan ended: no list is read at all
        expired.Start(); await Until(() => expired.State.Status == RuntimeStatus.NotEntitled); Assert.DoesNotContain(boxExpired.Calls, call => call.Path == "/v1/decisions"); await expired.DisposeAsync();
    }

    [Theory]
    [InlineData(ClientStatus.Joining, "Connecting")]
    [InlineData(ClientStatus.Reconnecting, "Retrying")]
    [InlineData(ClientStatus.NeedsApproval, "NeedsAdmission")]
    [InlineData(ClientStatus.Waiting, "NeedsAdmission")]
    [InlineData(ClientStatus.UpdateRequired, "UpdateRequired")]
    public void TheClientsStatesAreTheScreensStates(ClientStatus given, string expected) => Assert.Equal(expected, ClientApprovalSource.StateOf(new ClientState(given)).Status.ToString());

    [Fact]
    public void AnAnswerResultIsTheScreensWord()
    {
        Assert.Equal("ok", ClientApprovalSource.OutcomeOf(new AnswerResult.Accepted(null)).Ack);
        Assert.Equal("unknown", ClientApprovalSource.OutcomeOf(new AnswerResult.Unknown()).Ack);
        Assert.Equal("refused:no_entitlement", ClientApprovalSource.OutcomeOf(new AnswerResult.Refused("no_entitlement")).Ack);
        Assert.Equal("failed", ClientApprovalSource.OutcomeOf(new AnswerResult.Refused("failed:400")).Ack);
        Assert.Equal("gone", ClientApprovalSource.OutcomeOf(new AnswerResult.Gone()).Ack);
        Assert.Equal("no_session", ClientApprovalSource.OutcomeOf(new AnswerResult.NoSession()).Ack);
    }
}
