using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;

namespace BellTeam.Tests;

// seat-approval-clients (Kiro's contract seat-approvals.md): Core reads and answers, the member's row gets the badge, the Bot's screen gets the entry with the literal command and the server's two choices.
public sealed class SeatApprovalsTests
{
    private const string Listed = """
        {"approvals":[
          {"id":"sa-bot-trony-1111111111111111-200","botId":"bot-trony","botName":"トロニー","harness":"codex","tool":"Bash","command":"rm -rf ./build && echo \"日本語\"","reason":"Codexが承認を待っています。","since":"2026-11-24T05:00:00.000Z","choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"none"},
          {"id":"sa-bot-trony-2222222222222222-100","botId":"bot-trony","botName":"トロニー","harness":"claude","tool":null,"command":null,"reason":"Claude Codeが承認を待っています。","since":"2026-11-24T04:00:00.000Z","choices":[{"decision":"approve_once","label":"1回だけ許可する"},{"decision":"deny","label":"許可しない"}],"card":"filed"}
        ]}
        """;

    // An in-process BellTeam: the approvals route over the 決裁箱 fixture's roster (bots, rooms, queue, owner).
    private sealed class Server(Func<HttpRequestMessage, string?, Task<HttpResponseMessage?>> seat) : HttpMessageHandler
    {
        private readonly ApprovalsFixture rest = new("connected");
        public List<(string Method, string Path, string? Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (!request.RequestUri!.AbsolutePath.StartsWith("/api/seat-approvals", StringComparison.Ordinal)) return await new HttpMessageInvoker(rest).SendAsync(request, token);
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(token);
            lock (Calls) Calls.Add((request.Method.Method, request.RequestUri.AbsolutePath, body));
            return await seat(request, body) ?? new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }
    private static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task TheListReadsTheContractsShapeOldestFirst_ATuiSeatHasNoCommand_AndABodyWithoutTheRouteHasNoEntries()
    {
        var api = new BellApi(new Uri("http://localhost"), new Server((request, _) => Task.FromResult<HttpResponseMessage?>(Json(Listed))));
        var entries = await api.SeatApprovalsAsync();
        Assert.Equal(["sa-bot-trony-2222222222222222-100", "sa-bot-trony-1111111111111111-200"], entries.Select(item => item.Id));   // oldest first by since
        Assert.Equal(("Bash · Codex", "rm -rf ./build && echo \"日本語\""), (SeatApprovalText.Source(entries[1]), SeatApprovalText.CommandText(entries[1])));   // literal, whole
        Assert.Equal(("Claude Code", "Botの画面を見てください"), (SeatApprovalText.Source(entries[0]), SeatApprovalText.CommandText(entries[0])));
        Assert.Equal(["1回だけ許可する", "許可しない"], entries[1].Buttons.Select(choice => choice.Label)); Assert.Equal("filed", entries[0].Card);
        Assert.Equal(["approve_once", "deny"], new SeatApproval { Id = "x", BotId = "b" }.Buttons.Select(choice => choice.Decision));   // the contract's labels when the server sent none
        foreach (var status in new[] { HttpStatusCode.NotFound, HttpStatusCode.ServiceUnavailable, HttpStatusCode.Forbidden })
            Assert.Empty(await new BellApi(new Uri("http://localhost"), new Server((_, _) => Task.FromResult<HttpResponseMessage?>(Json("{\"error\":\"SEAT_APPROVAL_UNAVAILABLE\"}", status)))).SeatApprovalsAsync());
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "{\"id\":\"sa\",\"status\":\"answered\",\"decision\":\"deny\"}", SeatApprovalResult.Answered)]
    [InlineData(HttpStatusCode.Conflict, "{\"error\":\"SEAT_APPROVAL_CLOSED\"}", SeatApprovalResult.Closed)]
    [InlineData(HttpStatusCode.BadGateway, "{\"error\":\"SCREEN_INPUT_FAILED\"}", SeatApprovalResult.Failed)]
    [InlineData(HttpStatusCode.NotFound, "{\"error\":\"SEAT_APPROVAL_NOT_FOUND\"}", SeatApprovalResult.Failed)]
    [InlineData(HttpStatusCode.BadRequest, "{\"error\":\"SEAT_APPROVAL_INVALID\"}", SeatApprovalResult.Failed)]
    public async Task AnAnswerIsOneDecisionAndEachOutcomeHasItsPlainLine(HttpStatusCode status, string body, SeatApprovalResult expected)
    {
        var server = new Server((_, _) => Task.FromResult<HttpResponseMessage?>(Json(body, status))); var api = new BellApi(new Uri("http://localhost"), server);
        var outcome = await api.AnswerSeatApprovalAsync("sa-bot-1-aaaaaaaaaaaaaaaa-1", "deny");
        Assert.Equal(expected, outcome.Result);
        Assert.Equal(expected switch { SeatApprovalResult.Closed => SeatApprovalText.Closed, SeatApprovalResult.Failed => SeatApprovalText.Failed, _ => null }, outcome.Text);
        var call = Assert.Single(server.Calls); Assert.Equal(("POST", "/api/seat-approvals/sa-bot-1-aaaaaaaaaaaaaaaa-1/answer", "{\"decision\":\"deny\"}"), call);   // never resent by itself
    }

    // ---- the window
    private sealed record Rig(Workspace Workspace, Server Server, SeatApprovalBar Bar, Window Window, List<SeatApproval> Open) : IDisposable { public void Dispose() { Window.Close(); Workspace.Dispose(); } }
    private static Rig Open(Func<HttpRequestMessage, List<SeatApproval>, Task<HttpResponseMessage?>>? answer = null)
    {
        var open = JsonSerializer.Deserialize<SeatApprovalsResponse>(Listed, BellApi.Json)!.Approvals.ToList();
        var server = new Server(async (request, body) =>
        {
            if (request.Method == HttpMethod.Get) return Json(JsonSerializer.Serialize(new { approvals = open }, BellApi.Json));
            return answer is null ? Json("{}") : await answer(request, open);
        });
        var workspace = new Workspace(origin => new BellApi(origin, server)); Await(workspace.ConnectAsync("http://localhost", listen: false));
        Await(workspace.SelectAsync(workspace.Entries.Single(item => item.Target.Id == "bot-trony")));
        var bar = new SeatApprovalBar { Workspace = workspace }; var window = new Window { Content = bar, Width = 700, Height = 700 }; window.Show();
        return new Rig(workspace, server, bar, window, open);
    }
    private static List<string> Texts(DependencyObject root) => LogicalTree.Find<TextBlock>(root).Select(text => text.Text).Concat(LogicalTree.Find<TextBox>(root).Select(box => box.Text)).ToList();
    private static Button Button(Rig rig, string decision) => LogicalTree.Find<Button>(rig.Bar).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "seat-approval-" + decision);

    [Fact]
    public void TheMembersRowGetsTheBadgeAndTheBotsScreenShowsEveryEntryWithTheLiteralCommandAndTheTwoChoices() => RunSta(() =>
    {
        using var rig = Open();
        Assert.Equal(SeatApprovalText.Badge, rig.Workspace.Entries.Single(item => item.Target.Id == "bot-trony").SeatApprovalBadge);
        Assert.All(rig.Workspace.Entries.Where(item => item.Target.Id != "bot-trony"), item => Assert.Null(item.SeatApprovalBadge));
        var cards = LogicalTree.Find<Border>(rig.Bar).Where(border => System.Windows.Automation.AutomationProperties.GetAutomationId(border) == "seat-approval-card").ToList();
        Assert.Equal(2, cards.Count);
        var texts = Texts(rig.Bar);
        Assert.Equal(2, texts.Count(text => text == SeatApprovalText.Heading));
        Assert.Contains("rm -rf ./build && echo \"日本語\"", texts); Assert.Contains("Botの画面を見てください", texts);   // the command whole, and the TUI seat's line
        Assert.Contains("Bash · Codex", texts); Assert.Contains("Codexが承認を待っています。", texts);
        Assert.DoesNotContain(texts, text => text.Contains("sa-bot-trony", StringComparison.Ordinal));                                // no id on screen
        var labels = LogicalTree.Find<Button>(rig.Bar).Select(button => button.Content as string).ToList();
        Assert.Equal(2, labels.Count(label => label == "1回だけ許可する")); Assert.Equal(2, labels.Count(label => label == "許可しない"));
    });

    [Fact]
    public void AnAnswerGoesOnceWithTheChosenDecision_TheEntryGoesAfterTheRead_AndAClosedOneSaysSo() => RunSta(() =>
    {
        var release = new TaskCompletionSource(); var conflict = false;
        using var rig = Open(async (request, open) =>
        {
            await release.Task;
            if (conflict) return Json("{\"error\":\"SEAT_APPROVAL_CLOSED\"}", HttpStatusCode.Conflict);
            open.RemoveAll(item => request.RequestUri!.AbsolutePath.Contains(item.Id)); return Json("{\"status\":\"answered\"}");
        });
        var first = LogicalTree.Find<Button>(rig.Bar).First(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "seat-approval-approve_once");
        first.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, first));
        Until(() => Texts(rig.Bar).Contains(SeatApprovalText.Sending));                                  // sending: both buttons of that entry are off
        Assert.All(LogicalTree.Find<Button>(rig.Bar).Take(2), button => Assert.False(button.IsEnabled));
        first.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, first));                              // a second press while it is sent is nothing
        release.SetResult();
        Until(() => LogicalTree.Find<Border>(rig.Bar).Count(border => System.Windows.Automation.AutomationProperties.GetAutomationId(border) == "seat-approval-card") == 1);
        var posts = rig.Server.Calls.Where(call => call.Method == "POST").ToList(); Assert.Single(posts); Assert.Equal("{\"decision\":\"approve_once\"}", posts[0].Body);
        Assert.Contains("sa-bot-trony-2222222222222222-100", posts[0].Path);                              // the oldest entry (the TUI seat's) was the first card
        conflict = true;
        var deny = Button(rig, "deny"); deny.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, deny));
        Until(() => Texts(rig.Bar).Contains(SeatApprovalText.Closed));                                    // answered elsewhere: the plain line (the entry is read again)
    });

    [Fact]
    public void AFailedAnswerKeepsTheEntryAndSaysSoPlainly() => RunSta(() =>
    {
        using var rig = Open((_, _) => Task.FromResult<HttpResponseMessage?>(Json("{\"error\":\"SCREEN_INPUT_FAILED\"}", HttpStatusCode.BadGateway)));
        var allow = Button(rig, "approve_once"); allow.RaiseEvent(new RoutedEventArgs(ButtonBase.ClickEvent, allow));
        Until(() => Texts(rig.Bar).Contains(SeatApprovalText.Failed));
        Assert.Equal(2, LogicalTree.Find<Border>(rig.Bar).Count(border => System.Windows.Automation.AutomationProperties.GetAutomationId(border) == "seat-approval-card"));
        Assert.True(Button(rig, "approve_once").IsEnabled);                                               // pressable again
    });

    private static void Pump() { var frame = new DispatcherFrame(); _ = Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
    private static void Await(Task task) { Until(() => task.IsCompleted); task.GetAwaiter().GetResult(); }
    private static void Until(Func<bool> done) { var until = DateTime.UtcNow.AddSeconds(10); while (!done()) { if (DateTime.UtcNow > until) throw new TimeoutException(); Pump(); Thread.Sleep(1); } }
    private static void RunSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher)); action(); } catch (Exception error) { failure = error; } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
