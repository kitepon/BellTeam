using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class ReplyTests
{
    // One member with an original, a reply to it (whole message), a reply to a part, and a reply whose original is gone.
    private const string Messages = """
    {"items":[
      {"id":"o1","at":"2026-11-16T00:00:00Z","message":"午前は打ち合わせ、午後はBellTeamの確認です。","direction":"incoming","kind":"message","sender":{"id":"b1","name":"ベル"}},
      {"id":"r1","at":"2026-11-16T00:01:00Z","message":"その件、了解です。","direction":"outgoing","kind":"message","reply_to":{"id":"o1","available":true,"sender":{"id":"b1","name":"ベル"},"at":"2026-11-16T00:00:00Z","text":"午前は打ち合わせ、午後はBellTeamの確認です。"}},
      {"id":"r2","at":"2026-11-16T00:02:00Z","message":"午後の件です。","direction":"outgoing","kind":"message","reply_to":{"id":"o1","available":true,"part":true,"sender":{"id":"b1","name":"ベル"},"at":"2026-11-16T00:00:00Z","text":"BellTeamの確認です。"}},
      {"id":"r3","at":"2026-11-16T00:03:00Z","message":"消えた発言への返信です。","direction":"outgoing","kind":"message","reply_to":{"id":"gone","available":false}}
    ],"has_more":false}
    """;

    private sealed class Server : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.RequestUri!.PathAndQuery switch
            {
                "/api/session" => """{"authenticated":true,"authMode":"local"}""",
                "/api/setup" => """{"phase":"ready","harnesses":[],"complete":true}""",
                "/api/bots?avatar=omit" => """{"bots":[{"id":"b1","name":"ベル","displayName":"ベル","online":true}]}""",
                "/api/rooms?avatar=omit" => """{"rooms":[]}""",
                "/api/queue" => """{"items":[]}""",
                "/api/owner?avatar=omit" => """{"owner":{"name":"利用者"}}""",
                "/api/bots/b1/messages?limit=10" or "/api/bots/b1/messages?limit=1000" => Messages,
                _ => null
            };
            return Task.FromResult(body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static async Task<(LinuxWorkspace Model, MainWindow Window)> OpenAsync()
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server()));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        for (var round = 0; round < 10 && model.Opening; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        return (model, window);
    }
    private static IEnumerable<string> Texts(Window window) => window.GetVisualDescendants().OfType<TextBlock>().Where(text => text.IsEffectivelyVisible).Select(text => text.Text ?? "");

    [Fact]
    public Task TheQuoteIsDrawnFromTheSavedSnapshotAndAGoneOriginalIsNotTappable() => Ui.Run(async () =>
    {
        var (model, window) = await OpenAsync();
        using (model)
        {
            var texts = Texts(window).ToArray();
            Assert.Contains("午前は打ち合わせ、午後はBellTeamの確認です。", texts);   // the quote of r1 (and the original's own text)
            Assert.Contains("BellTeamの確認です。", texts);                             // the part quote of r2
            Assert.Contains(Timeline.UnavailableQuote, texts);                          // r3: the fixed line only
            var cards = window.GetVisualDescendants().OfType<MessageCard>().ToDictionary(card => card.MessageId!);
            Assert.False(cards["r3"].GetVisualDescendants().OfType<Button>().First(button => Avalonia.Automation.AutomationProperties.GetName(button) == Timeline.UnavailableQuote).IsHitTestVisible);
            Assert.Contains(cards["r1"].GetVisualDescendants().OfType<Button>(), button => button.IsHitTestVisible && (Avalonia.Automation.AutomationProperties.GetName(button) ?? "").StartsWith("返信先 ベル", StringComparison.Ordinal));
        }
        window.Close();
    });

    [Fact]
    public Task PickingAMessageShowsTheQuoteBarAndTheCancelButtonDropsIt() => Ui.Run(async () =>
    {
        var (model, window) = await OpenAsync();
        using (model)
        {
            Assert.DoesNotContain("ベルへの返信", Texts(window));
            var cards = window.GetVisualDescendants().OfType<MessageCard>().ToDictionary(card => card.MessageId!);
            cards["o1"].GetVisualDescendants().OfType<Button>().First(button => Avalonia.Automation.AutomationProperties.GetName(button) == "このメッセージに返信").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Dispatcher.UIThread.RunJobs();
            Assert.Equal("o1", model.Quote!.Id);
            Assert.Contains("ベルへの返信", Texts(window));
            window.GetVisualDescendants().OfType<Button>().First(button => Avalonia.Automation.AutomationProperties.GetName(button) == "返信をやめる").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Dispatcher.UIThread.RunJobs();
            Assert.Null(model.Quote); Assert.DoesNotContain("ベルへの返信", Texts(window));
            // Your own pending echo and a Bot-to-Bot row are not quotable (the 返信 button is hidden for them): only conversation rows are.
            Assert.False(Timeline.IsQuotable(new TimelineMessage { Id = PendingSend.NewId(), At = DateTimeOffset.Now }));
        }
        window.Close();
    });

    [Fact]
    public Task AJumpToAPartHighlightsItInTheShownTextAndClearsItAgain() => Ui.Run(async () =>
    {
        var (model, window) = await OpenAsync();
        using (model)
        {
            string? scrolled = null; model.ScrollToMessage += (id, _) => scrolled = id;
            await model.JumpToAsync(model.Messages.Select(item => item.Message.ReplyTo!).First(quote => quote is { Part: true }));
            Assert.Equal("o1", scrolled);
            var card = window.GetVisualDescendants().OfType<MessageCard>().First(item => item.MessageId == "o1");
            card.Flash(new ReplyReference("o1", true, "ベル", "BellTeamの確認です。", Part: true));
            var body = card.GetVisualDescendants().OfType<MarkdownView>().First();
            Assert.Equal("BellTeamの確認です。", body.SelectedText);
            body.ClearHighlight();
            Assert.Equal("", body.SelectedText);
            Assert.False(body.Highlight("この文は無い"));   // not found: no highlight, the jump itself still worked
        }
        window.Close();
    });

    [Fact]
    public Task TheRightClickMenuQuotesOnlyTheSelectedPart() => Ui.Run(async () =>
    {
        var (model, window) = await OpenAsync();
        using (model)
        {
            var card = window.GetVisualDescendants().OfType<MessageCard>().First(item => item.MessageId == "o1");
            var body = card.GetVisualDescendants().OfType<MarkdownView>().First();
            Assert.True(body.Highlight("BellTeam"));   // stands in for the Owner's drag selection
            var menu = Assert.IsType<MenuFlyout>(body.GetVisualDescendants().OfType<SelectableTextBlock>().First().ContextFlyout);
            menu.Items.OfType<MenuItem>().First(item => (string?)item.Header == "引用して返信").RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(MenuItem.ClickEvent));
            Assert.Equal(new ReplyReference("o1", true, "ベル", "BellTeam", Part: true), model.Quote);
        }
        window.Close();
    });
}
