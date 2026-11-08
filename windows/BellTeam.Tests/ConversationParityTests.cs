using System.Net;
using System.Net.Http;
using System.Text.Json;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// The wording and rules of the Mac conversation (MessageRow, queueStrip, stopBot, targetPicker) that Windows reproduces.
public sealed class ConversationParityTests
{
    private static TimelineMessage Read(string fields, string direction = "outgoing") => JsonSerializer.Deserialize<TimelineMessage>($$"""{"id":"m1","at":"2026-10-13T01:00:00Z","direction":"{{direction}}",{{fields}}}""", BellApi.Json)!;

    [Theory]
    [InlineData("submitting", "受付確認中")]
    [InlineData("accepted", "受付済み・反映待ち")]
    [InlineData("queued", "送信待ち")]
    [InlineData("running", "処理中")]
    [InlineData("stopped", "中断")]
    [InlineData("delivered", "配達済み")]
    [InlineData("failed", "配達失敗")]
    [InlineData("something-new", "")]
    public void EveryMacDeliveryStateHasItsWording(string state, string expected)
        => Assert.Equal(expected, Timeline.DeliveryLabel(Read($"\"delivery\":\"{state}\""), false));

    [Fact]
    public void IncomingMessagesShowNoDeliveryState() => Assert.Equal("", Timeline.DeliveryLabel(Read("\"delivery\":\"delivered\"", "incoming"), false));

    [Fact]
    public void RoomStatusFollowsTheMacPrecedence()
    {
        string Label(string fields) => Timeline.DeliveryLabel(Read(fields), true);
        // routing failure > the message's own delivery > worst recipient (failed, running, queued, stopped) > delivered
        Assert.Equal("配達失敗", Label("\"delivery\":\"delivered\",\"routing\":{\"status\":\"failed\"}"));
        Assert.Equal("送信待ち", Label("\"delivery\":\"queued\",\"deliveries\":[{\"delivery\":\"delivered\"}]"));
        Assert.Equal("配達失敗", Label("\"deliveries\":[{\"delivery\":\"running\"},{\"delivery\":\"failed\"}]"));
        Assert.Equal("処理中", Label("\"deliveries\":[{\"delivery\":\"queued\"},{\"delivery\":\"running\"}]"));
        Assert.Equal("送信待ち", Label("\"deliveries\":[{\"delivery\":\"stopped\"},{\"delivery\":\"queued\"}]"));
        Assert.Equal("中断", Label("\"deliveries\":[{\"delivery\":\"delivered\"},{\"delivery\":\"stopped\"}]"));
        Assert.Equal("配達済み", Label("\"deliveries\":[{\"delivery\":\"delivered\"},{\"delivery\":\"delivered\"}]"));
        Assert.Equal("", Label("\"deliveries\":[]"));
    }

    [Fact]
    public void ReplyLabelNamesTheChosenMembers()
    {
        string? Label(string routing, bool room = true) => Timeline.ReplyLabel(Read($"\"routing\":{routing}"), room, id => id == "a" ? "ユキ" : id == "b" ? "ナギ" : null);
        Assert.Equal("返信者を判定中", Label("{\"status\":\"pending\",\"responders\":[]}"));
        Assert.Equal("返信者の判定に失敗", Label("{\"status\":\"failed\",\"responders\":[]}"));
        Assert.Equal("返信: ユキ、ナギ", Label("{\"status\":\"ready\",\"responders\":[\"a\",\"b\"]}"));
        Assert.Equal("返信: ユキ、unknown-id", Label("{\"status\":\"ready\",\"responders\":[\"a\",\"unknown-id\"]}"));
        Assert.Equal("返信: なし", Label("{\"status\":\"ready\",\"responders\":[]}"));
        Assert.Null(Label("{\"status\":\"other\"}"));
        Assert.Null(Label("{\"status\":\"ready\",\"responders\":[\"a\"]}", room: false));
        Assert.Null(Timeline.ReplyLabel(Read("\"delivery\":\"queued\""), true, _ => null));
    }

    [Fact]
    public void TimeLineShowsTheClockTodayYesterdayThenTheDate()
    {
        var now = new DateTimeOffset(2026, 11, 8, 12, 0, 0, TimeSpan.Zero).ToLocalTime();
        var today = new DateTimeOffset(now.Year, now.Month, now.Day, 9, 5, 0, now.Offset);
        Assert.Equal("9:05", Timeline.ShortTime(today, now));
        Assert.Equal("昨日", Timeline.ShortTime(today.AddDays(-1), now));
        Assert.Equal($"{today.AddDays(-9).Month}月{today.AddDays(-9).Day}日", Timeline.ShortTime(today.AddDays(-9), now));
        Assert.Equal("11月8日(日) 9:05", Timeline.LongTime(new DateTimeOffset(new DateTime(2026, 11, 8, 9, 5, 0, DateTimeKind.Local))));
    }

    [Fact]
    public void QueueLinesAndStopRowsFollowTheMacStrip()
    {
        var run = new QueueItem { Id = "1", BotId = "a", BotName = "ユキ", Status = "running" };
        var wait = run with { Id = "2", Status = "queued" };
        var other = run with { Id = "3", BotId = "b", BotName = null, Status = "queued" };
        var outsider = run with { Id = "4", BotId = "z", BotName = "外" };
        var steered = run with { Id = "5", Status = "queued", Steered = true };
        Assert.Equal("ユキ · 処理中", run.Line("部屋")); Assert.Equal("ユキ · 送信待ち", wait.Line("部屋")); Assert.Equal("部屋 · 送信待ち", other.Line("部屋"));
        var display = QueueItem.DisplayItems([run, wait, other, outsider, steered]);
        Assert.Equal(["1", "2", "3", "4"], display.Select(item => item.Id)); // a steered delivery joins the running turn's row
        string[] members = ["a", "b"];
        Assert.Equal(["1", "3"], display.Where(item => QueueItem.IsStopRow(item, display, true, members)).Select(item => item.Id)); // first active row of each member, never an outsider
        Assert.All(display, item => Assert.False(QueueItem.IsStopRow(item, display, false, members)));
    }

    [Fact]
    public void StopResultsHaveTheMacWording()
    {
        Assert.Equal(BotStopOutcome.Sent, Stop("""{"botId":"a","status":"stop_sent"}""").Outcome(202, "a"));
        Assert.Equal(BotStopOutcome.Confirmed, Stop("""{"botId":"a","status":"interrupted","sessionPreserved":true}""").Outcome(200, "a"));
        Assert.Null(Stop("""{"botId":"a","status":"interrupted","sessionPreserved":false}""").Outcome(200, "a"));
        Assert.Null(Stop("""{"botId":"a","status":"stop_sent"}""").Outcome(200, "a"));
        Assert.Null(Stop("""{"botId":"b","status":"stop_sent"}""").Outcome(202, "a"));
        Assert.Equal("停止操作を送りました。会話は続けられます。", StopNotice.FromOutcome(BotStopOutcome.Sent, "ユキ").Message);
        Assert.Equal("ユキは今、処理を実行していません。同じ会話で新しい依頼を続けられます。", StopNotice.FromOutcome(BotStopOutcome.Confirmed, "ユキ").Message);
        Assert.False(StopNotice.Sent.IsError);
        Assert.Equal("停止操作の結果を確認できませんでした。状況を確認してから操作してください。", StopNotice.FromFailure(new HttpRequestException("down")).Message);
        Assert.Same(StopNotice.Unconfirmed, StopNotice.FromFailure(new OperationCanceledException()));
        Assert.Same(StopNotice.Unconfirmed, StopNotice.FromFailure(new BellApiException("BellTeam: HTTP 500", HttpStatusCode.InternalServerError)));
        var refused = StopNotice.FromFailure(new BellApiException("BellTeam: 対象がありません", HttpStatusCode.NotFound));
        Assert.Equal(("BellTeam: 対象がありません", true), (refused.Message, refused.IsError));
        static BotStopResponse Stop(string json) => JsonSerializer.Deserialize<BotStopResponse>(json, BellApi.Json)!;
    }

    [Fact]
    public void ReplyTargetLabelNamesAutoOneOrMany()
    {
        Assert.Equal("返信者を自動選択", ReplyTarget.Label(true, []));
        Assert.Equal("返信するメンバーを選択", ReplyTarget.Label(false, []));
        Assert.Equal("返信: ユキ", ReplyTarget.Label(true, ["ユキ"]));
        Assert.Equal("返信: 2人", ReplyTarget.Label(false, ["ユキ", "ナギ"]));
    }

    private static Workspace RoomWorkspace(string settings, string queue, Func<HttpRequestMessage, HttpResponseMessage?> custom)
        => new(origin => new BellApi(origin, new StubHandler((request, _) => Task.FromResult(custom(request) ?? StubHandler.Json(request.RequestUri!.AbsolutePath switch
        {
            "/api/session" => "{\"authenticated\":true,\"authMode\":\"local\"}", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => queue,
            "/api/rooms" => ApiTests.Rooms, "/api/settings" => settings, _ => ApiTests.Page
        })))));

    [Fact]
    public async Task RoomSendNeedsATargetWhenRoutingIsOffAndKeepsTheDraft()
    {
        var posts = 0;
        using var workspace = RoomWorkspace("""{"settings":[{"id":"routing","status":"disabled"}]}""", ApiTests.EmptyQueue, request => { if (request.Method != HttpMethod.Post) return null; posts++; return StubHandler.Json("{}"); });
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => item.Target.IsRoom));
        Assert.False(workspace.RoutingEnabled); Assert.Equal("返信するメンバーを選択", workspace.ReplyTargetLabel);
        workspace.DraftText = "お願いします";
        await workspace.SendAsync();
        Assert.Equal(("返信者の自動選択は未設定です。入力欄の上で返信するメンバーを選んでください。", "お願いします", 0), (workspace.SendError, workspace.DraftText, posts));
        workspace.ToggleReplyMember(workspace.ReplyMembers[0]);
        Assert.Equal("返信: ベル 開発", workspace.ReplyTargetLabel);
        await workspace.SendAsync();
        Assert.Equal(1, posts); Assert.Null(workspace.SendError);
        workspace.ClearReplyMembers(); Assert.Equal("返信するメンバーを選択", workspace.ReplyTargetLabel);
    }

    [Fact]
    public async Task RoutingOnLabelsTheAutomaticChoiceAndSendsWithoutATarget()
    {
        var posts = 0;
        using var workspace = RoomWorkspace("""{"settings":[{"id":"other","status":"enabled"},{"id":"routing","status":"enabled"}]}""", ApiTests.EmptyQueue, request => { if (request.Method != HttpMethod.Post) return null; posts++; return StubHandler.Json("{}"); });
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => item.Target.IsRoom));
        Assert.True(workspace.RoutingEnabled); Assert.Equal("返信者を自動選択", workspace.ReplyTargetLabel);
        workspace.DraftText = "よろしく"; await workspace.SendAsync(); Assert.Equal(1, posts);
    }

    [Fact]
    public async Task StopRowsAndOneStopRequestWithoutResend()
    {
        var stops = 0; var status = HttpStatusCode.Accepted; var body = """{"botId":"bot-bell","status":"stop_sent"}""";
        const string queue = """{"items":[{"id":"q1","botId":"bot-bell","botName":"ベル","status":"running","context":"room","contextId":"room-work"},{"id":"q2","botId":"bot-bell","botName":"ベル","status":"queued","context":"room","contextId":"room-work"}]}""";
        using var workspace = RoomWorkspace("{}", queue, request =>
        {
            if (request.Method != HttpMethod.Post || request.RequestUri!.AbsolutePath != "/api/bots/bot-bell/stop") return null;
            stops++; return StubHandler.Json(body, status);
        });
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(item => item.Target.IsRoom));
        Assert.Equal(["ベル · 処理中", "ベル · 送信待ち"], workspace.ActivityRows.Select(row => row.Text));
        Assert.Equal(["bot-bell", null], workspace.ActivityRows.Select(row => row.StopBotId));
        Assert.False(workspace.CurrentBotCanStop); // the single-member stop button belongs to a direct conversation
        await workspace.StopAsync("bot-bell", "ベル");
        Assert.Equal((StopNotice.Sent, 1), (workspace.StopResult, stops)); Assert.True(workspace.StopEnabled);
        status = HttpStatusCode.OK; body = """{"botId":"bot-bell","status":"interrupted","sessionPreserved":true}""";
        await workspace.StopAsync("bot-bell", "ベル");
        Assert.Equal(("ベルは今、処理を実行していません。同じ会話で新しい依頼を続けられます。", 2), (workspace.StopResult!.Message, stops));
        status = HttpStatusCode.InternalServerError; body = "{}";
        await workspace.StopAsync("bot-bell", "ベル");
        Assert.Equal((StopNotice.Unconfirmed, 3), (workspace.StopResult, stops)); // reported once, never resent
        await workspace.SelectAsync(workspace.Entries.Single(item => !item.Target.IsRoom));
        Assert.True(workspace.CurrentBotCanStop); Assert.Null(workspace.StopResult);
    }
}
