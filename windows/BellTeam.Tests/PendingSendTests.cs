using System.Net;
using System.Net.Http;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// Mac ConversationTimelineState: the owner's message is on screen as 受付確認中 from the send, and the server history replaces it by the accepted id.
public sealed class PendingSendTests
{
    private static TimelineMessage Sent(string id, string text, string delivery = "queued") => new() { Id = id, At = DateTimeOffset.Parse("2026-11-08T01:00:00Z"), Kind = "message", Direction = "outgoing", Message = text, Delivery = delivery };
    private static TimelineMessage Incoming(string id) => new() { Id = id, At = DateTimeOffset.Parse("2026-11-08T00:59:00Z"), Kind = "message", Direction = "incoming", Message = "こんにちは" };
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-08T01:00:05Z");

    [Fact]
    public void TheEchoIsAnOutgoingMessageThatSaysItIsBeingConfirmedThenAccepted()
    {
        var echo = new PendingSend(PendingSend.NewId(), "送るよ", 0, Now);
        Assert.True(PendingSend.IsLocal(echo.Id)); Assert.False(PendingSend.IsLocal("m1"));
        var message = echo.ToMessage();
        Assert.Equal((echo.Id, true, "送るよ", "submitting", "受付確認中"), (message.Id, message.IsOutgoing, message.Message, message.Delivery, Timeline.DeliveryLabel(message, false)));
        var accepted = (echo with { AcceptedId = "srv1" }).ToMessage();
        Assert.Equal(("accepted", "受付済み・反映待ち"), (accepted.Delivery, Timeline.DeliveryLabel(accepted, false)));
        Assert.Equal((true, 2), (new PendingSend("local-pending-x", "", 2, Now).ToMessage().Image, new PendingSend("local-pending-x", "", 2, Now).ToMessage().ImageCount));
        Assert.NotEqual(PendingSend.NewId(), PendingSend.NewId());
    }

    [Fact]
    public void VisibleListsTheHistoryThenOnlyEchoesTheHistoryDoesNotHave()
    {
        var history = new[] { Incoming("a"), Sent("srv1", "送るよ") };
        var unsent = new PendingSend("local-pending-1", "まだ", 0, Now);
        var acceptedButMissing = new PendingSend("local-pending-2", "受付済み", 0, Now, "srv2");
        var acceptedAndPresent = new PendingSend("local-pending-3", "送るよ", 0, Now, "srv1");
        Assert.Equal(["a", "srv1", "local-pending-1", "local-pending-2"], PendingSend.Visible(history, [unsent, acceptedButMissing, acceptedAndPresent]).Select(item => item.Id));
        // The same text sent twice is two echoes: only the accepted id decides, never the body.
        Assert.Equal(["a", "srv1", "local-pending-1"], PendingSend.Visible(history, [new PendingSend("local-pending-1", "送るよ", 0, Now), acceptedAndPresent]).Select(item => item.Id));
        Assert.Equal([unsent.Id, acceptedButMissing.Id], PendingSend.Reconcile([unsent, acceptedButMissing, acceptedAndPresent], history).Select(item => item.Id));
    }

    private sealed class FakeServer
    {
        public List<TimelineMessage> History { get; } = [Incoming("m0")];
        public int Posts, Gets;
        public HttpResponseMessage Answer(HttpRequestMessage request)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post) throw new InvalidOperationException();
            if (path.EndsWith("/messages")) { Gets++; var items = request.RequestUri.Query.Contains("after=") ? [] : History.ToArray(); return StubHandler.Json(System.Text.Json.JsonSerializer.Serialize(new { items = items.Select(item => new { id = item.Id, kind = item.Kind, direction = item.Direction, at = item.At, message = item.Message, delivery = item.Delivery }), has_more = false })); }
            return StubHandler.Json(path switch { "/api/session" => """{"authenticated":true,"authMode":"local"}""", "/api/bots" => ApiTests.Bots, "/api/owner" => ApiTests.Owner, "/api/queue" => ApiTests.EmptyQueue, "/api/rooms" => ApiTests.Rooms, "/api/settings" => """{"settings":[{"id":"routing","status":"enabled"}]}""", _ => "{}" });
        }
    }

    private static async Task<(Workspace Workspace, FakeServer Server)> OpenAsync(Func<FakeServer, HttpRequestMessage, Task<HttpResponseMessage>> onPost, bool room = false)
    {
        var server = new FakeServer();
        var workspace = new Workspace(origin => new BellApi(origin, new StubHandler(async (request, _) => request.Method == HttpMethod.Post ? await onPost(server, request) : server.Answer(request))));
        await workspace.ConnectAsync("http://localhost", listen: false);
        await workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom == room));
        return (workspace, server);
    }
    private static string[] Ids(Workspace workspace) => workspace.Messages.Select(item => item.Message.Id).ToArray();
    private static string Label(Workspace workspace, int index) => Timeline.DeliveryLabel(workspace.Messages[index].Message, workspace.IsRoom);

    [Fact]
    public async Task SendShowsTheEchoAtOnceThenAcceptedThenTheServerCopyReplacesItWithoutADuplicate()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var (workspace, server) = await OpenAsync(async (current, _) => { current.Posts++; started.SetResult(); await release.Task; return StubHandler.Json("""{"delivery_id":"srv1"}"""); });
        using var disposer = workspace;
        Assert.Equal(["m0"], Ids(workspace));
        workspace.DraftText = "送るよ"; var send = workspace.SendAsync(); await started.Task;
        // In flight: the owner's message is already there, labelled 受付確認中, and the composer is empty.
        Assert.Equal(2, workspace.Messages.Count); Assert.True(PendingSend.IsLocal(workspace.Messages[1].Message.Id));
        Assert.Equal(("送るよ", "受付確認中"), (workspace.Messages[1].Message.Message, Label(workspace, 1))); Assert.Equal("", workspace.DraftText);
        // The server already has the message before the answer arrives (an update event): both are shown until the id ties them (Mac).
        server.History.Add(Sent("srv1", "送るよ"));
        await workspace.RefreshManagementAsync();
        Assert.Equal(["m0", "srv1", workspace.Messages[2].Message.Id], Ids(workspace)); Assert.True(PendingSend.IsLocal(workspace.Messages[2].Message.Id));
        release.SetResult(); await send;
        Assert.Equal(["m0", "srv1"], Ids(workspace)); Assert.Equal("送信待ち", Label(workspace, 1));
        Assert.Equal(1, server.Posts); Assert.Null(workspace.SendError);
        await workspace.RefreshManagementAsync(); await workspace.RefreshManagementAsync();
        Assert.Equal(["m0", "srv1"], Ids(workspace));
    }

    [Fact]
    public async Task AnAcceptedEchoReadsAcceptedUntilTheHistoryHasItAndAnUpdateEventNeverDuplicatesIt()
    {
        var (workspace, server) = await OpenAsync((current, _) => { current.Posts++; return Task.FromResult(StubHandler.Json($$"""{"delivery_id":"srv{{current.Posts}}"}""")); });
        using var disposer = workspace;
        workspace.DraftText = "送るよ"; await workspace.SendAsync();
        // The send's own refresh ran before the server listed the message: the echo stays, now 受付済み・反映待ち.
        Assert.Equal(2, workspace.Messages.Count); Assert.Equal("受付済み・反映待ち", Label(workspace, 1)); Assert.Equal("送るよ", workspace.Messages[1].Message.Message);
        await workspace.RefreshManagementAsync(); Assert.Equal(2, workspace.Messages.Count);
        server.History.Add(Sent("srv1", "送るよ", "running"));
        await workspace.RefreshManagementAsync();
        Assert.Equal(["m0", "srv1"], Ids(workspace)); Assert.Equal("処理中", Label(workspace, 1));
        await workspace.RefreshManagementAsync(); Assert.Equal(["m0", "srv1"], Ids(workspace));
        // The same text sent again is a new echo, not mistaken for the first message.
        workspace.DraftText = "送るよ"; await workspace.SendAsync();
        Assert.Equal(3, workspace.Messages.Count); Assert.Equal(("srv1", true), (workspace.Messages[1].Message.Id, PendingSend.IsLocal(workspace.Messages[2].Message.Id)));
    }

    [Fact]
    public async Task ARefusedSendRemovesTheEchoRestoresTheDraftAndIsNeverResent()
    {
        var (workspace, server) = await OpenAsync((current, _) => { current.Posts++; return Task.FromResult(StubHandler.Json("""{"error":"SEND_FAILED","message":"作業を受け付けられません"}""", HttpStatusCode.BadRequest)); });
        using var disposer = workspace;
        workspace.DraftText = "送るよ"; await workspace.SendAsync();
        Assert.Equal(["m0"], Ids(workspace)); Assert.Equal("送るよ", workspace.DraftText); Assert.Contains("作業を受け付けられません", workspace.SendError); Assert.DoesNotContain("結果を確認できません", workspace.SendError);
        Assert.Equal(1, server.Posts); await workspace.RefreshManagementAsync(); Assert.Equal(1, server.Posts);
        Assert.True(workspace.CanSend);
    }

    [Theory]
    [InlineData("server-error")]
    [InlineData("no-answer")]
    [InlineData("no-id")]
    public async Task AnUnknownResultRemovesTheEchoRestoresTheDraftAndSaysTheResultIsUnconfirmed(string kind)
    {
        var (workspace, server) = await OpenAsync((current, _) =>
        {
            current.Posts++;
            return kind switch { "server-error" => Task.FromResult(StubHandler.Json("{}", HttpStatusCode.ServiceUnavailable)), "no-id" => Task.FromResult(StubHandler.Json("{}")), _ => throw new HttpRequestException("切断") };
        });
        using var disposer = workspace;
        workspace.DraftText = "送るよ\n続き"; await workspace.SendAsync();
        // Never shown as success: no echo stays, nothing claims acceptance, the text is back and the owner is told to check first.
        Assert.Equal(["m0"], Ids(workspace)); Assert.Equal("送るよ\n続き", workspace.DraftText); Assert.Contains("操作の結果を確認できませんでした", workspace.SendError);
        Assert.Equal(1, server.Posts); await workspace.RefreshManagementAsync(); Assert.Equal(["m0"], Ids(workspace)); Assert.Equal(1, server.Posts);
    }

    [Fact]
    public async Task AFailureKeepsWhatWasTypedWhileSendingAndTheEchoHoldsOnlyTheSentText()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var (workspace, _) = await OpenAsync(async (current, _) => { current.Posts++; started.SetResult(); await release.Task; return StubHandler.Json("""{"error":"X"}""", HttpStatusCode.BadRequest); });
        using var disposer = workspace;
        workspace.DraftText = "  最初  "; var send = workspace.SendAsync(); await started.Task;
        Assert.Equal("最初", workspace.Messages[1].Message.Message); workspace.DraftText = "続き";
        release.SetResult(); await send;
        Assert.Equal(["m0"], Ids(workspace)); Assert.Equal("最初\n続き", workspace.DraftText);
    }

    [Fact]
    public async Task AnEchoSurvivesLeavingTheConversationAndComesBackWhileItStillWaits()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var (workspace, server) = await OpenAsync(async (current, _) => { current.Posts++; started.SetResult(); await release.Task; return StubHandler.Json("""{"delivery_id":"srv1"}"""); });
        using var disposer = workspace;
        var member = workspace.Selected!; workspace.DraftText = "送るよ"; var send = workspace.SendAsync(); await started.Task;
        await workspace.SelectAsync(workspace.Entries.Single(entry => entry.Target.IsRoom));
        Assert.DoesNotContain(Ids(workspace), PendingSend.IsLocal);
        await workspace.SelectAsync(member);
        Assert.Equal(2, workspace.Messages.Count); Assert.Equal("受付確認中", Label(workspace, 1));
        release.SetResult(); await send; server.History.Add(Sent("srv1", "送るよ")); await workspace.RefreshManagementAsync();
        Assert.Equal(["m0", "srv1"], Ids(workspace));
    }

    [Fact]
    public async Task ARoomMessageIsTiedByTheIdTheRoomAnswers()
    {
        var (workspace, server) = await OpenAsync((current, _) => { current.Posts++; return Task.FromResult(StubHandler.Json("""{"id":"room-msg-1","delivery_id":"ignored"}""")); }, room: true);
        using var disposer = workspace;
        workspace.DraftText = "みんなへ"; await workspace.SendAsync();
        Assert.Equal(2, workspace.Messages.Count); Assert.Equal("受付済み・反映待ち", Label(workspace, 1));
        server.History.Add(Sent("room-msg-1", "みんなへ")); await workspace.RefreshManagementAsync();
        Assert.Equal(["m0", "room-msg-1"], Ids(workspace));
    }
}
