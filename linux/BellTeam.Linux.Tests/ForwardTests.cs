using System.Net;
using System.Text;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BellTeam.Core;

namespace BellTeam.Linux;

public sealed class ForwardTests
{
    // An original from the Bot, a forward of it with a comment, and a share from LINE.
    private const string Messages = """
    {"items":[
      {"id":"o1","at":"2026-11-16T00:00:00Z","message":"午前は打ち合わせ。","direction":"incoming","kind":"message","sender":{"id":"b1","name":"ベル"}},
      {"id":"f1","at":"2026-11-16T00:01:00Z","message":"これお願い\n\n午前は打ち合わせ。","direction":"outgoing","kind":"message","origin":{"kind":"forward","from":{"id":"b1","name":"ベル"},"at":"2026-11-16T00:00:00Z","content_start":7}},
      {"id":"s1","at":"2026-11-16T00:02:00Z","message":"資料はここ\nhttps://example.com/a","direction":"outgoing","kind":"message","origin":{"kind":"share","app":"LINE","urls":["https://example.com/a"],"content_start":0}}
    ],"has_more":false}
    """;

    private sealed class Server(List<string> posted) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.PathAndQuery;
            if (request.Method == HttpMethod.Post && path == "/api/bots/b1/messages")
            {
                posted.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"delivery_id":"d1"}""", Encoding.UTF8, "application/json") };
            }
            var body = path switch
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
            return body is null ? new HttpResponseMessage(HttpStatusCode.NotFound) : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private static async Task<(LinuxWorkspace Model, MainWindow Window)> OpenAsync(List<string> posted)
    {
        var model = new LinuxWorkspace(origin => new BellApi(origin, new Server(posted)));
        var window = new MainWindow(model, persistPlacement: false) { AutoRetry = false }; window.Show();
        await model.ConnectAsync("http://localhost:1/", listen: false);
        await model.SelectAsync(model.Entries.Single());
        for (var round = 0; round < 10 && model.Opening; round++) { Dispatcher.UIThread.RunJobs(); await Task.Delay(20); }
        return (model, window);
    }

    [Fact]
    public void ADroppedLinkIsOneUrlAndOtherTextKeepsItsLinksInside()
    {
        Assert.Equal((null, null, "https://example.com/a"), ShareDrop.Parse("https://example.com/a\r\n").With());
        Assert.Equal(["https://example.com/a", "https://example.com/b"], ShareDrop.Parse("https://example.com/a\nhttps://example.com/b")!.Urls);
        var mixed = ShareDrop.Parse("読んでおいて\nhttps://example.com/a")!;
        Assert.Equal("読んでおいて\nhttps://example.com/a", mixed.Text); Assert.Empty(mixed.Urls);
        Assert.Null(ShareDrop.Parse(" \n "));
        Assert.Equal("ftp://example.com/x", ShareDrop.Parse("ftp://example.com/x")!.Text);   // only http(s) are links
    }

    [Fact]
    public Task ForwardedAndSharedRowsShowTheirMarkAndTheContentAsAQuote() => Ui.Run(async () =>
    {
        var (model, window) = await OpenAsync([]);
        using (model)
        {
            var texts = window.GetVisualDescendants().OfType<TextBlock>().Where(text => text.IsEffectivelyVisible).Select(text => text.Text ?? "").ToArray();
            Assert.Contains(texts, text => text.StartsWith("転送 · ベル", StringComparison.Ordinal));
            Assert.Contains("共有 · LINE", texts);
            var card = window.GetVisualDescendants().OfType<MessageCard>().First(item => item.MessageId == "f1");
            var bodies = card.GetVisualDescendants().OfType<MarkdownView>().Select(view => view.Source).ToArray();
            Assert.Equal(["これお願い", "午前は打ち合わせ。"], bodies);   // the comment in the bubble, the content as the quote (content_start 7)
        }
        window.Close();
    });

    [Fact]
    public Task TheForwardSheetSendsOnlyTheIdentifiersAndTheComment() => Ui.Run(async () =>
    {
        var posted = new List<string>();
        var (model, window) = await OpenAsync(posted);
        using (model)
        {
            var sheet = window.ShowForwardSheet(model.Messages.Select(item => item.Message).First(item => item.Id == "o1"));
            Assert.False(sheet.CanSave);                 // no destination yet
            sheet.SetForRender(0, "これお願い");
            Assert.True(sheet.CanSave);
            await sheet.SaveAsync();
            var body = System.Text.Json.JsonDocument.Parse(Assert.Single(posted)).RootElement;
            Assert.Equal("これお願い", body.GetProperty("message").GetString());
            Assert.Equal("o1", body.GetProperty("forward").GetProperty("message_id").GetString());
            Assert.Equal("b1", body.GetProperty("forward").GetProperty("source").GetProperty("id").GetString());
            Assert.False(body.TryGetProperty("reply_to", out _));
        }
        window.Close();
    });

    [Fact]
    public Task TheShareSheetSendsTheDroppedContentToTheOpenConversation() => Ui.Run(async () =>
    {
        var posted = new List<string>();
        var (model, window) = await OpenAsync(posted);
        using (model)
        {
            var sheet = window.ShowShareSheet(new ShareContent(null, "この記事を見て", []), [], 0);
            Assert.True(sheet.CanSave);                  // the open conversation is the default destination
            await sheet.SaveAsync();
            var body = System.Text.Json.JsonDocument.Parse(Assert.Single(posted)).RootElement;
            Assert.Equal("この記事を見て", body.GetProperty("share").GetProperty("text").GetString());
        }
        window.Close();
    });
}

internal static class ShareContentTestExtensions
{
    // ShareContent compares its Urls array by reference; compare by value for the assertion.
    public static (string?, string?, string) With(this ShareContent? content) => (content?.App, content?.Text, string.Join("|", content?.Urls ?? []));
}
