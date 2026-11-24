using System.Net;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using BellTeam.App;
using BellTeam.Core;
using BellTeam.PeerChannel;

namespace BellTeam.Tests;

// abx-answer-banner-desktop (contract screen-spec Answer outcomes + Link line): the by-decision 404 is the engine's answer and reads as NotLinked, asked again after 30 s; a failed read says nothing;
// the answer line follows the delivery the source reports now (nothing reported = grey, never 届きました).
public sealed class ApprovalLinksTests
{
    private static ViewDecision Of(string id) => new() { Id = id, Status = "pending" };
    private sealed class Server(Func<string, HttpStatusCode> status) : HttpMessageHandler
    {
        public int Reads;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Reads++; var code = status(request.RequestUri!.Query);
            return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(code == HttpStatusCode.OK ? "{\"project\":\"lattice\",\"plan\":\"p\",\"task\":\"t\",\"state\":\"linked\"}" : "{}", System.Text.Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public async Task A404IsNotLinked_AFailureIsNothing_AndA404IsAskedAgainAfter30Seconds()
    {
        var now = DateTimeOffset.UtcNow; var linked = false;
        var server = new Server(query => query.Contains("K-500") ? HttpStatusCode.ServiceUnavailable : query.Contains("K-404") && !linked ? HttpStatusCode.NotFound : HttpStatusCode.OK);
        var api = new BellApi(new Uri("http://localhost"), server); var links = new ApprovalLinks { Clock = () => now }; var changes = 0;
        await links.ReadAsync(api, [Of("K-404"), Of("K-500")], () => changes++, CancellationToken.None);
        Assert.True(links.Join(Of("K-404")).NotLinked); Assert.False(links.Join(Of("K-500")).NotLinked);   // the failed read is no answer: the line stays 「つなげています」
        Assert.Null(links.Join(Of("K-404")).Link); Assert.True(links.AnyNotLinked); Assert.Equal(1, changes);   // the screen is told once, when the line flips
        var reads = server.Reads;
        now += TimeSpan.FromSeconds(29); await links.ReadAsync(api, [Of("K-404")], () => changes++, CancellationToken.None); Assert.Equal(reads, server.Reads);
        now += TimeSpan.FromSeconds(2); linked = true; await links.ReadAsync(api, [Of("K-404")], () => changes++, CancellationToken.None);   // asked again; the engine has caught up
        Assert.Equal(reads + 1, server.Reads); Assert.False(links.Join(Of("K-404")).NotLinked); Assert.NotNull(links.Join(Of("K-404")).Link); Assert.False(links.AnyNotLinked); Assert.Equal(2, changes);
    }

    // ---- the window: the line follows the delivery the source reports now
    private sealed class Source(ViewDecision first) : IApprovalSource
    {
        public ViewDecision Decision = first;
        public RuntimeState State => new(RuntimeStatus.Live); public IReadOnlyList<ViewDecision> Decisions => [Decision];
        public event Action? Changed;
        public void Raise() => Changed?.Invoke();
        public Task<SendOutcome> AnswerAsync(string decisionId, string? optionId, string? text, long version) => Task.FromResult(new SendOutcome("ok"));
        public Task<SendOutcome> HoldAsync(string decisionId, bool held) => Task.FromResult(new SendOutcome("ok"));
        public void Refresh() { } public void Start() { }
        public Task<byte[]?> AttachmentAsync(string decisionId, string attachmentId) => Task.FromResult<byte[]?>(null);
    }

    [Fact]
    public void TheAnswerLineIsGreyUntilADeliveryIsReported_ThenFollowsIt_AndOnlyUnknownAsksForThePaste() => RunSta(() =>
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        var decision = new ViewDecision { Id = "K-1", Title = "題", Status = "answered", Version = 3, CreatedAt = now, UpdatedAt = now, ResumePhrase = "続けて", Options = [new ApprovalOption { Id = "a", Label = "はい" }], Answer = new ApprovalAnswer { OptionId = "a", AnsweredAt = now }, Origin = new ApprovalOrigin { Client = "claude-code", Tool = "Claude Code" } };
        var source = new Source(decision);
        var server = new ApprovalsFixture("connected"); var workspace = new Workspace(origin => new BellApi(origin, server)); Await(workspace.ConnectAsync("http://localhost", listen: false));
        var hub = new ApprovalsHub(workspace, device: source, quiet: TimeSpan.Zero); var window = new ApprovalsWindow(hub) { Rendering = true }; window.Sync();
        try
        {
            Until(() => window.Page.Settled); window.Page.SetTab(ApprovalsPage.Tab.Done); window.Page.Select("K-1");
            List<string> Lines() => LogicalTree.Find<TextBlock>(window.Content).Select(text => text.Text).ToList();
            bool HasCopy() => LogicalTree.Find<Button>(window.Content).Any(button => System.Windows.Automation.AutomationProperties.GetAutomationId(button) == "ab:copy");
            void Report(string? delivery) { source.Decision = decision with { Delivery = delivery }; source.Raise(); Until(() => true); window.Sync(); }
            foreach (var none in new string?[] { null, "pending" })
            {
                Report(none);
                Assert.Contains(Lines(), line => line.StartsWith("答えました。", StringComparison.Ordinal) && line.EndsWith("への届きを確かめています。", StringComparison.Ordinal));
                Assert.DoesNotContain(Lines(), line => line.Contains("届きました", StringComparison.Ordinal)); Assert.False(HasCopy());
            }
            Report("delivered"); Assert.Contains(Lines(), line => line.EndsWith("に届きました。", StringComparison.Ordinal) && line.StartsWith("答えました。", StringComparison.Ordinal)); Assert.False(HasCopy());
            Report("fetched"); Assert.Contains(Lines(), line => line.EndsWith("に届きました。", StringComparison.Ordinal)); Assert.False(HasCopy());
            Report("waiting"); Assert.Contains(Lines(), line => line.Contains("会話に戻ると受け取ります。", StringComparison.Ordinal)); Assert.False(HasCopy());
            Report("unknown"); Assert.Contains(Lines(), line => line.Contains("届いたかを確かめられませんでした。", StringComparison.Ordinal)); Assert.True(HasCopy());
            Report("delivered"); Assert.False(HasCopy());   // a later delivered replaces the amber line and the paste request
        }
        finally { window.Page.Stop(); window.Close(); hub.Dispose(); workspace.Dispose(); }
    });

    private static void Pump() { var frame = new DispatcherFrame(); Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() => frame.Continue = false)); Dispatcher.PushFrame(frame); }
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
