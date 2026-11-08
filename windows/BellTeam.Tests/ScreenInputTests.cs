using System.Net;
using System.Net.Http;
using BellTeam.App;
using BellTeam.Core;
using Xunit;

namespace BellTeam.Tests;

// Ports of ios/BellBot/BellBotTests/ScreenKeyBarTests.swift, plus the screen polling of BotScreenView.
public sealed class ScreenInputTests
{
    private sealed class Server
    {
        public readonly List<(string Method, string Path, string Body)> Requests = [];
        public readonly Dictionary<string, Queue<(int Status, string Body)>> Script = [];
        public void Set(string key, params (int Status, string Body)[] answers) => Script[key] = new(answers);
        public BellApi Api() => new(new("http://screen-input.test/"), new StubHandler(async (request, _) =>
        {
            var key = request.Method + " " + request.RequestUri!.AbsolutePath;
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync();
            lock (Requests) Requests.Add((request.Method.Method, request.RequestUri.PathAndQuery, body));
            (int, string) answer = (404, """{"error":"UNSCRIPTED"}""");
            lock (Script) if (Script.TryGetValue(key, out var queue)) answer = queue.Count > 1 ? queue.Dequeue() : queue.Peek();
            return StubHandler.Json(answer.Item2, (HttpStatusCode)answer.Item1);
        }));
    }
    private const string KeyPath = "POST /api/bots/b1/screen/key", ApprovalGet = "GET /api/bots/b1/screen/approval", ApprovalPost = "POST /api/bots/b1/screen/approval";
    private static string Required(string digest) => $$"""{"status":"approval_required","promptDigest":"{{digest}}","choices":[{"decision":"approve_once","label":"今回だけ許可"},{"decision":"deny","label":"拒否"}]}""";
    private static (int, string) Error(int status, string code) => (status, $$"""{"error":"{{code}}"}""");
    private static (ScreenInputModel Model, Server Server) Make(TimeSpan? feedback = null) { var server = new Server(); return (new ScreenInputModel(server.Api(), "b1", (_, _, _) => { }, feedback), server); }

    [Fact]
    public async Task KeyPostsClosedSetKeyAsJson()
    {
        var (model, server) = Make();
        server.Set(KeyPath, (200, """{"key":"Enter","outcome":"accepted"}"""));
        await model.SendKeyAsync("Enter");
        Assert.Equal("Enter", model.SentKey); Assert.Null(model.Notice); Assert.Null(model.SendingKey);
        Assert.Equal(("POST", "/api/bots/b1/screen/key", """{"key":"Enter"}"""), server.Requests.Single());
    }

    [Theory]
    [InlineData(409, "SCREEN_SEAT_ABSENT", "席が起動していません")]
    [InlineData(403, "SCREEN_INPUT_OWNER_REQUIRED", "オーナーとしてログインしていません")]
    [InlineData(502, "SCREEN_INPUT_FAILED", "送れませんでした")]
    [InlineData(400, "SCREEN_KEY_INVALID", "送れませんでした")]
    public async Task KeyErrorsBecomeShortJapaneseLinesWithoutRetry(int status, string code, string text)
    {
        var (model, server) = Make();
        server.Set(KeyPath, Error(status, code));
        await model.SendKeyAsync("Tab");
        Assert.Equal(text, model.Notice); Assert.True(model.Available); Assert.Null(model.SentKey);
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task OnlyTheUnexpectedFailuresAreReported()
    {
        var (model, server) = Make();
        server.Set(KeyPath, Error(502, "SCREEN_INPUT_FAILED"), Error(409, "SCREEN_SEAT_ABSENT"), Error(500, "INTERNAL"));
        await model.SendKeyAsync("Tab"); await model.SendKeyAsync("Tab"); Assert.Equal(0, model.ReportedFailures);
        await model.SendKeyAsync("Tab"); Assert.Equal(1, model.ReportedFailures); Assert.Equal("送れませんでした", model.Notice);
    }

    [Fact]
    public async Task ApprovalGetDecodesAndPostCarriesPromptDigest()
    {
        var digest = "sha256:" + new string('a', 64);
        var (model, server) = Make();
        server.Set(ApprovalGet, (200, Required(digest)));
        await model.RefreshApprovalAsync();
        Assert.Equal(digest, model.Approval?.PromptDigest);
        Assert.Equal(["approve_once", "deny"], model.Approval!.Choices!.Select(choice => choice.Decision));
        Assert.Equal("今回だけ許可", model.Approval.Choices![0].Label);

        server.Set(ApprovalPost, (200, """{"status":"submitted","decision":"approve_once"}"""));
        await model.RespondAsync("approve_once");
        Assert.Null(model.Approval); Assert.Equal("approval:approve_once", model.SentKey);
        var post = server.Requests.Last();
        Assert.Equal("POST", post.Method);
        Assert.Equal($$"""{"decision":"approve_once","promptDigest":"{{digest}}"}""", post.Body);

        server.Set(ApprovalGet, (200, """{"status":"none"}"""));
        await model.RefreshApprovalAsync();
        Assert.Null(model.Approval);
    }

    [Fact]
    public async Task ChangedApprovalRefetchesInsteadOfRetrying()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, (200, Required("sha256:old")), (200, Required("sha256:new")));
        await model.RefreshApprovalAsync();
        server.Set(ApprovalPost, Error(409, "SCREEN_APPROVAL_CHANGED"));
        await model.RespondAsync("deny");
        Assert.Equal(["GET /api/bots/b1/screen/approval", "POST /api/bots/b1/screen/approval", "GET /api/bots/b1/screen/approval"], server.Requests.Select(item => item.Method + " " + item.Path));
        Assert.Equal("sha256:new", model.Approval?.PromptDigest);
        Assert.Equal("画面が変わりました。もう一度確認してください", model.Notice);
    }

    [Fact]
    public async Task UnsupportedApprovalHidesButtonsLeavesKeysAndIsClearedByALater200()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, Error(422, "SCREEN_APPROVAL_UNSUPPORTED"), (200, """{"status":"none"}"""));
        await model.RefreshApprovalAsync();
        Assert.True(model.ApprovalUnsupported); Assert.Null(model.Approval); Assert.Null(model.Banner); Assert.True(model.Available);
        await model.RefreshApprovalAsync();
        Assert.False(model.ApprovalUnsupported);
    }

    [Fact]
    public async Task UnsupportedAnswerToAnApprovalPostShowsTheKeyNotice()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, (200, Required("sha256:aa"))); await model.RefreshApprovalAsync();
        server.Set(ApprovalPost, Error(422, "SCREEN_APPROVAL_UNSUPPORTED"));
        await model.RespondAsync("deny");
        Assert.Equal("キーで答えてください", model.Notice); Assert.True(model.ApprovalUnsupported); Assert.Null(model.Approval);
    }

    [Fact]
    public async Task A503HidesTheWholeBarSilently()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, Error(503, "SCREEN_INPUT_UNAVAILABLE"));
        await model.RefreshApprovalAsync();
        Assert.False(model.Available); Assert.Null(model.Notice);

        var (fresh, again) = Make();
        again.Set(KeyPath, Error(503, "SCREEN_INPUT_UNAVAILABLE"));
        await fresh.SendKeyAsync("Enter");
        Assert.False(fresh.Available); Assert.Null(fresh.Notice);
        await fresh.SendKeyAsync("Enter");
        Assert.Single(again.Requests);
    }

    [Fact]
    public async Task BarComesBackWhenTheServerLaterAnswers200()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, Error(503, "SCREEN_INPUT_UNAVAILABLE"), (200, """{"status":"none"}"""));
        await model.RefreshApprovalAsync(); Assert.False(model.Available);
        await model.RefreshApprovalAsync(); Assert.True(model.Available);
    }

    [Fact]
    public async Task ApprovalBannerAppearsAfterFailedPollsAndTheFailureIsReportedOncePerStreak()
    {
        var server = new Server(); var reported = new List<string>();
        var model = new ScreenInputModel(server.Api(), "b1", (_, path, method) => reported.Add(method + " " + path));
        server.Set(ApprovalGet, Error(500, "INTERNAL"), Error(500, "INTERNAL"), (200, Required("sha256:later")), Error(500, "INTERNAL"));
        await model.RefreshApprovalAsync(); await model.RefreshApprovalAsync();
        Assert.Null(model.Approval); Assert.Equal(["GET /api/bots/b1/screen/approval"], reported);
        await model.RefreshApprovalAsync();
        Assert.Equal("sha256:later", model.Approval?.PromptDigest);
        Assert.Equal(3, server.Requests.Count);
        await model.RefreshApprovalAsync();   // a new streak after a 200 is reported again
        Assert.Equal(2, reported.Count);
    }

    [Fact]
    public async Task SeatAbsentOnTheApprovalReadClearsTheBannerButKeepsTheBar()
    {
        var (model, server) = Make();
        server.Set(ApprovalGet, (200, Required("sha256:aa")), Error(409, "SCREEN_SEAT_ABSENT"));
        await model.RefreshApprovalAsync(); Assert.NotNull(model.Approval);
        await model.RefreshApprovalAsync(); Assert.Null(model.Approval); Assert.True(model.Available);
    }

    [Fact]
    public async Task TheCheckMarkClearsAfterTheFeedbackTime()
    {
        var (model, server) = Make(TimeSpan.FromMilliseconds(40));
        server.Set(KeyPath, (200, """{"key":"Up","outcome":"accepted"}"""));
        await model.SendKeyAsync("Up"); Assert.Equal("Up", model.SentKey);
        await Task.Delay(400); Assert.Null(model.SentKey);
    }

    [Fact]
    public async Task AKeyIsNotSentWhileAnotherIsSending()
    {
        var release = new TaskCompletionSource(); var count = 0;
        using var api = new BellApi(new("http://screen-input.test/"), new StubHandler(async (_, _) => { Interlocked.Increment(ref count); await release.Task; return StubHandler.Json("""{"key":"Up","outcome":"accepted"}"""); }));
        var model = new ScreenInputModel(api, "b1");
        var first = model.SendKeyAsync("Up"); await model.SendKeyAsync("Down");
        Assert.Equal("Up", model.SendingKey); release.SetResult(); await first;
        Assert.Equal(1, count);
    }

    [Fact]
    public void ScrollbackJoinsTheOpeningHistoryAndTheFollowingTails()
    {
        var scrollback = new ScreenScrollback();
        scrollback.Start("a\nb\nc\nd");
        Assert.Equal("a\nb\nc\nd", scrollback.Merge("c\nd"));
        Assert.Equal("a\nb\nd\ne", scrollback.Merge("d\ne"));
        var single = new ScreenScrollback(); single.Start("only");
        Assert.Equal("only", single.Merge("only"));
    }

    private static Workspace Screens(Func<HttpRequestMessage, HttpResponseMessage> screen, List<string> requests) => new(origin => new BellApi(origin, new StubHandler((request, _) =>
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path.StartsWith("/api/bots/bot-bell/screen", StringComparison.Ordinal)) { lock (requests) requests.Add(path + request.RequestUri.Query); return Task.FromResult(screen(request)); }
        return Task.FromResult(StubHandler.Json(path switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, _ => """{"items":[],"has_more":false}""" }));
    })));

    [Fact]
    public async Task ScreenReadsHistoryOnceThenTheTailEverySecondAndKeepsReadingAfterAFailure()
    {
        var requests = new List<string>(); var reads = 0;
        using var workspace = Screens(request =>
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/approval", StringComparison.Ordinal)) return StubHandler.Json("""{"status":"none"}""");
            return ++reads switch
            {
                1 => StubHandler.Json("""{"online":true,"screen":"a\nb\nc\nd"}"""),
                2 => StubHandler.Json("""{"online":true,"screen":"d\ne"}"""),
                3 => StubHandler.Json("""{"error":"TEMPORARY_FAILURE"}""", HttpStatusCode.InternalServerError),
                _ => StubHandler.Json("""{"online":true,"screen":"e\nf"}""")
            };
        }, requests);
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        var run = workspace.OpenScreenAsync();
        await workspace.ScreenFirstRead.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("a\nb\nc\nd", workspace.Screen); Assert.Equal("1秒ごとに更新", workspace.ScreenStatus); Assert.True(workspace.ScreenOnline);
        var deadline = DateTime.UtcNow.AddSeconds(6);
        while (workspace.ScreenError is null && DateTime.UtcNow < deadline) await Task.Delay(20);
        Assert.Equal("BellTeam: TEMPORARY_FAILURE", workspace.ScreenError); Assert.Equal("BellTeam: TEMPORARY_FAILURE", workspace.ScreenStatus);
        Assert.False(run.IsCompleted);   // the failure does not end the loop
        deadline = DateTime.UtcNow.AddSeconds(6);
        while (workspace.ScreenError is not null && DateTime.UtcNow < deadline) await Task.Delay(20);
        Assert.Null(workspace.ScreenError); Assert.Equal("1秒ごとに更新", workspace.ScreenStatus);
        Assert.EndsWith("e\nf", workspace.Screen);
        workspace.ReturnToProfile(); await run.WaitAsync(TimeSpan.FromSeconds(5));
        string[] seen; lock (requests) seen = requests.ToArray();
        Assert.Equal("/api/bots/bot-bell/screen?history=1", seen[0]);
        Assert.Equal(1, seen.Count(path => path.EndsWith("?history=1", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ApprovalIsReadOnEveryRefreshEvenAfterItFailed()
    {
        var requests = new List<string>(); var approvals = 0;
        using var workspace = Screens(request =>
        {
            if (!request.RequestUri!.AbsolutePath.EndsWith("/approval", StringComparison.Ordinal)) return StubHandler.Json("""{"online":true,"screen":"x"}""");
            return ++approvals == 1 ? StubHandler.Json("""{"error":"INTERNAL"}""", HttpStatusCode.InternalServerError) : StubHandler.Json(Required("sha256:" + new string('b', 64)));
        }, requests);
        workspace.ScreenFailureReport = (_, _, _) => { };
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        var run = workspace.OpenScreenAsync();
        await workspace.ScreenFirstRead.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(workspace.ScreenInput!.Approval);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (workspace.ScreenInput.Approval is null && DateTime.UtcNow < deadline) await Task.Delay(50);
        Assert.NotNull(workspace.ScreenInput.Approval);
        workspace.ReturnToProfile(); await run;
        Assert.Null(workspace.ScreenInput);
    }
}
